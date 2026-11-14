use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::Deserialize;
use thiserror::Error;

use crate::types::{ReviewDefect, ReviewVerdict, ReviewVerdictStatus};

pub const REVIEWER_PROTOCOL_ERROR_CODE: &str = "REVIEWER_PROTOCOL_ERROR";
pub const REVIEW_INCOMPLETE_CODE: &str = "REVIEW_INCOMPLETE";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReviewerError {
    #[error("Reviewer returned invalid verdict JSON.")]
    InvalidVerdictJson,
    #[error("Reviewer verdict JSON does not match the required PASS/REJECT/INCOMPLETE schema.")]
    VerdictSchema,
    #[error("{0}")]
    Protocol(String),
    #[error("Reviewer inspection was cancelled.")]
    Cancelled,
    #[error("{0}")]
    Execution(String),
    #[error("{0}")]
    Incomplete(String),
}

impl ReviewerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidVerdictJson | Self::VerdictSchema | Self::Protocol(_) => {
                REVIEWER_PROTOCOL_ERROR_CODE
            }
            Self::Cancelled => "REVIEW_CANCELLED",
            Self::Execution(_) => "REVIEWER_EXECUTION_ERROR",
            Self::Incomplete(_) => REVIEW_INCOMPLETE_CODE,
        }
    }
}

#[derive(Deserialize)]
struct RawVerdict {
    status: ReviewVerdictStatus,
    summary: String,
    #[serde(default)]
    defects: Vec<ReviewDefect>,
}

pub fn parse_review_verdict(
    raw_text: &str,
    reviewer_profile_id: Option<&str>,
) -> Result<ReviewVerdict, ReviewerError> {
    let mut cleaned = raw_text.trim();
    if let Some(captures) = fenced_json_regex().captures(cleaned) {
        if let Some(inner) = captures
            .get(1)
            .map(|value| value.as_str())
            .filter(|value| !value.is_empty())
        {
            cleaned = inner.trim();
        }
    }

    let value: serde_json::Value =
        serde_json::from_str(cleaned).map_err(|_| ReviewerError::InvalidVerdictJson)?;
    let parsed: RawVerdict =
        serde_json::from_value(value).map_err(|_| ReviewerError::VerdictSchema)?;
    Ok(ReviewVerdict {
        status: parsed.status,
        summary: parsed.summary,
        defects: parsed.defects,
        reviewer_profile_id: reviewer_profile_id.map(str::to_string),
        reviewed_at: now_ms(),
    })
}

fn fenced_json_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?is)```(?:json)?\s*(.*?)\s*```").expect("fenced verdict regex")
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
