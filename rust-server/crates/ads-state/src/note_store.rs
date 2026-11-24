use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{StateError, StateResult};

const MAX_NOTE_CONTENT_LEN: usize = 20_000;

const PROJECT_NOTES_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS project_notes (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_notes_user_project
  ON project_notes(auth_user_id, project_id, is_archived);
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNote {
    pub id: String,
    pub auth_user_id: String,
    pub project_id: String,
    pub content: String,
    pub is_archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn ensure_project_notes_table(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(PROJECT_NOTES_SCHEMA_SQL)?;
    Ok(())
}

pub fn list_project_notes(
    connection: &Connection,
    auth_user_id: &str,
    project_id: Option<&str>,
    include_archived: bool,
) -> StateResult<Vec<ProjectNote>> {
    let auth_user_id = auth_user_id.trim();
    if auth_user_id.is_empty() {
        return Ok(Vec::new());
    }
    let project_id = project_id.map(str::trim).filter(|value| !value.is_empty());
    let rows = match (project_id, include_archived) {
        (Some(project_id), true) => {
            let mut statement = connection.prepare(
                "SELECT id, auth_user_id, project_id, content, is_archived, created_at, updated_at
                 FROM project_notes
                 WHERE auth_user_id = ?1 AND project_id = ?2
                 ORDER BY is_archived ASC, updated_at DESC, created_at DESC",
            )?;
            statement
                .query_map(params![auth_user_id, project_id], map_project_note)?
                .collect::<Result<Vec<_>, _>>()?
        }
        (Some(project_id), false) => {
            let mut statement = connection.prepare(
                "SELECT id, auth_user_id, project_id, content, is_archived, created_at, updated_at
                 FROM project_notes
                 WHERE auth_user_id = ?1 AND project_id = ?2 AND is_archived = 0
                 ORDER BY updated_at DESC, created_at DESC",
            )?;
            statement
                .query_map(params![auth_user_id, project_id], map_project_note)?
                .collect::<Result<Vec<_>, _>>()?
        }
        (None, true) => {
            let mut statement = connection.prepare(
                "SELECT id, auth_user_id, project_id, content, is_archived, created_at, updated_at
                 FROM project_notes
                 WHERE auth_user_id = ?1
                 ORDER BY is_archived ASC, updated_at DESC, created_at DESC",
            )?;
            statement
                .query_map(params![auth_user_id], map_project_note)?
                .collect::<Result<Vec<_>, _>>()?
        }
        (None, false) => {
            let mut statement = connection.prepare(
                "SELECT id, auth_user_id, project_id, content, is_archived, created_at, updated_at
                 FROM project_notes
                 WHERE auth_user_id = ?1 AND is_archived = 0
                 ORDER BY updated_at DESC, created_at DESC",
            )?;
            statement
                .query_map(params![auth_user_id], map_project_note)?
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(rows)
}

pub fn get_project_note(
    connection: &Connection,
    auth_user_id: &str,
    id: &str,
) -> StateResult<Option<ProjectNote>> {
    let auth_user_id = auth_user_id.trim();
    let id = id.trim();
    if auth_user_id.is_empty() || id.is_empty() {
        return Ok(None);
    }
    let note = connection
        .query_row(
            "SELECT id, auth_user_id, project_id, content, is_archived, created_at, updated_at
             FROM project_notes
             WHERE id = ?1 AND auth_user_id = ?2",
            params![id, auth_user_id],
            map_project_note,
        )
        .optional()?;
    Ok(note)
}

pub fn create_project_note(
    connection: &Connection,
    auth_user_id: &str,
    project_id: &str,
    content: &str,
    now: i64,
) -> StateResult<ProjectNote> {
    let auth_user_id = auth_user_id.trim();
    let project_id = project_id.trim();
    let content = normalize_note_content(content)?;
    if auth_user_id.is_empty() {
        return Err(StateError::InvalidInput(
            "auth_user_id is required".to_string(),
        ));
    }
    if project_id.is_empty() {
        return Err(StateError::InvalidInput(
            "projectId is required".to_string(),
        ));
    }
    let id = format!("note-{}", Uuid::new_v4());
    connection.execute(
        "INSERT INTO project_notes
           (id, auth_user_id, project_id, content, is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![id, auth_user_id, project_id, content, now],
    )?;
    get_project_note(connection, auth_user_id, &id)?
        .ok_or_else(|| StateError::InvalidInput("failed to load created note".to_string()))
}

pub fn update_project_note(
    connection: &Connection,
    auth_user_id: &str,
    id: &str,
    content: Option<&str>,
    is_archived: Option<bool>,
    now: i64,
) -> StateResult<Option<ProjectNote>> {
    let auth_user_id = auth_user_id.trim();
    let id = id.trim();
    if auth_user_id.is_empty() || id.is_empty() {
        return Ok(None);
    }
    let Some(existing) = get_project_note(connection, auth_user_id, id)? else {
        return Ok(None);
    };
    let next_content = match content {
        Some(value) => normalize_note_content(value)?,
        None => existing.content,
    };
    let next_archived = is_archived.unwrap_or(existing.is_archived);
    connection.execute(
        "UPDATE project_notes
         SET content = ?1, is_archived = ?2, updated_at = ?3
         WHERE id = ?4 AND auth_user_id = ?5",
        params![
            next_content,
            i64::from(next_archived),
            now,
            id,
            auth_user_id
        ],
    )?;
    get_project_note(connection, auth_user_id, id)
}

pub fn delete_project_note(
    connection: &Connection,
    auth_user_id: &str,
    id: &str,
) -> StateResult<bool> {
    let auth_user_id = auth_user_id.trim();
    let id = id.trim();
    if auth_user_id.is_empty() || id.is_empty() {
        return Ok(false);
    }
    let changed = connection.execute(
        "DELETE FROM project_notes WHERE id = ?1 AND auth_user_id = ?2",
        params![id, auth_user_id],
    )?;
    Ok(changed > 0)
}

fn normalize_note_content(raw: &str) -> StateResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(StateError::InvalidInput(
            "Note content cannot be empty".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_NOTE_CONTENT_LEN {
        return Err(StateError::InvalidInput(format!(
            "Note content exceeds maximum length of {MAX_NOTE_CONTENT_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

fn map_project_note(row: &Row<'_>) -> rusqlite::Result<ProjectNote> {
    Ok(ProjectNote {
        id: row.get("id")?,
        auth_user_id: row.get("auth_user_id")?,
        project_id: row.get("project_id")?,
        content: row.get("content")?,
        is_archived: row.get::<_, i64>("is_archived")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
