use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::StateResult;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ReviewQueueLease {
    pub project_id: String,
    pub owner_id: String,
    pub expires_at: i64,
    pub updated_at: i64,
}

pub fn get_review_queue_lease(
    connection: &Connection,
    project_id: &str,
) -> StateResult<Option<ReviewQueueLease>> {
    Ok(connection
        .query_row(
            "SELECT project_id, owner_id, expires_at, updated_at
             FROM review_queue_leases
             WHERE project_id = ?1
             LIMIT 1",
            params![project_id],
            |row| {
                Ok(ReviewQueueLease {
                    project_id: row.get(0)?,
                    owner_id: row.get(1)?,
                    expires_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()?)
}

pub fn acquire_review_queue_lease(
    connection: &Connection,
    project_id: &str,
    owner_id: &str,
    ttl_ms: i64,
    now: i64,
) -> StateResult<bool> {
    let expires_at = now.saturating_add(ttl_ms.max(1));
    let changes = connection.execute(
        "INSERT INTO review_queue_leases (project_id, owner_id, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE review_queue_leases.owner_id = ?
            OR review_queue_leases.expires_at <= ?",
        params![project_id, owner_id, expires_at, now, owner_id, now],
    )?;
    Ok(changes > 0)
}

pub fn renew_review_queue_lease(
    connection: &Connection,
    project_id: &str,
    owner_id: &str,
    ttl_ms: i64,
    now: i64,
) -> StateResult<bool> {
    let expires_at = now.saturating_add(ttl_ms.max(1));
    let changes = connection.execute(
        "UPDATE review_queue_leases
         SET expires_at = ?, updated_at = ?
         WHERE project_id = ? AND owner_id = ?",
        params![expires_at, now, project_id, owner_id],
    )?;
    Ok(changes > 0)
}

pub fn release_review_queue_lease(
    connection: &Connection,
    project_id: &str,
    owner_id: &str,
) -> StateResult<()> {
    connection.execute(
        "DELETE FROM review_queue_leases
         WHERE project_id = ? AND owner_id = ?",
        params![project_id, owner_id],
    )?;
    Ok(())
}
