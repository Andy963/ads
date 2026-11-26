use std::collections::HashMap;

use ads_contract::models::{
    CreateModelConfigRequest, ModelConfig, ModelServiceSelection, SaveModelServiceRequest,
    UpdateModelConfigRequest,
};
use ads_contract::projects::SuccessResponse;
use ads_contract::time::now_unix_millis;
use ads_state::{
    CONVERSATION_SERVICE, MODEL_SERVICES, StateError, delete_model_config, get_model_config,
    get_model_config_by_agent_model_id, get_model_provider, initialize_model_services,
    list_model_configs, list_model_services, list_service_models, remove_model_service_references,
    save_model_service, upsert_model_config,
};
use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

use super::{JsonDecodeError, read_json, read_json_payload, require_session};
use crate::AppState;
use crate::error::ApiError;

const FORBIDDEN_CREDENTIAL_KEYS: [&str; 10] = [
    "apikey",
    "api_key",
    "accesstoken",
    "access_token",
    "clientsecret",
    "client_secret",
    "password",
    "secret",
    "secretkey",
    "secret_key",
];
const MAX_PROVIDER_ID_LENGTH: usize = 128;

enum ModelRouteError {
    NotFound,
    Conflict(&'static str),
    BadRequest(String),
    State(StateError),
}

impl From<StateError> for ModelRouteError {
    fn from(error: StateError) -> Self {
        match error {
            StateError::InvalidInput(message) => Self::BadRequest(message),
            other => Self::State(other),
        }
    }
}

impl ModelRouteError {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::NotFound => ApiError::not_found("Not found"),
            Self::Conflict(message) => ApiError::new(StatusCode::CONFLICT, message),
            Self::BadRequest(message) => ApiError::bad_request(message),
            Self::State(error) => {
                eprintln!("[ads-http] model state operation failed: {error}");
                ApiError::internal()
            }
        }
    }
}

struct ModelConfigPatch {
    model_id: Option<String>,
    display_name: Option<String>,
    provider: Option<String>,
    provider_id: Option<Option<String>>,
    is_enabled: Option<bool>,
    is_default: Option<bool>,
    config_json: Option<Option<Value>>,
}

impl ModelConfigPatch {
    fn from_create(request: CreateModelConfigRequest) -> Self {
        Self {
            model_id: Some(request.model_id),
            display_name: request.display_name,
            provider: Some(request.provider),
            provider_id: request.provider_id,
            is_enabled: request.is_enabled,
            is_default: request.is_default,
            config_json: request.config_json,
        }
    }

    fn from_update(request: UpdateModelConfigRequest) -> Self {
        Self {
            model_id: request.model_id,
            display_name: request.display_name,
            provider: request.provider,
            provider_id: request.provider_id,
            is_enabled: request.is_enabled,
            is_default: request.is_default,
            config_json: request.config_json,
        }
    }
}

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ModelConfig>>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let _user_id = session.user.id;

    let models = model_db(db, move |connection| {
        initialize_model_services(&connection)?;
        Ok(list_model_configs(&connection)?)
    })
    .await?;
    Ok(Json(models))
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<ModelConfig>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let request = read_json_payload::<CreateModelConfigRequest>(body, &state).await?;

    let patch = ModelConfigPatch::from_create(request);
    validate_patch(&patch, true)?;

    let db = state.auth.db().clone();
    let saved = model_db(db, move |mut connection| {
        initialize_model_services(&connection)?;
        let agent_model_id = normalize_model_config_id(patch.model_id.as_deref())
            .ok_or_else(|| ModelRouteError::BadRequest("Invalid model id".to_string()))?;
        let provider_id_ref = normalize_provider_id(patch.provider_id.clone().flatten());
        if let Some(provider_id) = provider_id_ref.as_deref() {
            if get_model_provider(&connection, provider_id)?.is_none() {
                return Err(ModelRouteError::BadRequest("Unknown provider".to_string()));
            }
        }

        let existing = get_model_config_by_agent_model_id(
            &connection,
            &agent_model_id,
            Some(provider_id_ref.as_deref()),
        )?;
        let id = existing
            .as_ref()
            .map(|model| model.id.clone())
            .unwrap_or_else(|| format!("model-{}", Uuid::new_v4()));
        let payload = build_payload(&id, &patch, existing.as_ref());
        Ok(upsert_model_config(
            &mut connection,
            &payload,
            now_unix_millis(),
        )?)
    })
    .await?;
    Ok(Json(saved))
}

pub(super) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
    body: Request,
) -> Result<Json<ModelConfig>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let request = read_json_payload::<UpdateModelConfigRequest>(body, &state).await?;

    let model_id = model_id.trim().to_string();
    let patch = ModelConfigPatch::from_update(request);
    validate_patch(&patch, false)?;

    let db = state.auth.db().clone();
    let saved = model_db(db, move |mut connection| {
        initialize_model_services(&connection)?;
        let existing =
            get_model_config(&connection, &model_id)?.ok_or(ModelRouteError::NotFound)?;

        let agent_model_id = match patch.model_id.as_deref() {
            Some(value) => normalize_model_config_id(Some(value))
                .ok_or_else(|| ModelRouteError::BadRequest("Invalid model id".to_string()))?,
            None => existing.model_id.clone(),
        };
        let provider_filter = match &patch.provider_id {
            Some(value) => normalize_provider_id(value.clone()),
            None => existing.provider_id.clone(),
        };
        let conflict = get_model_config_by_agent_model_id(
            &connection,
            &agent_model_id,
            Some(provider_filter.as_deref()),
        )?;
        if conflict.is_some_and(|conflict| conflict.id != model_id) {
            return Err(ModelRouteError::Conflict("Model ID already exists"));
        }

        let provider_id_ref = match &patch.provider_id {
            Some(value) => normalize_provider_id(value.clone()),
            None => None,
        };
        if let Some(provider_id) = provider_id_ref.as_deref() {
            if get_model_provider(&connection, provider_id)?.is_none() {
                return Err(ModelRouteError::BadRequest("Unknown provider".to_string()));
            }
        }

        let payload = build_payload(&model_id, &patch, Some(&existing));
        Ok(upsert_model_config(
            &mut connection,
            &payload,
            now_unix_millis(),
        )?)
    })
    .await?;
    Ok(Json(saved))
}

pub(super) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let model_id = model_id.trim().to_string();
    let remove_references = query
        .get("removeReferences")
        .is_some_and(|value| value == "true");

    let db = state.auth.db().clone();
    let success = model_db(db, move |mut connection| {
        initialize_model_services(&connection)?;
        let existing =
            get_model_config(&connection, &model_id)?.ok_or(ModelRouteError::NotFound)?;
        let services = list_model_services(&connection)?;
        if !remove_references
            && services
                .iter()
                .any(|service| service.model_ids.contains(&existing.id))
        {
            return Err(ModelRouteError::BadRequest(
                "Confirm removal from enabled services before deleting this model.".to_string(),
            ));
        }
        remove_model_service_references(&mut connection, &model_id, now_unix_millis())?;
        Ok(delete_model_config(&connection, &model_id)?)
    })
    .await?;

    Ok(Json(SuccessResponse { success }))
}

pub(super) async fn list_services(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ModelServiceSelection>>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let services = model_db(db, move |connection| {
        initialize_model_services(&connection)?;
        Ok(list_model_services(&connection)?)
    })
    .await?;
    Ok(Json(services))
}

pub(super) async fn save_service(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(service): Path<String>,
    body: Request,
) -> Result<Json<ModelServiceSelection>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let service = service.trim().to_string();
    if !MODEL_SERVICES.contains(&service.as_str()) {
        return Err(ApiError::not_found("Not Found"));
    }
    let request = read_json::<SaveModelServiceRequest>(body, &state)
        .await
        .map_err(|error| match error {
            JsonDecodeError::TooLarge => ApiError::bad_request("Request body too large"),
            JsonDecodeError::InvalidJson => ApiError::bad_request("Invalid JSON body"),
            JsonDecodeError::InvalidPayload => ApiError::bad_request("Invalid payload"),
        })?;
    let Some(default_model_id) = request.default_model_id else {
        return Err(ApiError::bad_request("Invalid payload"));
    };
    if request.model_ids.len() > 2_000
        || request.model_ids.iter().any(|id| id.is_empty())
        || default_model_id
            .as_deref()
            .is_some_and(|value| value.is_empty())
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }

    let db = state.auth.db().clone();
    let selection = model_db(db, move |mut connection| {
        initialize_model_services(&connection)?;
        Ok(save_model_service(
            &mut connection,
            &service,
            &request.model_ids,
            default_model_id.as_deref(),
        )?)
    })
    .await?;
    Ok(Json(selection))
}

pub(super) async fn list_conversation_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ModelConfig>>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let models = model_db(db, move |connection| {
        initialize_model_services(&connection)?;
        Ok(list_service_models(&connection, CONVERSATION_SERVICE)?)
    })
    .await?;
    Ok(Json(models))
}

fn validate_patch(patch: &ModelConfigPatch, create: bool) -> Result<(), ApiError> {
    if create && normalize(patch.model_id.as_deref()).is_none() {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    if patch
        .model_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    if patch
        .provider
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    if let Some(provider_id) = patch.provider_id.as_ref().and_then(Option::as_deref) {
        if provider_id.trim().chars().count() > MAX_PROVIDER_ID_LENGTH {
            return Err(ApiError::bad_request("Invalid payload"));
        }
    }
    if let Some(config_json) = patch.config_json.as_ref().and_then(Option::as_ref) {
        if !config_json.is_object() && !config_json.is_null() {
            return Err(ApiError::bad_request("Invalid payload"));
        }
        let mut path = Vec::new();
        if find_credential_key(config_json, &mut path).is_some() {
            return Err(ApiError::bad_request("Invalid payload"));
        }
    }
    Ok(())
}

fn find_credential_key(value: &Value, path: &mut Vec<String>) -> Option<String> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                if find_credential_key(item, path).is_some() {
                    return Some(path.join("."));
                }
                path.pop();
            }
            None
        }
        Value::Object(map) => {
            for (key, child) in map {
                if FORBIDDEN_CREDENTIAL_KEYS.contains(&key.trim().to_lowercase().as_str()) {
                    path.push(key.clone());
                    return Some(path.join("."));
                }
                path.push(key.clone());
                if find_credential_key(child, path).is_some() {
                    return Some(path.join("."));
                }
                path.pop();
            }
            None
        }
        _ => None,
    }
}

fn build_payload(
    id: &str,
    patch: &ModelConfigPatch,
    existing: Option<&ModelConfig>,
) -> ModelConfig {
    let agent_model_id = patch
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.map(|model| model.model_id.clone()))
        .unwrap_or_else(|| id.to_string());

    let display_name = patch
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            existing
                .map(|model| model.display_name.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| agent_model_id.clone());

    let provider = patch
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.map(|model| model.provider.clone()))
        .unwrap_or_default();

    let provider_id = match &patch.provider_id {
        Some(value) => normalize_provider_id(value.clone()),
        None => existing.and_then(|model| model.provider_id.clone()),
    };

    ModelConfig {
        id: id.to_string(),
        model_id: agent_model_id,
        display_name,
        provider,
        provider_id,
        is_enabled: patch
            .is_enabled
            .or_else(|| existing.map(|model| model.is_enabled))
            .unwrap_or(true),
        is_default: patch
            .is_default
            .or_else(|| existing.map(|model| model.is_default))
            .unwrap_or(false),
        config_json: match &patch.config_json {
            Some(value) => value.clone(),
            None => existing.and_then(|model| model.config_json.clone()),
        },
        updated_at: None,
    }
}

fn normalize_model_config_id(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("auto") {
        return None;
    }
    Some(value.to_string())
}

fn normalize_provider_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

async fn model_db<T, F>(db: ads_state::StateDb, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Connection) -> Result<T, ModelRouteError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || {
        let connection = db.connect().map_err(ModelRouteError::State)?;
        operation(connection)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] model worker failed: {error}");
        ApiError::internal()
    })?;
    result.map_err(ModelRouteError::into_api_error)
}
