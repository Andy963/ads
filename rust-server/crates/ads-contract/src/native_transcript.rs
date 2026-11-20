use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeTranscriptTurnStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl NativeTranscriptTurnStatus {
    pub fn from_db(value: &str) -> Self {
        match value {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            _ => Self::Running,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTranscriptTurnRecord {
    pub turn_id: String,
    pub status: NativeTranscriptTurnStatus,
    pub messages: Value,
    pub entries: Value,
    pub usage: Option<Value>,
    pub provider: Option<Value>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
