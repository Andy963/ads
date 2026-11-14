use rusqlite::{OptionalExtension, Row, TransactionBehavior, params};

use crate::{StateDb, StateResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebUser {
    pub id: String,
    pub username: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_login_at: Option<i64>,
    pub disabled_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResetAdminRecord {
    Created {
        user_id: String,
    },
    Updated {
        user_id: String,
        previous_username: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebUserCredential {
    pub user: WebUser,
    pub password_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSession {
    pub id: String,
    pub user_id: String,
    pub token_hash: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub last_seen_ip: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewWebSession<'a> {
    pub id: &'a str,
    pub user_id: &'a str,
    pub token_hash: &'a str,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_ip: Option<&'a str>,
    pub user_agent: Option<&'a str>,
}

pub fn count_users(db: &StateDb) -> StateResult<i64> {
    let connection = db.connect()?;
    let count = connection.query_row("SELECT COUNT(*) FROM web_users", [], |row| row.get(0))?;
    Ok(count)
}

pub fn find_user_credential_by_username(
    db: &StateDb,
    username: &str,
) -> StateResult<Option<WebUserCredential>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT id, username, password_hash, created_at, updated_at, last_login_at, disabled_at
             FROM web_users
             WHERE username = ?1",
            params![username],
            map_user_credential,
        )
        .optional()
        .map_err(Into::into)
}

pub fn find_user_by_id(db: &StateDb, user_id: &str) -> StateResult<Option<WebUser>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT id, username, created_at, updated_at, last_login_at, disabled_at
             FROM web_users
             WHERE id = ?1",
            params![user_id],
            map_user,
        )
        .optional()
        .map_err(Into::into)
}

pub fn find_primary_active_user(db: &StateDb) -> StateResult<Option<WebUser>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT id, username, created_at, updated_at, last_login_at, disabled_at
             FROM web_users
             WHERE disabled_at IS NULL
             ORDER BY created_at ASC, id ASC
             LIMIT 1",
            [],
            map_user,
        )
        .optional()
        .map_err(Into::into)
}

pub fn insert_user(
    db: &StateDb,
    id: &str,
    username: &str,
    password_hash: &str,
    now_seconds: i64,
) -> StateResult<WebUser> {
    let connection = db.connect()?;
    connection.execute(
        "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, username, password_hash, now_seconds],
    )?;
    find_user_by_id(db, id)?
        .ok_or_else(|| crate::StateError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
}

pub fn insert_user_if_empty(
    db: &StateDb,
    id: &str,
    username: &str,
    password_hash: &str,
    now_seconds: i64,
) -> StateResult<bool> {
    let mut connection = db.connect()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: i64 =
        transaction.query_row("SELECT COUNT(*) FROM web_users", [], |row| row.get(0))?;
    if existing > 0 {
        return Ok(false);
    }
    transaction.execute(
        "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, username, password_hash, now_seconds],
    )?;
    transaction.commit()?;
    Ok(true)
}

pub fn reset_admin_user(
    db: &StateDb,
    new_user_id: &str,
    username: &str,
    password_hash: &str,
    now_seconds: i64,
) -> StateResult<ResetAdminRecord> {
    let mut connection = db.connect()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let first_user: Option<(String, String)> = transaction
        .query_row(
            "SELECT id, username FROM web_users ORDER BY created_at ASC, id ASC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    let Some((user_id, previous_username)) = first_user else {
        transaction.execute(
            "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![new_user_id, username, password_hash, now_seconds],
        )?;
        transaction.commit()?;
        return Ok(ResetAdminRecord::Created {
            user_id: new_user_id.to_string(),
        });
    };

    let collision: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM web_users WHERE username = ?1 AND id <> ?2 LIMIT 1",
            params![username, user_id],
            |row| row.get(0),
        )
        .optional()?;
    if collision.is_some() {
        return Err(crate::StateError::InvalidInput(format!(
            "username already exists: {username}"
        )));
    }

    transaction.execute(
        "UPDATE web_users
         SET username = ?1, password_hash = ?2, updated_at = ?3, disabled_at = NULL
         WHERE id = ?4",
        params![username, password_hash, now_seconds, user_id],
    )?;
    transaction.execute(
        "UPDATE web_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL",
        params![now_seconds, user_id],
    )?;
    transaction.commit()?;

    Ok(ResetAdminRecord::Updated {
        user_id,
        previous_username,
    })
}

pub fn create_session(db: &StateDb, session: NewWebSession<'_>) -> StateResult<WebSession> {
    let connection = db.connect()?;
    connection.execute(
        "INSERT INTO web_sessions
           (id, user_id, token_hash, created_at, expires_at, last_seen_at, last_seen_ip, user_agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7)",
        params![
            session.id,
            session.user_id,
            session.token_hash,
            session.created_at,
            session.expires_at,
            session.last_seen_ip,
            session.user_agent,
        ],
    )?;

    Ok(WebSession {
        id: session.id.to_string(),
        user_id: session.user_id.to_string(),
        token_hash: session.token_hash.to_string(),
        created_at: session.created_at,
        expires_at: session.expires_at,
        revoked_at: None,
        last_seen_at: Some(session.created_at),
        last_seen_ip: session.last_seen_ip.map(str::to_string),
        user_agent: session.user_agent.map(str::to_string),
    })
}

pub fn lookup_session_by_token_hash(
    db: &StateDb,
    token_hash: &str,
) -> StateResult<Option<WebSession>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT id, user_id, token_hash, created_at, expires_at, revoked_at,
                    last_seen_at, last_seen_ip, user_agent
             FROM web_sessions
             WHERE token_hash = ?1",
            params![token_hash],
            map_session,
        )
        .optional()
        .map_err(Into::into)
}

pub fn revoke_session_by_token_hash(
    db: &StateDb,
    token_hash: &str,
    now_seconds: i64,
) -> StateResult<bool> {
    let connection = db.connect()?;
    let changed = connection.execute(
        "UPDATE web_sessions
         SET revoked_at = ?1
         WHERE token_hash = ?2 AND revoked_at IS NULL",
        params![now_seconds, token_hash],
    )?;
    Ok(changed > 0)
}

pub fn is_session_active_by_token_hash(
    db: &StateDb,
    token_hash: &str,
    now_seconds: i64,
) -> StateResult<bool> {
    let connection = db.connect()?;
    let row: Option<(Option<i64>, i64)> = connection
        .query_row(
            "SELECT revoked_at, expires_at FROM web_sessions WHERE token_hash = ?1",
            params![token_hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(_), _)) => false,
        Some((None, expires_at)) => expires_at > now_seconds,
        None => false,
    })
}

pub fn touch_session(
    db: &StateDb,
    token_hash: &str,
    now_seconds: i64,
    last_seen_ip: Option<&str>,
    user_agent: Option<&str>,
    expires_at: Option<i64>,
) -> StateResult<()> {
    let connection = db.connect()?;
    if let Some(expires_at) = expires_at {
        connection.execute(
            "UPDATE web_sessions
             SET last_seen_at = ?1, last_seen_ip = ?2, user_agent = ?3, expires_at = ?4
             WHERE token_hash = ?5",
            params![
                now_seconds,
                last_seen_ip,
                user_agent,
                expires_at,
                token_hash
            ],
        )?;
    } else {
        connection.execute(
            "UPDATE web_sessions
             SET last_seen_at = ?1, last_seen_ip = ?2, user_agent = ?3
             WHERE token_hash = ?4",
            params![now_seconds, last_seen_ip, user_agent, token_hash],
        )?;
    }
    Ok(())
}

pub fn record_login(db: &StateDb, user_id: &str, now_seconds: i64) -> StateResult<()> {
    let connection = db.connect()?;
    connection.execute(
        "UPDATE web_users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now_seconds, user_id],
    )?;
    Ok(())
}

fn map_user(row: &Row<'_>) -> rusqlite::Result<WebUser> {
    Ok(WebUser {
        id: row.get(0)?,
        username: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        last_login_at: row.get(4)?,
        disabled_at: row.get(5)?,
    })
}

fn map_user_credential(row: &Row<'_>) -> rusqlite::Result<WebUserCredential> {
    Ok(WebUserCredential {
        user: WebUser {
            id: row.get(0)?,
            username: row.get(1)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            last_login_at: row.get(5)?,
            disabled_at: row.get(6)?,
        },
        password_hash: row.get(2)?,
    })
}

fn map_session(row: &Row<'_>) -> rusqlite::Result<WebSession> {
    Ok(WebSession {
        id: row.get(0)?,
        user_id: row.get(1)?,
        token_hash: row.get(2)?,
        created_at: row.get(3)?,
        expires_at: row.get(4)?,
        revoked_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        last_seen_ip: row.get(7)?,
        user_agent: row.get(8)?,
    })
}
