use ads_contract::models::{ModelConfig, ModelServiceSelection};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};

use crate::model_config_store::{get_model_config, list_model_configs};
use crate::model_provider_store::get_model_provider;
use crate::{StateError, StateResult, table_exists};

pub const MODEL_SERVICES: [&str; 3] = ["conversation", "transcription", "correction"];
pub const CONVERSATION_SERVICE: &str = "conversation";

const SERVICE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS model_service_members (
  service TEXT NOT NULL CHECK (service IN ('conversation', 'transcription', 'correction')),
  model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  PRIMARY KEY (service, model_config_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_service_default
  ON model_service_members(service) WHERE is_default = 1;
CREATE TABLE IF NOT EXISTS model_services_initialized (id INTEGER PRIMARY KEY CHECK (id = 1));
"#;

pub fn ensure_model_service_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(SERVICE_SCHEMA_SQL)?;
    Ok(())
}

/// Seeds the conversation service from the enabled catalog the first time a
/// model route runs, mirroring `createModelServiceStore`.
pub fn initialize_model_services(connection: &Connection) -> StateResult<()> {
    let initialized: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM model_services_initialized WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();
    if initialized.is_some() {
        return Ok(());
    }

    let transaction = connection.unchecked_transaction()?;
    let enabled: Vec<ModelConfig> = list_model_configs(&transaction)?
        .into_iter()
        .filter(|model| model.is_enabled)
        .collect();
    let selected = enabled
        .iter()
        .find(|model| model.is_default)
        .or_else(|| enabled.first())
        .map(|model| model.id.clone());
    for model in &enabled {
        transaction.execute(
            "INSERT OR IGNORE INTO model_service_members (service, model_config_id, is_default)
             VALUES (?1, ?2, ?3)",
            params![
                CONVERSATION_SERVICE,
                model.id,
                i64::from(selected.as_deref() == Some(model.id.as_str()))
            ],
        )?;
    }
    transaction.execute("INSERT INTO model_services_initialized (id) VALUES (1)", [])?;
    transaction.commit()?;
    Ok(())
}

pub fn get_model_service(
    connection: &Connection,
    service: &str,
) -> StateResult<ModelServiceSelection> {
    let mut statement = connection.prepare(
        "SELECT model_config_id, is_default
         FROM model_service_members
         WHERE service = ?1
         ORDER BY model_config_id",
    )?;
    let rows = statement.query_map(params![service], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
    })?;

    let mut model_ids = Vec::new();
    let mut default_model_id = None;
    for row in rows {
        let (model_id, is_default) = row?;
        if is_default {
            default_model_id = Some(model_id.clone());
        }
        model_ids.push(model_id);
    }

    Ok(ModelServiceSelection {
        service: service.to_string(),
        model_ids,
        default_model_id,
    })
}

pub fn list_model_services(connection: &Connection) -> StateResult<Vec<ModelServiceSelection>> {
    MODEL_SERVICES
        .iter()
        .map(|service| get_model_service(connection, service))
        .collect()
}

pub fn save_model_service(
    connection: &mut Connection,
    service: &str,
    model_ids: &[String],
    default_model_id: Option<&str>,
) -> StateResult<ModelServiceSelection> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let mut ids = Vec::new();
    for id in model_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let default_model_id = default_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let selection_valid = if ids.is_empty() {
        default_model_id.is_none()
    } else {
        default_model_id.is_some_and(|value| ids.iter().any(|id| id == value))
    };
    if !selection_valid {
        return Err(StateError::InvalidInput(
            "Select exactly one default from the enabled models, or disable all models."
                .to_string(),
        ));
    }

    for id in &ids {
        let Some(model) = get_model_config(&transaction, id)? else {
            return Err(StateError::InvalidInput(
                "Unknown model configuration.".to_string(),
            ));
        };
        if !model.is_enabled {
            return Err(StateError::InvalidInput(
                "The model is disabled in the catalog.".to_string(),
            ));
        }
        if let Some(provider_id) = model.provider_id.as_deref() {
            let provider = get_model_provider(&transaction, provider_id)?;
            if !provider.is_some_and(|provider| provider.is_enabled) {
                return Err(StateError::InvalidInput(
                    "The model provider is disabled or missing.".to_string(),
                ));
            }
        } else if service != CONVERSATION_SERVICE {
            return Err(StateError::InvalidInput(
                "Attach the model to a provider first.".to_string(),
            ));
        }
    }

    transaction.execute(
        "DELETE FROM model_service_members WHERE service = ?1",
        params![service],
    )?;
    for id in &ids {
        transaction.execute(
            "INSERT INTO model_service_members (service, model_config_id, is_default)
             VALUES (?1, ?2, ?3)",
            params![
                service,
                id,
                i64::from(default_model_id == Some(id.as_str()))
            ],
        )?;
    }
    transaction.commit()?;

    get_model_service(connection, service)
}

pub fn list_service_models(
    connection: &Connection,
    service: &str,
) -> StateResult<Vec<ModelConfig>> {
    let selection = get_model_service(connection, service)?;
    let mut models = Vec::new();
    for model in list_model_configs(connection)? {
        if !selection.model_ids.contains(&model.id) || !model.is_enabled {
            continue;
        }
        let mut model = model;
        if let Some(provider_id) = model.provider_id.as_deref() {
            let Some(provider) = get_model_provider(connection, provider_id)? else {
                continue;
            };
            if !provider.is_enabled {
                continue;
            }
            model.provider = provider.name;
        }
        model.is_default = selection.default_model_id.as_deref() == Some(model.id.as_str());
        models.push(model);
    }
    Ok(models)
}

pub fn resolve_conversation_model(
    connection: &Connection,
    reference: &str,
) -> StateResult<ModelConfig> {
    let available = list_service_models(connection, CONVERSATION_SERVICE)?;
    if let Some(exact) = available.iter().find(|model| model.id == reference) {
        return Ok(exact.clone());
    }
    let legacy: Vec<&ModelConfig> = available
        .iter()
        .filter(|model| model.model_id == reference)
        .collect();
    if legacy.len() == 1 {
        return Ok(legacy[0].clone());
    }

    let labels: Vec<String> = available
        .iter()
        .map(|model| {
            let display = model.display_name.trim();
            if display.is_empty() {
                model.model_id.clone()
            } else {
                display.to_string()
            }
        })
        .filter(|label| !label.is_empty())
        .collect();
    let available_labels = if labels.is_empty() {
        "none".to_string()
    } else {
        labels.join(", ")
    };
    let reason = if legacy.len() > 1 {
        "ambiguous"
    } else {
        "not available in the conversation service"
    };
    Err(StateError::InvalidInput(format!(
        "Conversation model '{reference}' is {reason}; select one of: {available_labels}."
    )))
}

pub fn remove_model_service_references(
    connection: &mut Connection,
    model_id: &str,
    now: i64,
) -> StateResult<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    remove_model_service_references_tx(&transaction, model_id, now)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn remove_model_service_references_tx(
    transaction: &Transaction<'_>,
    model_id: &str,
    now: i64,
) -> StateResult<()> {
    let Some(model) = get_model_config(transaction, model_id)? else {
        return Ok(());
    };

    for service in MODEL_SERVICES {
        let selection = get_model_service(transaction, service)?;
        if !selection.model_ids.iter().any(|id| id == model_id) {
            continue;
        }
        transaction.execute(
            "DELETE FROM model_service_members WHERE service = ?1 AND model_config_id = ?2",
            params![service, model_id],
        )?;
        if selection.default_model_id.as_deref() == Some(model_id) {
            let next = list_service_models(transaction, service)?
                .first()
                .map(|model| model.id.clone())
                .or_else(|| {
                    get_model_service(transaction, service)
                        .ok()
                        .and_then(|selection| selection.model_ids.first().cloned())
                });
            if let Some(next) = next {
                transaction.execute(
                    "UPDATE model_service_members SET is_default = 1
                     WHERE service = ?1 AND model_config_id = ?2",
                    params![service, next],
                )?;
            }
        }
    }

    if table_exists(transaction, "role_profiles")? {
        let same_name = list_model_configs(transaction)?
            .into_iter()
            .filter(|item| item.model_id == model.model_id)
            .count();
        let legacy_name = if same_name == 1 {
            Some(model.model_id.clone())
        } else {
            None
        };
        let default_model_id = get_model_service(transaction, CONVERSATION_SERVICE)?
            .default_model_id
            .unwrap_or_default();
        transaction.execute(
            "UPDATE role_profiles
             SET model_id = ?1, version = version + 1, updated_at = ?2
             WHERE model_id = ?3 OR (?4 IS NOT NULL AND model_id = ?4)",
            params![default_model_id, now, model_id, legacy_name],
        )?;
    }

    Ok(())
}

pub fn remove_provider_service_references(
    connection: &mut Connection,
    provider_id: &str,
    now: i64,
) -> StateResult<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    remove_provider_service_references_tx(&transaction, provider_id, now)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn remove_provider_service_references_tx(
    transaction: &Transaction<'_>,
    provider_id: &str,
    now: i64,
) -> StateResult<()> {
    let attached: Vec<String> = list_model_configs(transaction)?
        .into_iter()
        .filter(|model| model.provider_id.as_deref() == Some(provider_id))
        .map(|model| model.id)
        .collect();
    for model_id in attached {
        remove_model_service_references_tx(transaction, &model_id, now)?;
    }
    Ok(())
}
