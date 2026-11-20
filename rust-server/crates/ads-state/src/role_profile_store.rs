use ads_contract::role_profiles::RoleProfile;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::{StateError, StateResult};

pub const ROLE_ACOPILOT: &str = "acopilot";
pub const ROLE_REVIEWER: &str = "reviewer";
pub const REASONING_EFFORTS: [&str; 3] = ["low", "medium", "high"];

#[derive(Debug, Clone, Copy)]
pub struct SaveRoleProfile<'a> {
    pub id: &'a str,
    pub role: &'a str,
    pub name: &'a str,
    pub model_id: &'a str,
    pub reasoning_effort: &'a str,
    pub system_prompt: &'a str,
    pub is_enabled: bool,
    pub is_default: bool,
}

pub fn list_role_profiles(
    connection: &Connection,
    role: Option<&str>,
) -> StateResult<Vec<RoleProfile>> {
    if let Some(role) = role {
        let mut statement = connection.prepare(
            "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                    is_enabled, is_default, version, updated_at
             FROM role_profiles
             WHERE role = ?1
             ORDER BY is_default DESC, updated_at DESC",
        )?;
        let rows = statement.query_map(params![role], map_role_profile)?;
        return rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(StateError::from);
    }

    let mut statement = connection.prepare(
        "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                is_enabled, is_default, version, updated_at
         FROM role_profiles
         ORDER BY role ASC, is_default DESC, updated_at DESC",
    )?;
    let rows = statement.query_map([], map_role_profile)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StateError::from)
}

pub fn get_default_role_profile(
    connection: &Connection,
    role: &str,
) -> StateResult<Option<RoleProfile>> {
    let selected = connection
        .query_row(
            "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                    is_enabled, is_default, version, updated_at
             FROM role_profiles
             WHERE role = ?1 AND is_default = 1
             LIMIT 1",
            params![role],
            map_role_profile,
        )
        .optional()?;
    if selected.is_some() {
        return Ok(selected);
    }
    connection
        .query_row(
            "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                    is_enabled, is_default, version, updated_at
             FROM role_profiles
             WHERE role = ?1
             LIMIT 1",
            params![role],
            map_role_profile,
        )
        .optional()
        .map_err(StateError::from)
}

pub fn get_role_profile_by_id(
    connection: &Connection,
    id: &str,
) -> StateResult<Option<RoleProfile>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                    is_enabled, is_default, version, updated_at
             FROM role_profiles
             WHERE id = ?1
             LIMIT 1",
            params![id],
            map_role_profile,
        )
        .optional()
        .map_err(StateError::from)
}

pub fn save_role_profile(
    connection: &mut Connection,
    profile: SaveRoleProfile<'_>,
    now: i64,
) -> StateResult<RoleProfile> {
    let id = profile.id.trim();
    if id.is_empty() {
        return Err(StateError::InvalidInput(
            "role profile id is required".to_string(),
        ));
    }
    if !matches!(profile.role, ROLE_ACOPILOT | ROLE_REVIEWER) {
        return Err(StateError::InvalidInput(
            "invalid role profile role".to_string(),
        ));
    }
    if !REASONING_EFFORTS.contains(&profile.reasoning_effort) {
        return Err(StateError::InvalidInput(
            "invalid role profile reasoning effort".to_string(),
        ));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = get_role_profile_by_id(&transaction, id)?;
    let next_version = existing.as_ref().map_or(1, |profile| profile.version + 1);

    if profile.is_default {
        transaction.execute(
            "UPDATE role_profiles SET is_default = 0 WHERE role = ?1",
            params![profile.role],
        )?;
    }

    transaction.execute(
        "INSERT INTO role_profiles
           (id, role, name, model_id, reasoning_effort, system_prompt,
            is_enabled, is_default, version, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           model_id = excluded.model_id,
           reasoning_effort = excluded.reasoning_effort,
           system_prompt = excluded.system_prompt,
           is_enabled = excluded.is_enabled,
           is_default = excluded.is_default,
           version = excluded.version,
           updated_at = excluded.updated_at",
        params![
            id,
            profile.role,
            profile.name,
            profile.model_id,
            profile.reasoning_effort,
            profile.system_prompt,
            i64::from(profile.is_enabled),
            i64::from(profile.is_default),
            next_version,
            now
        ],
    )?;
    transaction.commit()?;

    get_role_profile_by_id(connection, id)?
        .ok_or_else(|| StateError::InvalidInput("failed to load saved role profile".to_string()))
}

fn map_role_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoleProfile> {
    Ok(RoleProfile {
        id: row.get(0)?,
        role: row.get(1)?,
        name: row.get(2)?,
        model_id: row.get(3)?,
        reasoning_effort: row.get(4)?,
        system_prompt: row.get(5)?,
        is_enabled: row.get(6)?,
        is_default: row.get(7)?,
        version: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
