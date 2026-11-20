use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub task_id: Option<String>,
    pub kind: AttachmentKind,
    pub filename: Option<String>,
    pub content_type: String,
    pub size_bytes: i64,
    pub width: i64,
    pub height: i64,
    pub sha256: String,
    pub storage_key: String,
    pub created_at: i64,
}
