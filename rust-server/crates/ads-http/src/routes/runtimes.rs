use ads_contract::projects::SuccessResponse;
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

use super::{read_json_payload, require_session};
use crate::AppState;
use crate::error::ApiError;
use crate::runtimes::{
    AgyAccountView, AgyLoginStartView, RuntimeAgentDescriptor, RuntimeApiError, RuntimeRegistry,
    UpsertAgyAccountInput,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimesSnapshotResponse {
    pub active_agent_id: String,
    pub agents: Vec<RuntimeAgentDescriptor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLoginRequest {
    code: String,
}

fn require_registry(state: &AppState) -> Result<&std::sync::Arc<RuntimeRegistry>, ApiError> {
    state.runtime_registry.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Runtime registry unavailable",
        )
    })
}

fn map_runtime_error(error: RuntimeApiError) -> ApiError {
    match error {
        RuntimeApiError::BadRequest(message) => ApiError::bad_request(message),
        RuntimeApiError::NotFound(message) => ApiError::not_found(message),
        RuntimeApiError::Conflict(message) => ApiError::new(StatusCode::CONFLICT, message),
        RuntimeApiError::Unavailable(message) => {
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, message)
        }
        RuntimeApiError::Internal(message) => {
            eprintln!("[ads-http] runtime operation failed: {message}");
            ApiError::internal()
        }
    }
}

pub(super) async fn list_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RuntimesSnapshotResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    if let Some(registry) = state.runtime_registry.as_ref() {
        return Ok(Json(RuntimesSnapshotResponse {
            active_agent_id: registry.default_active_agent_id(),
            agents: registry.list_agents(),
        }));
    }
    Ok(Json(RuntimesSnapshotResponse {
        active_agent_id: "codex".to_string(),
        agents: vec![RuntimeAgentDescriptor {
            id: "codex".to_string(),
            name: "Codex".to_string(),
            kind: "codex".to_string(),
            ready: true,
            error: None,
            account_id: None,
            auth_method: None,
            version: None,
        }],
    }))
}

pub(super) async fn refresh_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RuntimesSnapshotResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    registry.probe_all().await;
    Ok(Json(RuntimesSnapshotResponse {
        active_agent_id: registry.default_active_agent_id(),
        agents: registry.list_agents(),
    }))
}

pub(super) async fn list_agy_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AgyAccountView>>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    Ok(Json(registry.list_agy_accounts().await))
}

pub(super) async fn upsert_agy_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<AgyAccountView>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?.clone();
    let payload = read_json_payload::<UpsertAgyAccountInput>(body, &state).await?;
    let account = registry
        .create_or_update_agy_account(payload)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(account))
}

pub(super) async fn delete_agy_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    let success = registry
        .delete_agy_account(&account_id)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(SuccessResponse { success }))
}

pub(super) async fn start_agy_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Result<Json<AgyLoginStartView>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    let view = registry
        .start_agy_account_login(&account_id)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(view))
}

pub(super) async fn complete_agy_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
    body: Request,
) -> Result<Json<AgyAccountView>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?.clone();
    let payload = read_json_payload::<CompleteLoginRequest>(body, &state).await?;
    let view = registry
        .complete_agy_account_login(&account_id, &payload.code)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(view))
}

pub(super) async fn cancel_agy_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    let success = registry
        .cancel_agy_account_login(&account_id)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(SuccessResponse { success }))
}

pub(super) async fn logout_agy_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Result<Json<AgyAccountView>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    let view = registry
        .logout_agy_account(&account_id)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(view))
}

pub(super) async fn refresh_agy_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(account_id): Path<String>,
) -> Result<Json<AgyAccountView>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let registry = require_registry(&state)?;
    let view = registry
        .refresh_agy_account(&account_id)
        .await
        .map_err(map_runtime_error)?;
    Ok(Json(view))
}
