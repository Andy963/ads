use ads_contract::projects::WebProjectRecord;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::{StateError, StateResult, column_exists};

pub const DEFAULT_PROJECT_ID: &str = "default";
pub const DEFAULT_PROJECT_CHAT_SESSION_ID: &str = "main";

const PROJECT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS web_projects (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  chat_session_id TEXT NOT NULL DEFAULT 'main',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, project_id),
  UNIQUE(user_id, workspace_root),
  FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_projects_user_updated
  ON web_projects(user_id, updated_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS web_user_settings (
  user_id TEXT NOT NULL PRIMARY KEY,
  active_project_id TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
);
"#;

#[derive(Debug, Clone, Copy)]
pub struct UpsertWebProject<'a> {
    pub user_id: &'a str,
    pub project_id: &'a str,
    pub workspace_root: &'a str,
    pub name: &'a str,
    pub chat_session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct UpdateWebProject<'a> {
    pub user_id: &'a str,
    pub project_id: &'a str,
    pub name: Option<&'a str>,
    pub chat_session_id: Option<&'a str>,
}

pub fn ensure_web_project_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(PROJECT_SCHEMA_SQL)?;

    if !column_exists(connection, "web_projects", "sort_order")? {
        let _ = connection.execute_batch(
            "ALTER TABLE web_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        );
    }
    let _ = connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_web_projects_user_sort
           ON web_projects(user_id, sort_order ASC, updated_at DESC, created_at DESC, project_id ASC)",
    );

    backfill_sort_order(connection)?;
    Ok(())
}

fn backfill_sort_order(connection: &Connection) -> StateResult<()> {
    let mut statement = connection.prepare(
        "SELECT user_id, COUNT(1), SUM(CASE WHEN sort_order != 0 THEN 1 ELSE 0 END)
         FROM web_projects
         GROUP BY user_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;

    let mut candidates = Vec::new();
    for row in rows {
        let (user_id, project_count, non_zero_count) = row?;
        let user_id = user_id.trim().to_string();
        if !user_id.is_empty() && project_count > 0 && non_zero_count == 0 {
            candidates.push(user_id);
        }
    }
    drop(statement);

    if candidates.is_empty() {
        return Ok(());
    }

    let transaction = connection.unchecked_transaction()?;
    for user_id in candidates {
        let project_ids = {
            let mut statement = transaction.prepare(
                "SELECT project_id FROM web_projects
                 WHERE user_id = ?1
                 ORDER BY updated_at DESC, created_at DESC, project_id ASC",
            )?;
            let rows = statement.query_map(params![user_id], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (index, project_id) in project_ids.iter().enumerate() {
            let project_id = project_id.trim();
            if project_id.is_empty() {
                continue;
            }
            transaction.execute(
                "UPDATE web_projects SET sort_order = ?1 WHERE user_id = ?2 AND project_id = ?3",
                params![index as i64, user_id, project_id],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub fn get_web_project(
    connection: &Connection,
    user_id: &str,
    project_id: &str,
) -> StateResult<Option<WebProjectRecord>> {
    let user_id = user_id.trim();
    let project_id = project_id.trim();
    if user_id.is_empty() || project_id.is_empty() {
        return Ok(None);
    }

    connection
        .query_row(
            "SELECT project_id, workspace_root, display_name, chat_session_id, created_at, updated_at
             FROM web_projects
             WHERE user_id = ?1 AND project_id = ?2
             LIMIT 1",
            params![user_id, project_id],
            map_project,
        )
        .optional()
        .map_err(StateError::from)
}

pub fn list_web_projects(
    connection: &Connection,
    user_id: &str,
) -> StateResult<Vec<WebProjectRecord>> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Ok(Vec::new());
    }

    let mut statement = connection.prepare(
        "SELECT project_id, workspace_root, display_name, chat_session_id, created_at, updated_at
         FROM web_projects
         WHERE user_id = ?1
         ORDER BY sort_order ASC, updated_at DESC, created_at DESC, project_id ASC",
    )?;
    let rows = statement.query_map(params![user_id], map_project)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StateError::from)
}

pub fn get_active_project_id(
    connection: &Connection,
    user_id: &str,
) -> StateResult<Option<String>> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Ok(None);
    }

    let active: Option<String> = connection
        .query_row(
            "SELECT active_project_id FROM web_user_settings WHERE user_id = ?1 LIMIT 1",
            params![user_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(active
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

pub fn set_active_project_id(
    connection: &Connection,
    user_id: &str,
    project_id: Option<&str>,
    now: i64,
) -> StateResult<()> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Ok(());
    }
    let project_id = project_id.map(str::trim);
    connection.execute(
        "INSERT INTO web_user_settings (user_id, active_project_id, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET
           active_project_id = excluded.active_project_id,
           updated_at = excluded.updated_at",
        params![user_id, project_id, now],
    )?;
    Ok(())
}

pub fn upsert_web_project(
    connection: &Connection,
    args: UpsertWebProject<'_>,
    now: i64,
) -> StateResult<WebProjectRecord> {
    let user_id = require_field("userId", args.user_id)?;
    let project_id = require_field("projectId", args.project_id)?;
    let workspace_root = require_field("workspaceRoot", args.workspace_root)?;
    let name = require_field("name", args.name)?;
    let chat_session_id = normalize(args.chat_session_id)
        .unwrap_or_else(|| DEFAULT_PROJECT_CHAT_SESSION_ID.to_string());

    let existing = connection
        .query_row(
            "SELECT created_at, sort_order, chat_session_id
             FROM web_projects
             WHERE user_id = ?1 AND project_id = ?2
             LIMIT 1",
            params![user_id, project_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;

    let created_at = existing
        .as_ref()
        .map(|(created_at, _, _)| *created_at)
        .unwrap_or(now);
    let sort_order = match existing.as_ref() {
        Some((_, sort_order, _)) => *sort_order,
        None => next_project_sort_order(connection, user_id)?,
    };

    connection.execute(
        "INSERT INTO web_projects
           (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(user_id, project_id) DO UPDATE SET
           workspace_root = excluded.workspace_root,
           display_name = excluded.display_name,
           chat_session_id = excluded.chat_session_id,
           updated_at = excluded.updated_at",
        params![
            user_id,
            project_id,
            workspace_root,
            name,
            chat_session_id,
            sort_order,
            created_at,
            now
        ],
    )?;

    Ok(WebProjectRecord {
        id: project_id.to_string(),
        workspace_root: workspace_root.to_string(),
        name: name.to_string(),
        chat_session_id: chat_session_id.to_string(),
        created_at,
        updated_at: now,
    })
}

pub fn update_web_project(
    connection: &Connection,
    args: UpdateWebProject<'_>,
    now: i64,
) -> StateResult<Option<WebProjectRecord>> {
    let user_id = args.user_id.trim();
    let project_id = args.project_id.trim();
    if user_id.is_empty() || project_id.is_empty() {
        return Ok(None);
    }

    let Some(current) = get_web_project(connection, user_id, project_id)? else {
        return Ok(None);
    };

    let name = normalize(args.name)
        .or_else(|| Some(current.name.clone()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Project".to_string());
    let chat_session_id = normalize(args.chat_session_id)
        .or_else(|| Some(current.chat_session_id.clone()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PROJECT_CHAT_SESSION_ID.to_string());

    connection.execute(
        "UPDATE web_projects
         SET display_name = ?1, chat_session_id = ?2, updated_at = ?3
         WHERE user_id = ?4 AND project_id = ?5",
        params![name, chat_session_id, now, user_id, project_id],
    )?;

    Ok(Some(WebProjectRecord {
        id: current.id,
        workspace_root: current.workspace_root,
        name,
        chat_session_id,
        created_at: current.created_at,
        updated_at: now,
    }))
}

pub fn delete_web_project(
    connection: &Connection,
    user_id: &str,
    project_id: &str,
) -> StateResult<bool> {
    let user_id = user_id.trim();
    let project_id = project_id.trim();
    if user_id.is_empty() || project_id.is_empty() {
        return Ok(false);
    }

    let _ = connection.execute(
        "DELETE FROM action_jobs WHERE project_id = ?1",
        params![project_id],
    );
    let _ = connection.execute(
        "DELETE FROM review_queue_leases WHERE project_id = ?1",
        params![project_id],
    );
    let changed = connection.execute(
        "DELETE FROM web_projects WHERE user_id = ?1 AND project_id = ?2",
        params![user_id, project_id],
    )?;
    Ok(changed == 1)
}

pub fn reorder_web_projects(
    connection: &mut Connection,
    user_id: &str,
    ids: &[String],
) -> StateResult<()> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Ok(());
    }

    let mut ordered = Vec::new();
    for id in ids {
        let project_id = id.trim();
        if project_id.is_empty() {
            continue;
        }
        if project_id == DEFAULT_PROJECT_ID {
            return Err(StateError::InvalidInput(
                "default project cannot be reordered".to_string(),
            ));
        }
        if ordered.iter().any(|value: &String| value == project_id) {
            continue;
        }
        ordered.push(project_id.to_string());
    }
    if ordered.is_empty() {
        return Ok(());
    }

    let existing = {
        let mut statement = connection.prepare(
            "SELECT project_id FROM web_projects
             WHERE user_id = ?1
             ORDER BY sort_order ASC, updated_at DESC, created_at DESC, project_id ASC",
        )?;
        let rows = statement.query_map(params![user_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    if existing.is_empty() {
        return Ok(());
    }
    for project_id in &ordered {
        if !existing.iter().any(|value| value == project_id) {
            return Err(StateError::InvalidInput(format!(
                "Unknown project id: {project_id}"
            )));
        }
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (index, project_id) in ordered.iter().enumerate() {
        transaction.execute(
            "UPDATE web_projects SET sort_order = ?1 WHERE user_id = ?2 AND project_id = ?3",
            params![index as i64, user_id, project_id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn next_project_sort_order(connection: &Connection, user_id: &str) -> StateResult<i64> {
    let next: i64 = connection.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM web_projects WHERE user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )?;
    Ok(next.max(0))
}

fn require_field<'a>(field: &str, value: &'a str) -> StateResult<&'a str> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(StateError::InvalidInput(format!("{field} is required")));
    }
    Ok(normalized)
}

fn normalize(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn map_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<WebProjectRecord> {
    Ok(WebProjectRecord {
        id: row.get(0)?,
        workspace_root: row.get(1)?,
        name: row.get(2)?,
        chat_session_id: row
            .get::<_, Option<String>>(3)?
            .unwrap_or_else(|| DEFAULT_PROJECT_CHAT_SESSION_ID.to_string()),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
