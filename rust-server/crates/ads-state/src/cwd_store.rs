use rusqlite::{OptionalExtension, params};

use crate::{StateDb, StateResult};

pub const WEB_CWD_NAMESPACE: &str = "web_cwd";

pub fn get_user_cwd(db: &StateDb, key: &str) -> StateResult<Option<String>> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let connection = db.connect()?;
    let value = connection
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![WEB_CWD_NAMESPACE, key],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(value)
}

pub fn set_user_cwd(db: &StateDb, key: &str, value: &str) -> StateResult<bool> {
    let key = key.trim();
    if key.is_empty() || value.trim().is_empty() {
        return Ok(false);
    }
    let connection = db.connect()?;
    let updated = connection.execute(
        "INSERT INTO kv_state (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![
            WEB_CWD_NAMESPACE,
            key,
            value,
            ads_contract::time::now_unix_millis()
        ],
    )?;
    Ok(updated > 0)
}
