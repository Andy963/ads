use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const WS_PROTOCOL_VERSION: &str = "ads-v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WsEnvelope {
    #[serde(rename = "type")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_session_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub role: String,
    pub text: String,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}
