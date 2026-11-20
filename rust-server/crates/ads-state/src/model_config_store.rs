use ads_contract::models::ModelConfig;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value, json};

use crate::{StateError, StateResult, column_exists};

const MIN_MODEL_CONTEXT_WINDOW: f64 = 256.0;
const MAX_MODEL_TOKEN_LIMIT: f64 = 100_000_000.0;
const DEFAULT_REASONING_EFFORT: &str = "high";
const STANDARD_REASONING_EFFORTS: [&str; 9] = [
    "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

const MODEL_CONFIG_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS model_configs (
  id TEXT PRIMARY KEY,
  model_id TEXT,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  updated_at INTEGER
);
"#;

pub fn ensure_model_config_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(MODEL_CONFIG_SCHEMA_SQL)?;

    if !column_exists(connection, "model_configs", "model_id")? {
        connection.execute_batch("ALTER TABLE model_configs ADD COLUMN model_id TEXT")?;
    }
    connection.execute_batch(
        "UPDATE model_configs
         SET model_id = id
         WHERE model_id IS NULL OR TRIM(model_id) = ''",
    )?;
    if !column_exists(connection, "model_configs", "provider_id")? {
        connection.execute_batch("ALTER TABLE model_configs ADD COLUMN provider_id TEXT")?;
    }
    connection.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_model_identity
           ON model_configs(provider_id, model_id)
           WHERE provider_id IS NOT NULL",
    )?;
    Ok(())
}

pub fn list_model_configs(connection: &Connection) -> StateResult<Vec<ModelConfig>> {
    let mut statement = connection.prepare(
        "SELECT id, model_id, display_name, provider, provider_id, is_enabled, is_default,
                config_json, updated_at
         FROM model_configs
         ORDER BY is_default DESC, updated_at DESC, display_name ASC",
    )?;
    let rows = statement.query_map([], map_model_config)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_model_config(connection: &Connection, id: &str) -> StateResult<Option<ModelConfig>> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT id, model_id, display_name, provider, provider_id, is_enabled, is_default,
                    config_json, updated_at
             FROM model_configs
             WHERE id = ?1
             LIMIT 1",
            params![id],
            map_model_config,
        )
        .optional()
        .map_err(StateError::from)
}

pub fn get_model_config_by_agent_model_id(
    connection: &Connection,
    agent_model_id: &str,
    provider_id: Option<Option<&str>>,
) -> StateResult<Option<ModelConfig>> {
    let agent_model_id = agent_model_id.trim();
    if agent_model_id.is_empty() {
        return Ok(None);
    }
    let provider_filter =
        provider_id.map(|value| value.map(str::trim).filter(|value| !value.is_empty()));

    let mut statement = connection.prepare(
        "SELECT id, model_id, display_name, provider, provider_id, is_enabled, is_default,
                config_json, updated_at
         FROM model_configs
         WHERE model_id = ?1",
    )?;
    let rows = statement.query_map(params![agent_model_id], map_model_config)?;
    let mut matches = Vec::new();
    for row in rows {
        let config = row?;
        if let Some(filter) = provider_filter {
            if config.provider_id.as_deref() != filter {
                continue;
            }
        }
        matches.push(config);
    }

    if matches.len() > 1 {
        return Err(StateError::InvalidInput(
            "Ambiguous model name; select a provider-specific model configuration.".to_string(),
        ));
    }
    Ok(matches.into_iter().next())
}

pub fn upsert_model_config(
    connection: &mut Connection,
    config: &ModelConfig,
    now: i64,
) -> StateResult<ModelConfig> {
    let id = config.id.trim();
    if id.is_empty() {
        return Err(StateError::InvalidInput(
            "model config id is required".to_string(),
        ));
    }
    let model_id = if config.model_id.trim().is_empty() {
        id
    } else {
        config.model_id.trim()
    };
    if model_id.is_empty() {
        return Err(StateError::InvalidInput(
            "model config modelId is required".to_string(),
        ));
    }
    let display_name = if config.display_name.trim().is_empty() {
        model_id
    } else {
        config.display_name.trim()
    };
    let provider = config.provider.trim();
    if provider.is_empty() {
        return Err(StateError::InvalidInput(
            "model config provider is required".to_string(),
        ));
    }
    let provider_id = config
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let sanitized = sanitize_model_config_json(config.config_json.as_ref());
    let config_json = sanitized.map(|value| value.to_string());

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    if config.is_default {
        let defaults = {
            let mut statement = transaction.prepare(
                "SELECT id, provider_id
                 FROM model_configs
                 WHERE is_default <> 0",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        for (existing_id, existing_provider_id) in defaults {
            if scopes_overlap(provider_id, existing_provider_id.as_deref()) {
                transaction.execute(
                    "UPDATE model_configs SET is_default = 0 WHERE id = ?1",
                    params![existing_id],
                )?;
            }
        }
    }

    transaction.execute(
        "INSERT INTO model_configs
           (id, model_id, display_name, provider, provider_id, is_enabled, is_default, config_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           model_id = excluded.model_id,
           display_name = excluded.display_name,
           provider = excluded.provider,
           provider_id = excluded.provider_id,
           is_enabled = excluded.is_enabled,
           is_default = excluded.is_default,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at",
        params![
            id,
            model_id,
            display_name,
            provider,
            provider_id,
            i64::from(config.is_enabled),
            i64::from(config.is_default),
            config_json,
            now
        ],
    )?;
    transaction.commit()?;

    get_model_config(connection, id)?
        .ok_or_else(|| StateError::InvalidInput("failed to load saved model config".to_string()))
}

pub fn delete_model_config(connection: &Connection, id: &str) -> StateResult<bool> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    let changed = connection.execute("DELETE FROM model_configs WHERE id = ?1", params![id])?;
    Ok(changed > 0)
}

pub fn sanitize_model_config_json(config: Option<&Value>) -> Option<Value> {
    let mut map = config?.as_object()?.clone();

    for (key, minimum) in [
        ("max_input_tokens", MIN_MODEL_CONTEXT_WINDOW),
        ("max_output_tokens", 1.0),
    ] {
        if !map.contains_key(key) {
            continue;
        }
        match normalize_token_limit(map.get(key), minimum) {
            Some(tokens) => {
                map.insert(key.to_string(), json!(tokens));
            }
            None => {
                map.remove(key);
            }
        }
    }

    let has_reasoning_efforts = map.contains_key("reasoningEfforts");
    if has_reasoning_efforts {
        apply_reasoning_efforts(&mut map);
    } else if map.contains_key("defaultReasoningEffort") {
        let configured = normalize_reasoning_effort(map.get("defaultReasoningEffort"));
        map.insert(
            "defaultReasoningEffort".to_string(),
            json!(configured.unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string())),
        );
    }

    if map.contains_key("reasoningEffort") {
        match normalize_reasoning_effort(map.get("reasoningEffort")) {
            Some(effort) => {
                map.insert("reasoningEffort".to_string(), json!(effort));
            }
            None => {
                map.remove("reasoningEffort");
            }
        }
    }

    Some(Value::Object(map))
}

fn apply_reasoning_efforts(map: &mut Map<String, Value>) {
    let mut efforts: Vec<String> = Vec::new();
    let raw = map
        .get("reasoningEfforts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for value in raw {
        if let Some(effort) = normalize_reasoning_effort(Some(&value)) {
            if !efforts.contains(&effort) {
                efforts.push(effort);
            }
        }
    }

    if efforts.is_empty() {
        map.insert(
            "reasoningEfforts".to_string(),
            json!(["medium", DEFAULT_REASONING_EFFORT]),
        );
        map.insert(
            "defaultReasoningEffort".to_string(),
            json!(DEFAULT_REASONING_EFFORT),
        );
        return;
    }

    map.insert("reasoningEfforts".to_string(), json!(efforts));

    let configured_default = normalize_reasoning_effort(map.get("defaultReasoningEffort"));
    if let Some(effort) = configured_default {
        if efforts.contains(&effort) {
            map.insert("defaultReasoningEffort".to_string(), json!(effort));
            return;
        }
    }
    if map.contains_key("defaultReasoningEffort") {
        let fallback = if efforts
            .iter()
            .any(|value| value == DEFAULT_REASONING_EFFORT)
        {
            DEFAULT_REASONING_EFFORT.to_string()
        } else {
            efforts[0].clone()
        };
        map.insert("defaultReasoningEffort".to_string(), json!(fallback));
    }
}

fn normalize_reasoning_effort(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim().to_lowercase();
    if STANDARD_REASONING_EFFORTS.contains(&value.as_str()) {
        Some(value)
    } else {
        None
    }
}

fn normalize_token_limit(value: Option<&Value>, minimum: f64) -> Option<u64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            text.parse::<f64>().ok()?
        }
        _ => return None,
    };
    if !number.is_finite()
        || number.fract() != 0.0
        || number < minimum
        || number > MAX_MODEL_TOKEN_LIMIT
    {
        return None;
    }
    Some(number as u64)
}

fn scopes_overlap(left_provider_id: Option<&str>, right_provider_id: Option<&str>) -> bool {
    let mut left = vec!["codex".to_string()];
    if let Some(provider_id) = left_provider_id {
        left.push(format!("provider:{provider_id}"));
    }
    let mut right = vec!["codex".to_string()];
    if let Some(provider_id) = right_provider_id {
        right.push(format!("provider:{provider_id}"));
    }
    left.iter().any(|scope| right.contains(scope))
}

fn map_model_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelConfig> {
    let id: String = row.get(0)?;
    let model_id: Option<String> = row.get(1)?;
    let config_json: Option<String> = row.get(7)?;
    Ok(ModelConfig {
        model_id: model_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| id.clone()),
        id,
        display_name: row.get(2)?,
        provider: row.get(3)?,
        provider_id: row
            .get::<_, Option<String>>(4)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        is_enabled: row.get::<_, i64>(5)? != 0,
        is_default: row.get::<_, i64>(6)? != 0,
        config_json: config_json
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .filter(Value::is_object),
        updated_at: row.get(8)?,
    })
}
