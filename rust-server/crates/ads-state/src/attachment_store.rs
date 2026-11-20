use ads_contract::attachments::{Attachment, AttachmentKind};
use rusqlite::{Connection, OptionalExtension, Row, params};
use uuid::Uuid;

use crate::{StateError, StateResult};

#[derive(Debug, Clone)]
pub struct CreateImageAttachment {
    pub task_id: Option<String>,
    pub filename: Option<String>,
    pub content_type: String,
    pub size_bytes: i64,
    pub width: i64,
    pub height: i64,
    pub sha256: String,
    pub storage_key: String,
    pub now: Option<i64>,
}

pub struct AttachmentStore<'a> {
    connection: &'a Connection,
    workspace_id: String,
}

impl<'a> AttachmentStore<'a> {
    pub fn new(connection: &'a Connection, workspace_id: &str) -> Self {
        Self {
            connection,
            workspace_id: workspace_id.trim().to_string(),
        }
    }

    pub fn get_attachment(&self, id: &str) -> StateResult<Option<Attachment>> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT * FROM attachments WHERE workspace_id = ?1 AND id = ?2 LIMIT 1",
                params![self.workspace_id, id],
                AttachmentRow::from_row,
            )
            .optional()?
            .map(AttachmentRow::parse)
            .transpose()
    }

    pub fn get_attachment_by_sha256(&self, sha256: &str) -> StateResult<Option<Attachment>> {
        let Some(sha256) = normalize_hex_sha256(sha256) else {
            return Ok(None);
        };
        self.connection
            .query_row(
                "SELECT * FROM attachments WHERE workspace_id = ?1 AND sha256 = ?2 LIMIT 1",
                params![self.workspace_id, sha256],
                AttachmentRow::from_row,
            )
            .optional()?
            .map(AttachmentRow::parse)
            .transpose()
    }

    pub fn create_or_get_image_attachment(
        &self,
        mut input: CreateImageAttachment,
    ) -> StateResult<Attachment> {
        let sha256 = normalize_hex_sha256(&input.sha256)
            .ok_or_else(|| StateError::InvalidInput("Invalid sha256".to_string()))?;
        let now = input
            .now
            .unwrap_or_else(ads_contract::time::now_unix_millis);
        let filename = normalize_filename(input.filename.take().as_deref());

        let transaction = self.connection.unchecked_transaction()?;
        if let Some(existing) = self.get_attachment_by_sha256(&sha256)? {
            if let Some(filename) = filename.filter(|_| {
                existing
                    .filename
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
            }) {
                let _ = transaction.execute(
                    "UPDATE attachments
                     SET filename = ?1
                     WHERE workspace_id = ?2 AND id = ?3
                       AND (filename IS NULL OR TRIM(filename) = '')",
                    params![filename, self.workspace_id, existing.id],
                );
                transaction.commit()?;
                return self.get_attachment(&existing.id)?.ok_or_else(|| {
                    StateError::InvalidInput("Failed to read attachment".to_string())
                });
            }
            return Ok(existing);
        }

        let id = Uuid::new_v4().to_string();
        let inserted = transaction.execute(
            "INSERT INTO attachments (
               workspace_id, id, task_id, kind, filename, content_type,
               size_bytes, width, height, sha256, storage_key, created_at
             ) VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                self.workspace_id,
                id,
                input.task_id,
                filename,
                input.content_type,
                input.size_bytes,
                input.width,
                input.height,
                sha256,
                input.storage_key,
                now
            ],
        );
        if let Err(error) = inserted {
            drop(transaction);
            if is_unique_violation(&error) {
                if let Some(raced) = self.get_attachment_by_sha256(&sha256)? {
                    return Ok(raced);
                }
            }
            return Err(StateError::Sqlite(error));
        }
        transaction.commit()?;
        self.get_attachment(&id)?.ok_or_else(|| {
            StateError::InvalidInput("Failed to read created attachment".to_string())
        })
    }

    pub fn list_attachments_for_task(&self, task_id: &str) -> StateResult<Vec<Attachment>> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.connection.prepare(
            "SELECT * FROM attachments
             WHERE workspace_id = ?1 AND task_id = ?2
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement
            .query_map(params![self.workspace_id, task_id], AttachmentRow::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(AttachmentRow::parse).collect()
    }

    pub fn assign_attachments_to_task(
        &self,
        task_id: &str,
        attachment_ids: &[String],
    ) -> StateResult<()> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err(StateError::InvalidInput("Task id is required".to_string()));
        }
        let ids = attachment_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }

        let transaction = self.connection.unchecked_transaction()?;
        for id in ids {
            let existing = self
                .get_attachment(id)?
                .ok_or_else(|| StateError::InvalidInput(format!("Attachment not found: {id}")))?;
            let updated = transaction.execute(
                "UPDATE attachments
                 SET task_id = ?1
                 WHERE workspace_id = ?2 AND id = ?3
                   AND (task_id IS NULL OR task_id = ?1)",
                params![task_id, self.workspace_id, existing.id],
            )?;
            if updated != 1 {
                let current = self.get_attachment(&existing.id)?;
                let owner = current.and_then(|attachment| attachment.task_id);
                if owner.as_deref().is_some_and(|owner| owner != task_id) {
                    return Err(StateError::InvalidInput(format!(
                        "Attachment already assigned to another task: {}",
                        existing.id
                    )));
                }
                return Err(StateError::InvalidInput(format!(
                    "Failed to assign attachment: {}",
                    existing.id
                )));
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

struct AttachmentRow {
    id: String,
    task_id: Option<String>,
    kind: String,
    filename: Option<String>,
    content_type: String,
    size_bytes: i64,
    width: i64,
    height: i64,
    sha256: String,
    storage_key: String,
    created_at: i64,
}

impl AttachmentRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            kind: row.get("kind")?,
            filename: row.get("filename")?,
            content_type: row.get("content_type")?,
            size_bytes: row.get("size_bytes")?,
            width: row.get("width")?,
            height: row.get("height")?,
            sha256: row.get("sha256")?,
            storage_key: row.get("storage_key")?,
            created_at: row.get("created_at")?,
        })
    }

    fn parse(self) -> StateResult<Attachment> {
        let _ = self.kind;
        Ok(Attachment {
            id: self.id.trim().to_string(),
            task_id: normalize_optional_string(self.task_id),
            kind: AttachmentKind::Image,
            filename: normalize_optional_string(self.filename),
            content_type: {
                let value = self.content_type.trim();
                if value.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    value.to_string()
                }
            },
            size_bytes: self.size_bytes,
            width: self.width,
            height: self.height,
            sha256: self.sha256.trim().to_ascii_lowercase(),
            storage_key: self.storage_key.trim().to_string(),
            created_at: self.created_at,
        })
    }
}

fn normalize_hex_sha256(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(value)
    } else {
        None
    }
}

fn normalize_filename(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let basename = raw.rsplit(['\\', '/']).next().unwrap_or(raw);
    let cleaned = basename
        .chars()
        .filter(|character| {
            !character.is_ascii_control()
                || !matches!(*character, '\u{0000}'..='\u{001f}' | '\u{007f}')
        })
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    let utf16 = cleaned.encode_utf16().take(200).collect::<Vec<_>>();
    let truncated = String::from_utf16_lossy(&utf16);
    if truncated.is_empty() {
        None
    } else {
        Some(truncated)
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn is_unique_violation(error: &rusqlite::Error) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("unique constraint")
}
