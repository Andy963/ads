use serde::{Deserialize, Serialize};
use serde_json::Number;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewIssue {
    pub id: Option<i64>,
    pub title: String,
    pub description: Option<String>,
    pub acceptance_criteria: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewDiffRange {
    pub base_ref: String,
    pub head_ref: String,
    pub base_commit: Option<String>,
    pub head_commit: Option<String>,
    pub range: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewAdr {
    pub id: String,
    pub title: String,
    pub decision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewRelatedContext {
    pub file: String,
    pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewContextOmission {
    pub file: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewTestReport {
    pub command: String,
    pub exit_code: i64,
    pub summary: String,
    pub output: Option<String>,
    pub sandboxed: bool,
    pub started: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewVerificationReport {
    pub commands: Vec<ReviewTestReport>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewPayload {
    pub issue: ReviewIssue,
    pub rework_declaration: Option<serde_json::Value>,
    pub diff_range: Option<ReviewDiffRange>,
    pub adrs: Option<Vec<ReviewAdr>>,
    pub diff: String,
    pub diff_stat: Option<String>,
    pub diff_capture_error: Option<String>,
    pub related_contexts: Option<Vec<ReviewRelatedContext>>,
    pub related_context_omissions: Option<Vec<ReviewContextOmission>>,
    pub verification_report: Option<ReviewVerificationReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewVerdictStatus {
    #[serde(rename = "PASS")]
    Pass,
    #[serde(rename = "REJECT")]
    Reject,
    #[serde(rename = "INCOMPLETE")]
    Incomplete,
}

impl ReviewVerdictStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Reject => "REJECT",
            Self::Incomplete => "INCOMPLETE",
        }
    }
}

impl std::fmt::Display for ReviewVerdictStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewSeverity {
    Blocker,
    #[default]
    Warning,
}

impl ReviewSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blocker => "blocker",
            Self::Warning => "warning",
        }
    }
}

impl std::fmt::Display for ReviewSeverity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDefect {
    pub file: String,
    #[serde(default)]
    pub line: Option<Number>,
    #[serde(default)]
    pub severity: ReviewSeverity,
    pub description: String,
}

impl ReviewDefect {
    pub fn new(
        file: impl Into<String>,
        line: Option<i64>,
        severity: ReviewSeverity,
        description: impl Into<String>,
    ) -> Self {
        Self {
            file: file.into(),
            line: line.map(Number::from),
            severity,
            description: description.into(),
        }
    }

    pub fn location(&self) -> String {
        match self.line.as_ref() {
            Some(line) => format!("{}:{}", self.file, line),
            None => self.file.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewVerdict {
    pub status: ReviewVerdictStatus,
    pub summary: String,
    pub defects: Vec<ReviewDefect>,
    pub reviewer_profile_id: Option<String>,
    pub reviewed_at: i64,
}

impl Default for ReviewVerdict {
    fn default() -> Self {
        Self {
            status: ReviewVerdictStatus::Pass,
            summary: String::new(),
            defects: Vec::new(),
            reviewer_profile_id: None,
            reviewed_at: 0,
        }
    }
}
