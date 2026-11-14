use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEventRow {
    pub seq: i64,
    pub namespace: String,
    pub lane_key: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    pub revision: i64,
    pub payload: Value,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEventReadResult {
    pub events: Vec<SyncEventRow>,
    pub latest_seq: i64,
    pub min_available_seq: i64,
    pub has_more: bool,
    pub truncated: bool,
}
