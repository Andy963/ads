use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use ads_contract::models::{
    CreateModelProviderRequest, ModelProvider, ModelProviderPayload, UpdateModelProviderRequest,
    UpstreamConfigResponse, UpstreamDiscoveryRequest, UpstreamDiscoveryResult,
};
use ads_contract::projects::SuccessResponse;
use ads_contract::time::now_unix_millis;
use ads_state::{
    StateDb, StateError, UpstreamCredentialStore, UpstreamCredentials, delete_model_provider,
    delete_model_provider_with_references, get_model_provider, initialize_model_services,
    list_model_configs, list_model_providers, list_model_services, normalize_upstream_base_url,
    reconcile_provider_models, upsert_model_provider,
};
use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::redirect::Policy;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{read_json_payload, read_request_bytes, require_session};
use crate::AppState;
use crate::error::ApiError;

const UPSTREAM_MODELS_CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const UPSTREAM_MODELS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROVIDER_NAME: usize = 128;
const MAX_PROVIDER_BASE_URL: usize = 2048;
const MAX_PROVIDER_WIRE_API: usize = 64;
const MAX_UPSTREAM_API_KEY: usize = 16_384;
const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Clone)]
struct UpstreamModelsCacheEntry {
    expires_at: i64,
    models: Vec<String>,
}

static UPSTREAM_MODELS_CACHE: OnceLock<Mutex<HashMap<String, UpstreamModelsCacheEntry>>> =
    OnceLock::new();

pub(super) async fn list_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ModelProviderPayload>>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let owner = session.user.id;
    let providers = spawn_db(db.clone(), move |connection| {
        let store = UpstreamCredentialStore::for_state_db(db.path());
        let providers = list_model_providers(&connection)?
            .into_iter()
            .map(|provider| {
                let has_credential =
                    provider_has_credential(&connection, &store, &owner, &provider);
                ModelProviderPayload {
                    provider,
                    has_credential,
                }
            })
            .collect();
        Ok(providers)
    })
    .await?;
    Ok(Json(providers))
}

pub(super) async fn create_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<ModelProviderPayload>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<CreateModelProviderRequest>(body, &state).await?;
    let patch = validate_create(request)?;
    let db = state.auth.db().clone();
    let owner = session.user.id;

    let payload = spawn_db(db.clone(), move |connection| {
        let base_url = normalize_upstream_base_url(&patch.base_url)?;
        let provider = upsert_model_provider(
            &connection,
            &ModelProvider {
                id: format!("provider-{}", Uuid::new_v4()),
                name: patch.name,
                base_url,
                credential_profile: None,
                wire_api: patch.wire_api,
                is_enabled: patch.is_enabled.unwrap_or(true),
                updated_at: None,
            },
            now_unix_millis(),
        )?;
        let store = UpstreamCredentialStore::for_state_db(db.path());
        if let Some(api_key) = patch.api_key.as_deref() {
            save_provider_credential(&connection, &store, &owner, &provider, api_key)?;
        }
        let has_credential = provider_has_credential(&connection, &store, &owner, &provider);
        Ok(ModelProviderPayload {
            provider,
            has_credential,
        })
    })
    .await?;
    Ok(Json(payload))
}

pub(super) async fn update_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    body: Request,
) -> Result<Json<ModelProviderPayload>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let provider_id = provider_id.trim().to_string();
    let request = read_json_payload::<UpdateModelProviderRequest>(body, &state).await?;
    let patch = validate_update(request)?;
    let db = state.auth.db().clone();
    let owner = session.user.id;

    let payload = spawn_db(db.clone(), move |connection| {
        let existing = get_model_provider(&connection, &provider_id)?
            .ok_or(ProviderRouteError::NotFound)?;
        let base_url = match patch.base_url.as_deref() {
            Some(value) => normalize_upstream_base_url(value)?,
            None => existing.base_url.clone(),
        };
        let store = UpstreamCredentialStore::for_state_db(db.path());
        if base_url != existing.base_url
            && patch.api_key.is_none()
            && provider_has_credential(&connection, &store, &owner, &existing)
        {
            return Err(ProviderRouteError::BadRequest(
                "Changing the provider endpoint requires re-entering its API key; saved keys are bound to their endpoint"
                    .to_string(),
            ));
        }
        let provider = upsert_model_provider(
            &connection,
            &ModelProvider {
                id: existing.id,
                name: patch.name.unwrap_or(existing.name),
                base_url,
                credential_profile: existing.credential_profile,
                wire_api: match patch.wire_api {
                    Some(value) => value,
                    None => existing.wire_api,
                },
                is_enabled: patch.is_enabled.unwrap_or(existing.is_enabled),
                updated_at: existing.updated_at,
            },
            now_unix_millis(),
        )?;
        if let Some(api_key) = patch.api_key.as_deref() {
            save_provider_credential(&connection, &store, &owner, &provider, api_key)?;
        }
        let has_credential = provider_has_credential(&connection, &store, &owner, &provider);
        Ok(ModelProviderPayload {
            provider,
            has_credential,
        })
    })
    .await?;
    Ok(Json(payload))
}

pub(super) async fn delete_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let provider_id = provider_id.trim().to_string();
    let remove_references = query
        .get("removeReferences")
        .is_some_and(|value| value == "true");
    let db = state.auth.db().clone();

    let success = spawn_db(db, move |mut connection| {
        let existing =
            get_model_provider(&connection, &provider_id)?.ok_or(ProviderRouteError::NotFound)?;
        initialize_model_services(&connection)?;
        let models = list_model_configs(&connection)?;
        let used = list_model_services(&connection)?.iter().any(|service| {
            service.model_ids.iter().any(|id| {
                models.iter().any(|model| {
                    model.id == *id && model.provider_id.as_deref() == Some(&existing.id)
                })
            })
        });
        if !remove_references && used {
            return Err(ProviderRouteError::Conflict(
                "Disable this provider's models in all services before deleting it.".to_string(),
            ));
        }
        if remove_references {
            delete_model_provider_with_references(&mut connection, &provider_id, now_unix_millis())
        } else {
            delete_model_provider(&mut connection, &provider_id)
        }
        .map_err(ProviderRouteError::State)
    })
    .await?;
    Ok(Json(SuccessResponse { success }))
}

pub(super) async fn sync_provider_models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let provider_id = provider_id.trim().to_string();
    let owner = session.user.id;
    let db = state.auth.db().clone();
    let db_for_read = db.clone();
    let (provider, credentials) = spawn_db(db.clone(), move |connection| {
        let provider = get_model_provider(&connection, &provider_id)?
            .filter(|provider| provider.is_enabled)
            .ok_or_else(|| {
                ProviderRouteError::BadRequest("Provider is missing or disabled.".to_string())
            })?;
        let store = UpstreamCredentialStore::for_state_db(db_for_read.path());
        let profile = provider
            .credential_profile
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&provider.id);
        let credentials = store
            .get_credentials(&connection, &owner, Some(profile))?
            .filter(|credentials| {
                normalize_upstream_base_url(&credentials.base_url).ok()
                    == normalize_upstream_base_url(&provider.base_url).ok()
            })
            .ok_or_else(|| {
                ProviderRouteError::BadRequest(
                    "Configure a matching provider API key first.".to_string(),
                )
            })?;
        Ok((provider, credentials))
    })
    .await?;

    let result = load_upstream_models_with_cache(&credentials, &provider.base_url, false).await;
    if !result.ok {
        return Err(ApiError::bad_request(
            result
                .error
                .unwrap_or_else(|| "Model sync failed.".to_string()),
        ));
    }

    let models = spawn_db(db, move |mut connection| {
        initialize_model_services(&connection)?;
        let now = now_unix_millis();
        Ok(reconcile_provider_models(
            &mut connection,
            &provider,
            &result.models,
            now,
        )?)
    })
    .await?;
    Ok(Json(json!({"ok": true, "models": models})))
}

pub(super) async fn upstream_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UpstreamConfigResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let owner = session.user.id;
    let db = state.auth.db().clone();
    let response = spawn_db(db.clone(), move |connection| {
        let store = UpstreamCredentialStore::for_state_db(db.path());
        if let Some(metadata) = store.get_metadata(&connection, &owner, None)? {
            return Ok(UpstreamConfigResponse {
                base_url: metadata.base_url,
                provider: metadata.provider,
                has_api_key: metadata.has_api_key,
                source: "saved".to_string(),
            });
        }
        Ok(match resolve_codex_fallback() {
            Ok(config) => match normalize_upstream_base_url(&config.base_url) {
                Ok(base_url) => UpstreamConfigResponse {
                    base_url,
                    provider: "openai".to_string(),
                    has_api_key: config.api_key.is_some(),
                    source: if config.api_key.is_some() {
                        "server".to_string()
                    } else {
                        "none".to_string()
                    },
                },
                Err(_) => none_upstream_config(),
            },
            _ => none_upstream_config(),
        })
    })
    .await?;
    Ok(Json(response))
}

pub(super) async fn discover_upstream(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Response {
    let session = match require_session(&state, &headers).await {
        Ok(session) => session,
        Err(error) => return error.into_response(),
    };
    let body = match read_request_bytes(body, &state).await {
        Ok(body) => body,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(discovery_error("Invalid JSON payload")),
            )
                .into_response();
        }
    };
    let input = match parse_discovery_body(&body) {
        Ok(input) => input,
        Err(message) => {
            return (StatusCode::BAD_REQUEST, Json(discovery_error(message))).into_response();
        }
    };
    let owner = session.user.id;
    let db = state.auth.db().clone();
    let owner_for_resolve = owner.clone();
    let resolved = spawn_db(db.clone(), move |connection| {
        let store = UpstreamCredentialStore::for_state_db(db.path());
        resolve_discovery_credentials(&connection, &store, &owner_for_resolve, &input)
    })
    .await;
    let (config, profile) = match resolved {
        Ok(value) => value,
        Err(error) => {
            let message = error.message().to_string();
            return Json(discovery_error(&message)).into_response();
        }
    };
    let result = load_upstream_models(&config, &config.base_url).await;
    if result.ok {
        let profile = profile.clone();
        let config = config.clone();
        let db_for_save = state.auth.db().clone();
        let save = spawn_db(db_for_save.clone(), move |connection| {
            let store = UpstreamCredentialStore::for_state_db(db_for_save.path());
            store
                .save(&connection, &owner, &config, profile.as_deref())
                .map_err(ProviderRouteError::State)
        })
        .await;
        if let Err(error) = save {
            return Json(discovery_error(error.message())).into_response();
        }
    }
    Json(result).into_response()
}

pub(super) async fn discover_saved_upstream(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UpstreamDiscoveryResult>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let owner = session.user.id;
    let db = state.auth.db().clone();
    let resolved = spawn_db(db.clone(), move |connection| {
        let store = UpstreamCredentialStore::for_state_db(db.path());
        resolve_discovery_credentials(&connection, &store, &owner, &DiscoveryInput::default())
    })
    .await;
    let (config, _) = match resolved {
        Ok(value) => value,
        Err(error) => return Ok(Json(discovery_error(&error_message(error)))),
    };
    Ok(Json(load_upstream_models(&config, &config.base_url).await))
}

#[derive(Debug, Default)]
struct DiscoveryInput {
    base_url: Option<String>,
    api_key: Option<String>,
    provider: Option<String>,
    credential_profile: Option<String>,
}

fn validate_create(request: CreateModelProviderRequest) -> Result<CreateProviderPatch, ApiError> {
    if request.is_enabled.as_ref().is_some_and(Option::is_none)
        || request.api_key.as_ref().is_some_and(Option::is_none)
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    let name = validate_provider_name(&request.name)?;
    let base_url = validate_provider_base_url(&request.base_url)?;
    let wire_api = match request.wire_api {
        Some(Some(value)) => Some(validate_wire_api(&value)?),
        Some(None) | None => None,
    };
    let api_key = match request.api_key.flatten() {
        Some(value) => Some(validate_api_key(&value)?),
        None => None,
    };
    Ok(CreateProviderPatch {
        name,
        base_url,
        wire_api,
        is_enabled: request.is_enabled.flatten(),
        api_key,
    })
}

fn validate_update(request: UpdateModelProviderRequest) -> Result<UpdateProviderPatch, ApiError> {
    if request.name.as_ref().is_some_and(Option::is_none)
        || request.base_url.as_ref().is_some_and(Option::is_none)
        || request.is_enabled.as_ref().is_some_and(Option::is_none)
        || request.api_key.as_ref().is_some_and(Option::is_none)
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    let name = match request.name.flatten() {
        Some(value) => Some(validate_provider_name(&value)?),
        None => None,
    };
    let base_url = match request.base_url.flatten() {
        Some(value) => Some(validate_provider_base_url(&value)?),
        None => None,
    };
    let wire_api = match request.wire_api {
        Some(Some(value)) => Some(Some(validate_wire_api(&value)?)),
        Some(None) => Some(None),
        None => None,
    };
    let api_key = match request.api_key.flatten() {
        Some(value) => Some(validate_api_key(&value)?),
        None => None,
    };
    Ok(UpdateProviderPatch {
        name,
        base_url,
        wire_api,
        is_enabled: request.is_enabled.flatten(),
        api_key,
    })
}

fn parse_discovery_body(body: &[u8]) -> Result<DiscoveryInput, &'static str> {
    let value: Value = if body.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Default::default())
    } else {
        let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid JSON payload")?;
        if value.is_null() {
            Value::Object(Default::default())
        } else {
            value
        }
    };
    let request: UpstreamDiscoveryRequest =
        serde_json::from_value(value).map_err(|_| "Invalid upstream discovery payload")?;
    validate_discovery(request).map_err(|_| "Invalid upstream discovery payload")
}

fn validate_discovery(request: UpstreamDiscoveryRequest) -> Result<DiscoveryInput, ApiError> {
    if request.base_url.as_ref().is_some_and(Option::is_none)
        || request.api_key.as_ref().is_some_and(Option::is_none)
        || request.provider.as_ref().is_some_and(Option::is_none)
        || request
            .credential_profile
            .as_ref()
            .is_some_and(Option::is_none)
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    let base_url = match request.base_url.flatten() {
        Some(value) => Some(validate_provider_base_url(&value)?),
        None => None,
    };
    let api_key = match request.api_key.flatten() {
        Some(value) => Some(validate_api_key(&value)?),
        None => None,
    };
    let provider = match request.provider.flatten() {
        Some(value) => Some(validate_provider_name(&value)?),
        None => None,
    };
    let credential_profile = match request.credential_profile.flatten() {
        Some(value) => {
            let value = value.trim().to_string();
            if utf16_len(&value) > 128 {
                return Err(ApiError::bad_request("Invalid payload"));
            }
            Some(value)
        }
        None => None,
    };
    Ok(DiscoveryInput {
        base_url,
        api_key,
        provider,
        credential_profile,
    })
}

struct CreateProviderPatch {
    name: String,
    base_url: String,
    wire_api: Option<String>,
    is_enabled: Option<bool>,
    api_key: Option<String>,
}

struct UpdateProviderPatch {
    name: Option<String>,
    base_url: Option<String>,
    wire_api: Option<Option<String>>,
    is_enabled: Option<bool>,
    api_key: Option<String>,
}

fn validate_provider_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || utf16_len(value) > MAX_PROVIDER_NAME {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    Ok(value.to_string())
}

fn validate_provider_base_url(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || utf16_len(value) > MAX_PROVIDER_BASE_URL {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    Ok(value.to_string())
}

fn validate_wire_api(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if utf16_len(value) > MAX_PROVIDER_WIRE_API {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    Ok(value.to_string())
}

fn validate_api_key(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || utf16_len(value) > MAX_UPSTREAM_API_KEY {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    Ok(value.to_string())
}

fn provider_credential_profile(provider: &ModelProvider) -> &str {
    provider
        .credential_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&provider.id)
}

fn save_provider_credential(
    connection: &Connection,
    store: &UpstreamCredentialStore,
    owner: &str,
    provider: &ModelProvider,
    api_key: &str,
) -> Result<(), ProviderRouteError> {
    store
        .save(
            connection,
            owner,
            &UpstreamCredentials {
                base_url: provider.base_url.clone(),
                provider: provider.id.clone(),
                api_key: api_key.to_string(),
            },
            Some(provider_credential_profile(provider)),
        )
        .map_err(ProviderRouteError::State)
}

fn provider_has_credential(
    connection: &Connection,
    store: &UpstreamCredentialStore,
    owner: &str,
    provider: &ModelProvider,
) -> bool {
    let Ok(Some(metadata)) = store.get_metadata(
        connection,
        owner,
        Some(provider_credential_profile(provider)),
    ) else {
        return false;
    };
    metadata.has_api_key
        && normalize_upstream_base_url(&metadata.base_url).ok()
            == normalize_upstream_base_url(&provider.base_url).ok()
}

fn resolve_discovery_credentials(
    connection: &Connection,
    store: &UpstreamCredentialStore,
    owner: &str,
    input: &DiscoveryInput,
) -> Result<(UpstreamCredentials, Option<String>), ProviderRouteError> {
    let profile = input.credential_profile.clone();
    if input.base_url.is_some() && input.api_key.is_some() {
        let base_url = normalize_upstream_base_url(input.base_url.as_deref().unwrap_or_default())?;
        return Ok((
            UpstreamCredentials {
                base_url,
                provider: input
                    .provider
                    .clone()
                    .unwrap_or_else(|| "openai".to_string()),
                api_key: input.api_key.clone().unwrap_or_default(),
            },
            profile,
        ));
    }

    let saved = store.get_metadata(connection, owner, profile.as_deref())?;
    let fallback = if saved.is_some() {
        None
    } else {
        Some(resolve_codex_fallback()?)
    };
    let configured_url = saved
        .as_ref()
        .map(|value| value.base_url.clone())
        .or_else(|| fallback.as_ref().map(|value| value.base_url.clone()))
        .ok_or_else(|| {
            ProviderRouteError::BadRequest(
                "Upstream model discovery requires an API key and base URL".to_string(),
            )
        })?;
    let base_url =
        normalize_upstream_base_url(input.base_url.as_deref().unwrap_or(&configured_url))?;
    if input.api_key.is_none() && base_url != normalize_upstream_base_url(&configured_url)? {
        return Err(ProviderRouteError::BadRequest(
            "Enter an API key for the changed upstream endpoint; saved keys are bound to their endpoint"
                .to_string(),
        ));
    }
    let api_key = input
        .api_key
        .clone()
        .or_else(|| {
            saved.as_ref().and_then(|_| {
                store
                    .get_credentials(connection, owner, profile.as_deref())
                    .ok()
                    .flatten()
                    .map(|value| value.api_key)
            })
        })
        .or_else(|| fallback.as_ref().and_then(|value| value.api_key.clone()))
        .ok_or_else(|| {
            ProviderRouteError::BadRequest(
                "Upstream model discovery requires an API key and base URL".to_string(),
            )
        })?;
    Ok((
        UpstreamCredentials {
            base_url,
            provider: input
                .provider
                .clone()
                .or_else(|| saved.as_ref().map(|value| value.provider.clone()))
                .unwrap_or_else(|| "openai".to_string()),
            api_key,
        },
        profile,
    ))
}

async fn load_upstream_models(
    config: &UpstreamCredentials,
    base_url: &str,
) -> UpstreamDiscoveryResult {
    load_upstream_models_with_cache(config, base_url, true).await
}

async fn load_upstream_models_with_cache(
    config: &UpstreamCredentials,
    base_url: &str,
    use_cache: bool,
) -> UpstreamDiscoveryResult {
    if config.api_key.is_empty() || base_url.is_empty() {
        return discovery_error("Upstream model discovery requires an API key and base URL");
    }
    let endpoint = match build_models_endpoint(base_url) {
        Ok(value) => value,
        Err(error) => return discovery_error(&error.to_string()),
    };
    let cache_key = upstream_cache_key(&endpoint, &config.api_key);
    let now = now_unix_millis();
    if use_cache && let Some(models) = cached_upstream_models(&cache_key, now) {
        return UpstreamDiscoveryResult {
            ok: true,
            models,
            error: None,
        };
    }

    let client = match reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(UPSTREAM_MODELS_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return discovery_error(&error.to_string()),
    };
    let response = match client
        .get(&endpoint)
        .bearer_auth(&config.api_key)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return discovery_error(&error.to_string().replace(&config.api_key, "[redacted]"));
        }
    };
    if !response.status().is_success() {
        return discovery_error(&format!(
            "Upstream model endpoint returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(error) => {
            return discovery_error(&error.to_string().replace(&config.api_key, "[redacted]"));
        }
    };
    let Some(models) = parse_upstream_models(&body) else {
        return discovery_error("Invalid upstream model response");
    };
    if let Ok(mut cache) = UPSTREAM_MODELS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(
            cache_key,
            UpstreamModelsCacheEntry {
                expires_at: now + UPSTREAM_MODELS_CACHE_TTL_MS,
                models: models.clone(),
            },
        );
    }
    UpstreamDiscoveryResult {
        ok: true,
        models,
        error: None,
    }
}

fn parse_upstream_models(body: &Value) -> Option<Vec<String>> {
    let data = body.get("data")?.as_array()?;
    let mut models = BTreeSet::new();
    for entry in data {
        let Some(model_id) = entry.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if !model_id.is_empty() {
            models.insert(model_id.to_string());
        }
    }
    Some(models.into_iter().collect())
}

fn build_models_endpoint(base_url: &str) -> Result<String, StateError> {
    Ok(format!("{}/models", normalize_upstream_base_url(base_url)?))
}

fn upstream_cache_key(endpoint: &str, api_key: &str) -> String {
    let fingerprint = Sha256::digest(api_key.as_bytes());
    format!("{endpoint}\0{}", hex::encode(fingerprint))
}

fn cached_upstream_models(cache_key: &str, now: i64) -> Option<Vec<String>> {
    let mut cache = UPSTREAM_MODELS_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    if cache
        .get(cache_key)
        .is_some_and(|entry| entry.expires_at <= now)
    {
        cache.remove(cache_key);
    }
    cache.get(cache_key).map(|entry| entry.models.clone())
}

#[derive(Debug, Clone)]
struct CodexFallbackConfig {
    base_url: String,
    api_key: Option<String>,
}

#[derive(Debug, Default)]
struct CodexFiles {
    base_url: Option<String>,
    api_key: Option<String>,
    has_device_auth_tokens: bool,
}

fn resolve_codex_fallback() -> Result<CodexFallbackConfig, ProviderRouteError> {
    let env_api_key =
        first_non_empty_env(&["CODEX_API_KEY", "OPENAI_API_KEY", "CCHAT_OPENAI_API_KEY"]);
    let env_base_url =
        first_non_empty_env(&["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"]);
    let files = load_codex_files();
    let api_key = env_api_key.or(files.api_key);
    if api_key.is_none() && !files.has_device_auth_tokens {
        return Err(ProviderRouteError::BadRequest(format!(
            "Codex credentials not found. Provide --api-key (or CODEX_API_KEY), or sign in with `codex login` to use saved access/refresh tokens in {}/auth.json.",
            codex_home_dir().display()
        )));
    }
    let base_url = env_base_url
        .or(files.base_url)
        .or_else(|| Some(DEFAULT_OPENAI_BASE_URL.to_string()));
    Ok(CodexFallbackConfig {
        base_url: base_url.unwrap_or_else(|| DEFAULT_OPENAI_BASE_URL.to_string()),
        api_key,
    })
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

fn codex_home_dir() -> std::path::PathBuf {
    let raw = std::env::var("CODEX_HOME").unwrap_or_default();
    let raw = raw.trim();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    if raw.is_empty() {
        return home.join(".codex");
    }
    if raw == "~" {
        return home;
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.join(rest);
    }
    let path = std::path::PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(path)
    }
}

fn load_codex_files() -> CodexFiles {
    load_codex_files_from_home(&codex_home_dir())
}

fn load_codex_files_from_home(home: &std::path::Path) -> CodexFiles {
    let mut result = CodexFiles::default();

    if let Ok(raw) = std::fs::read_to_string(home.join("config.toml")) {
        if let Ok(parsed) = raw.parse::<toml::Value>() {
            let providers = parsed
                .get("model_providers")
                .and_then(toml::Value::as_table);
            let provider_key = parsed
                .get("model_provider")
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .trim();
            if !provider_key.is_empty() {
                if let Some(section) = providers
                    .and_then(|providers| providers.get(provider_key))
                    .and_then(toml::Value::as_table)
                {
                    result.base_url = section
                        .get("base_url")
                        .and_then(toml::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    result.api_key = section
                        .get("api_key")
                        .and_then(toml::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                }
            }
            if result.base_url.is_none() {
                result.base_url = providers.and_then(|providers| {
                    providers.values().find_map(|provider| {
                        provider
                            .as_table()
                            .and_then(|section| section.get("base_url"))
                            .and_then(toml::Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                    })
                });
            }
        }
    }

    if let Ok(raw) = std::fs::read_to_string(home.join("auth.json")) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            if result.api_key.is_none() {
                result.api_key = parsed
                    .get("OPENAI_API_KEY")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
            }
            result.has_device_auth_tokens = parsed
                .get("tokens")
                .and_then(Value::as_object)
                .is_some_and(|tokens| {
                    tokens.get("access_token").is_some_and(Value::is_string)
                        && tokens.get("refresh_token").is_some_and(Value::is_string)
                });
        }
    }

    result
}

fn none_upstream_config() -> UpstreamConfigResponse {
    UpstreamConfigResponse {
        base_url: String::new(),
        provider: "openai".to_string(),
        has_api_key: false,
        source: "none".to_string(),
    }
}

fn discovery_error(message: &str) -> UpstreamDiscoveryResult {
    UpstreamDiscoveryResult {
        ok: false,
        models: Vec::new(),
        error: Some(message.to_string()),
    }
}

fn error_message(error: ApiError) -> String {
    error.message().to_string()
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

async fn spawn_db<T, F>(db: StateDb, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Connection) -> Result<T, ProviderRouteError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || {
        let connection = db.connect().map_err(ProviderRouteError::State)?;
        operation(connection)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] provider worker failed: {error}");
        ApiError::internal()
    })?;
    result.map_err(ProviderRouteError::into_api_error)
}

enum ProviderRouteError {
    NotFound,
    Conflict(String),
    BadRequest(String),
    State(StateError),
}

impl From<StateError> for ProviderRouteError {
    fn from(error: StateError) -> Self {
        match error {
            StateError::InvalidInput(message) => Self::BadRequest(message),
            other => Self::State(other),
        }
    }
}

impl ProviderRouteError {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::NotFound => ApiError::not_found("Not found"),
            Self::Conflict(message) => ApiError::new(axum::http::StatusCode::CONFLICT, message),
            Self::BadRequest(message) => ApiError::bad_request(message),
            Self::State(error) => {
                eprintln!("[ads-http] provider state operation failed: {error}");
                ApiError::internal()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_selected_codex_provider_and_prefers_config_key() {
        let directory = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            directory.path().join("config.toml"),
            r#"
model_provider = "custom"

[model_providers.custom]
base_url = "https://custom.example/v1"
api_key = "config-key"

[model_providers.other]
base_url = "https://other.example/v1"
"#,
        )
        .expect("config");
        std::fs::write(
            directory.path().join("auth.json"),
            r#"{"OPENAI_API_KEY":"auth-key"}"#,
        )
        .expect("auth");

        let files = load_codex_files_from_home(directory.path());
        assert_eq!(files.base_url.as_deref(), Some("https://custom.example/v1"));
        assert_eq!(files.api_key.as_deref(), Some("config-key"));
        assert!(!files.has_device_auth_tokens);
    }

    #[test]
    fn falls_back_to_first_provider_auth_key_and_device_tokens() {
        let directory = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            directory.path().join("config.toml"),
            r#"
[model_providers.first]
base_url = "https://first.example/v1"

[model_providers.second]
base_url = "https://second.example/v1"
"#,
        )
        .expect("config");
        std::fs::write(
            directory.path().join("auth.json"),
            r#"{"OPENAI_API_KEY":"auth-key","tokens":{"access_token":"a","refresh_token":"r"}}"#,
        )
        .expect("auth");

        let files = load_codex_files_from_home(directory.path());
        assert_eq!(files.base_url.as_deref(), Some("https://first.example/v1"));
        assert_eq!(files.api_key.as_deref(), Some("auth-key"));
        assert!(files.has_device_auth_tokens);
    }

    #[test]
    fn ignores_malformed_codex_files() {
        let directory = tempfile::tempdir().expect("temp dir");
        std::fs::write(directory.path().join("config.toml"), "not = [valid").expect("config");
        std::fs::write(directory.path().join("auth.json"), "{").expect("auth");

        let files = load_codex_files_from_home(directory.path());
        assert!(files.base_url.is_none());
        assert!(files.api_key.is_none());
        assert!(!files.has_device_auth_tokens);
    }
}
