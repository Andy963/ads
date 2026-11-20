use ads_contract::role_profiles::{RoleProfile, UpdateRoleProfileRequest};
use ads_contract::time::now_unix_millis;
use ads_state::{
    REASONING_EFFORTS, SaveRoleProfile, StateError, get_role_profile_by_id,
    initialize_model_services, list_role_profiles, resolve_conversation_model, save_role_profile,
};
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::HeaderMap;

use super::{JsonDecodeError, read_json, require_session};
use crate::AppState;
use crate::error::ApiError;

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoleProfile>>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let profiles = tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        list_role_profiles(&connection, None)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] role profile worker failed: {error}");
        ApiError::internal()
    })?
    .map_err(map_state_error)?;
    Ok(Json(profiles))
}

pub(super) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(profile_id): Path<String>,
    body: Request,
) -> Result<Json<RoleProfile>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    let profile_id = profile_id.trim().to_string();
    let request = read_json::<UpdateRoleProfileRequest>(body, &state)
        .await
        .map_err(|error| match error {
            JsonDecodeError::InvalidPayload => ApiError::bad_request("Invalid payload"),
            JsonDecodeError::TooLarge | JsonDecodeError::InvalidJson => {
                ApiError::bad_request("Invalid JSON body")
            }
        })?;
    let patch = validate_patch(request)?;

    let db = state.auth.db().clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut connection = db.connect().map_err(ProfileRouteError::State)?;
        initialize_model_services(&connection).map_err(ProfileRouteError::State)?;
        let Some(existing) =
            get_role_profile_by_id(&connection, &profile_id).map_err(ProfileRouteError::State)?
        else {
            return Err(ProfileRouteError::NotFound);
        };
        let model_id = match patch.model_id.as_deref() {
            Some(reference) => {
                resolve_conversation_model(&connection, reference)
                    .map_err(ProfileRouteError::State)?
                    .id
            }
            None => existing.model_id,
        };
        save_role_profile(
            &mut connection,
            SaveRoleProfile {
                id: &existing.id,
                role: &existing.role,
                name: patch.name.as_deref().unwrap_or(&existing.name),
                model_id: &model_id,
                reasoning_effort: patch
                    .reasoning_effort
                    .as_deref()
                    .unwrap_or(&existing.reasoning_effort),
                system_prompt: patch
                    .system_prompt
                    .as_deref()
                    .unwrap_or(&existing.system_prompt),
                is_enabled: patch.is_enabled.unwrap_or(existing.is_enabled != 0),
                is_default: patch.is_default.unwrap_or(existing.is_default != 0),
            },
            now_unix_millis(),
        )
        .map_err(ProfileRouteError::State)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] role profile worker failed: {error}");
        ApiError::internal()
    })?;

    Ok(Json(result.map_err(ProfileRouteError::into_api_error)?))
}

struct RoleProfilePatch {
    name: Option<String>,
    model_id: Option<String>,
    reasoning_effort: Option<String>,
    system_prompt: Option<String>,
    is_enabled: Option<bool>,
    is_default: Option<bool>,
}

fn validate_patch(request: UpdateRoleProfileRequest) -> Result<RoleProfilePatch, ApiError> {
    let invalid = || ApiError::bad_request("Invalid payload");
    if request.name.as_ref().is_some_and(Option::is_none)
        || request.model_id.as_ref().is_some_and(Option::is_none)
        || request
            .reasoning_effort
            .as_ref()
            .is_some_and(Option::is_none)
        || request.system_prompt.as_ref().is_some_and(Option::is_none)
        || request.is_enabled.as_ref().is_some_and(Option::is_none)
        || request.is_default.as_ref().is_some_and(Option::is_none)
    {
        return Err(invalid());
    }

    let reasoning_effort = request.reasoning_effort.flatten();
    if reasoning_effort
        .as_deref()
        .is_some_and(|value| !REASONING_EFFORTS.contains(&value))
    {
        return Err(invalid());
    }

    let system_prompt = match request.system_prompt.flatten() {
        Some(value) => {
            let value = value.trim().to_string();
            if value.is_empty() || value.encode_utf16().count() > 100_000 {
                return Err(invalid());
            }
            Some(value)
        }
        None => None,
    };

    Ok(RoleProfilePatch {
        name: request.name.flatten(),
        model_id: request.model_id.flatten(),
        reasoning_effort,
        system_prompt,
        is_enabled: request.is_enabled.flatten(),
        is_default: request.is_default.flatten(),
    })
}

enum ProfileRouteError {
    NotFound,
    State(StateError),
}

impl ProfileRouteError {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::NotFound => ApiError::not_found("Role profile not found"),
            Self::State(error) => map_state_error(error),
        }
    }
}

fn map_state_error(error: StateError) -> ApiError {
    match error {
        StateError::InvalidInput(message) => ApiError::bad_request(message),
        other => {
            eprintln!("[ads-http] role profile state operation failed: {other}");
            ApiError::internal()
        }
    }
}
