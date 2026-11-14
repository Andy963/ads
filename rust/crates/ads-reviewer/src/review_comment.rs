use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;

use crate::types::ReviewDefect;

pub const REVIEW_COMMENT_MARKER: &str = "<!-- ads:review-verdict -->";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueVerdictStatus {
    Pass,
    Reject,
    Incomplete,
    Error,
}

impl IssueVerdictStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Reject => "REJECT",
            Self::Incomplete => "INCOMPLETE",
            Self::Error => "ERROR",
        }
    }

    fn next_step(self) -> &'static str {
        match self {
            Self::Pass => {
                "Next step: request delivery authorization; a PASS is not merge approval."
            }
            Self::Reject => {
                "Next step: fix the findings, push the new commit, then run review_action again."
            }
            Self::Incomplete => {
                "Next step: restore the reported precondition, then run review_action again. No code was rejected."
            }
            Self::Error => {
                "Next step: inspect the Actions lane for the operational error, fix the environment, then run review_action again."
            }
        }
    }
}

impl std::fmt::Display for IssueVerdictStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct IssueVerdictCommentInput {
    pub job_id: String,
    pub pr_number: Option<u64>,
    pub head_sha: Option<String>,
    pub base_sha: Option<String>,
    pub status: IssueVerdictStatus,
    pub summary: String,
    pub defects: Option<Vec<ReviewDefect>>,
    pub published_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedIssueVerdictComment {
    pub status: IssueVerdictStatus,
    pub job_id: String,
    pub pr_number: Option<u64>,
    pub head_sha: Option<String>,
    pub base_sha: Option<String>,
    pub summary: String,
}

pub fn build_issue_verdict_comment(input: &IssueVerdictCommentInput) -> String {
    let published_at = input.published_at.unwrap_or_else(now_ms);
    let published_at = DateTime::<Utc>::from_timestamp_millis(published_at)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp_millis(0).expect("epoch"))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut lines = vec![
        REVIEW_COMMENT_MARKER.to_string(),
        format!("## ADS Reviewer verdict: {}", input.status),
        String::new(),
        format!(
            "- PR: {}",
            input
                .pr_number
                .map(|number| format!("#{number}"))
                .unwrap_or_else(|| "_none_".to_string())
        ),
        format!("- Head: {}", short_sha(input.head_sha.as_deref())),
        format!("- Base: {}", short_sha(input.base_sha.as_deref())),
        format!("- Job: `{}`", input.job_id),
        format!("- Time: {published_at}"),
        String::new(),
        format!(
            "**Summary**: {}",
            match input.summary.trim() {
                "" => "_No summary reported._",
                summary => summary,
            }
        ),
    ];
    let defects = input.defects.as_deref().unwrap_or_default();
    if input.status == IssueVerdictStatus::Reject && !defects.is_empty() {
        lines.push(String::new());
        lines.push("**Findings**:".to_string());
        lines.extend(defects.iter().map(|defect| {
            format!(
                "- `{}` ({}): {}",
                defect.location(),
                defect.severity,
                defect.description
            )
        }));
    }
    lines.push(String::new());
    lines.push(input.status.next_step().to_string());
    lines.join("\n")
}

pub fn parse_issue_verdict_comment(body: &str) -> Option<ParsedIssueVerdictComment> {
    if !body.contains(REVIEW_COMMENT_MARKER) {
        return None;
    }
    let status = status_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .and_then(|capture| match capture.as_str() {
            "PASS" => Some(IssueVerdictStatus::Pass),
            "REJECT" => Some(IssueVerdictStatus::Reject),
            "INCOMPLETE" => Some(IssueVerdictStatus::Incomplete),
            "ERROR" => Some(IssueVerdictStatus::Error),
            _ => None,
        })?;
    let job_id = job_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_string())?;
    let pr_number = pr_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .and_then(|capture| capture.as_str().parse::<u64>().ok());
    let head_sha = backtick_field(head_regex(), body);
    let base_sha = backtick_field(base_regex(), body);
    let summary = summary_regex()
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().trim().to_string())
        .unwrap_or_default();
    Some(ParsedIssueVerdictComment {
        status,
        job_id,
        pr_number,
        head_sha,
        base_sha,
        summary,
    })
}

fn short_sha(value: Option<&str>) -> String {
    let sha = value.unwrap_or_default().trim();
    if sha.is_empty() {
        return "_unknown_".to_string();
    }
    format!("`{}`", sha.chars().take(12).collect::<String>())
}

fn backtick_field(regex: &Regex, body: &str) -> Option<String> {
    regex
        .captures(body)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_string())
}

fn status_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?m)^## ADS Reviewer verdict: (PASS|REJECT|INCOMPLETE|ERROR)$")
            .expect("verdict status regex")
    })
}

fn job_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^- Job: `([^`]+)`$").expect("verdict job regex"))
}

fn pr_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^- PR: #(\d+)$").expect("verdict PR regex"))
}

fn head_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^- Head: `([^`]+)`$").expect("verdict head regex"))
}

fn base_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^- Base: `([^`]+)`$").expect("verdict base regex"))
}

fn summary_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?m)^\*\*Summary\*\*: (.*)$").expect("verdict summary regex"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
