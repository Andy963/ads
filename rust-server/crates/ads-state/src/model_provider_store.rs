use ads_contract::models::ModelProvider;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::model_service_store::remove_provider_service_references_tx;
use crate::{StateError, StateResult, column_exists};

const PROVIDER_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_profile TEXT,
  wire_api TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);
"#;

pub fn ensure_model_provider_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(PROVIDER_SCHEMA_SQL)?;
    Ok(())
}

pub fn list_model_providers(connection: &Connection) -> StateResult<Vec<ModelProvider>> {
    let mut statement = connection.prepare(
        "SELECT id, name, base_url, credential_profile, wire_api, is_enabled, updated_at
         FROM model_providers
         ORDER BY updated_at DESC, name ASC",
    )?;
    let rows = statement.query_map([], map_provider)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_model_provider(connection: &Connection, id: &str) -> StateResult<Option<ModelProvider>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, name, base_url, credential_profile, wire_api, is_enabled, updated_at
             FROM model_providers
             WHERE id = ?1
             LIMIT 1",
            params![id],
            map_provider,
        )
        .optional()
        .map_err(StateError::from)
}

pub fn upsert_model_provider(
    connection: &Connection,
    provider: &ModelProvider,
    now: i64,
) -> StateResult<ModelProvider> {
    let id = provider.id.trim();
    if id.is_empty() {
        return Err(StateError::InvalidInput(
            "model provider id is required".to_string(),
        ));
    }
    let name = provider.name.trim();
    if name.is_empty() {
        return Err(StateError::InvalidInput(
            "model provider name is required".to_string(),
        ));
    }
    let base_url = provider.base_url.trim();
    if base_url.is_empty() {
        return Err(StateError::InvalidInput(
            "model provider baseUrl is required".to_string(),
        ));
    }
    let credential_profile = provider
        .credential_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let wire_api = provider
        .wire_api
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    connection.execute(
        "INSERT INTO model_providers
           (id, name, base_url, credential_profile, wire_api, is_enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           credential_profile = excluded.credential_profile,
           wire_api = excluded.wire_api,
           is_enabled = excluded.is_enabled,
           updated_at = excluded.updated_at",
        params![
            id,
            name,
            base_url,
            credential_profile,
            wire_api,
            i64::from(provider.is_enabled),
            now
        ],
    )?;

    get_model_provider(connection, id)?
        .ok_or_else(|| StateError::InvalidInput("failed to load saved model provider".to_string()))
}

pub fn delete_model_provider(connection: &mut Connection, id: &str) -> StateResult<bool> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    if get_model_provider(connection, id)?.is_none() {
        return Ok(false);
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if column_exists(&transaction, "model_configs", "provider_id")? {
        transaction.execute(
            "DELETE FROM model_configs WHERE provider_id = ?1",
            params![id],
        )?;
    }
    let changed = transaction.execute("DELETE FROM model_providers WHERE id = ?1", params![id])?;
    transaction.commit()?;
    Ok(changed > 0)
}

fn map_provider(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelProvider> {
    Ok(ModelProvider {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        credential_profile: row
            .get::<_, Option<String>>(3)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        wire_api: row
            .get::<_, Option<String>>(4)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        is_enabled: row.get::<_, i64>(5)? != 0,
        updated_at: row.get(6)?,
    })
}

pub fn delete_model_provider_with_references(
    connection: &mut Connection,
    id: &str,
    now: i64,
) -> StateResult<bool> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if get_model_provider(&transaction, id)?.is_none() {
        return Ok(false);
    }
    remove_provider_service_references_tx(&transaction, id, now)?;
    if column_exists(&transaction, "model_configs", "provider_id")? {
        transaction.execute(
            "DELETE FROM model_configs WHERE provider_id = ?1",
            params![id],
        )?;
    }
    let changed = transaction.execute("DELETE FROM model_providers WHERE id = ?1", params![id])?;
    transaction.commit()?;
    Ok(changed > 0)
}
