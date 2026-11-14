use ads_contract::schedule::ScheduleSpec;
use ads_contract::time::now_unix_millis;
use ads_runtime::scheduler::{
    ScheduleCompileRequest, compute_next_cron_run_at, normalize_compiled_schedule_spec,
};
use ads_state::{
    CreateSchedule, ScheduleStore, StoredSchedule, UpdateSchedule, derive_workspace_state_id,
};
use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::{read_json_payload, require_session, run_workspace_db};
use crate::AppState;
use crate::error::ApiError;
use crate::paths::validate_workspace_path;

#[derive(Debug, Default, Deserialize)]
pub struct ScheduleQuery {
    workspace: Option<String>,
    limit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateScheduleBody {
    instruction: String,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateScheduleBody {
    instruction: String,
}

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ScheduleQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state, &headers).await?;
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let limit = parse_limit(query.limit.as_deref());
    let schedules = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).list_schedules(limit)
    })
    .await?;
    Ok(Json(json!({ "schedules": schedules })))
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ScheduleQuery>,
    body: Request,
) -> Result<Response, ApiError> {
    let session = require_session(&state, &headers).await?;
    let body = read_json_payload::<CreateScheduleBody>(body, &state).await?;
    let instruction = body.instruction.trim().to_string();
    if instruction.is_empty() {
        return Err(ApiError::bad_request("instruction is required"));
    }
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let compiled =
        compile_schedule(&state, &session.user.id, &workspace_root, &instruction).await?;
    let compiled = normalize_compiled_schedule_spec(compiled, &instruction);
    let now = now_unix_millis();
    let (spec, enabled, next_run_at) =
        resolve_compiled_schedule(compiled, &instruction, body.enabled.unwrap_or(true), now);
    let schedule = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).create_schedule(
            CreateSchedule {
                instruction,
                spec: Some(spec),
                enabled,
                next_run_at,
            },
            now,
        )
    })
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "schedule": schedule }))).into_response())
}

pub(super) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Query(query): Query<ScheduleQuery>,
    body: Request,
) -> Result<Response, ApiError> {
    let session = require_session(&state, &headers).await?;
    let body = read_json_payload::<UpdateScheduleBody>(body, &state).await?;
    let instruction = body.instruction.trim().to_string();
    if instruction.is_empty() {
        return Err(ApiError::bad_request("instruction is required"));
    }
    let schedule_id = schedule_id.trim().to_string();
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let existing = get_schedule(&state, &workspace_id, &schedule_id).await?;
    let Some(existing) = existing else {
        return Ok(not_found());
    };
    let compiled =
        compile_schedule(&state, &session.user.id, &workspace_root, &instruction).await?;
    let compiled = normalize_compiled_schedule_spec(compiled, &instruction);
    let now = now_unix_millis();
    let (spec, enabled, next_run_at) =
        resolve_compiled_schedule(compiled, &instruction, existing.enabled, now);
    let updated = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).update_schedule(
            &schedule_id,
            UpdateSchedule {
                instruction: Some(instruction),
                spec: Some(spec),
                enabled: Some(enabled),
                next_run_at: Some(next_run_at),
                lease_owner: Some(None),
                lease_until: Some(None),
            },
            now,
        )
    })
    .await?;
    Ok(Json(json!({ "schedule": updated })).into_response())
}

pub(super) async fn enable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Query(query): Query<ScheduleQuery>,
) -> Result<Response, ApiError> {
    require_session(&state, &headers).await?;
    let schedule_id = schedule_id.trim().to_string();
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let existing = get_schedule(&state, &workspace_id, &schedule_id).await?;
    let Some(existing) = existing else {
        return Ok(not_found());
    };
    if !existing.spec.questions.is_empty() {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Schedule requires clarification before enabling",
                "questions": existing.spec.questions,
            })),
        )
            .into_response());
    }
    let now = now_unix_millis();
    let next_run_at = match compute_next_cron_run_at(
        &existing.spec.schedule.cron,
        &existing.spec.schedule.timezone,
        now,
    ) {
        Ok(value) => value,
        Err(_) => {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({ "error": "Cron expression is not supported by runtime" })),
            )
                .into_response());
        }
    };
    let mut spec = existing.spec;
    spec.enabled = true;
    let updated = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).update_schedule(
            &schedule_id,
            UpdateSchedule {
                spec: Some(spec),
                enabled: Some(true),
                next_run_at: Some(Some(next_run_at)),
                lease_owner: Some(None),
                lease_until: Some(None),
                ..UpdateSchedule::default()
            },
            now,
        )
    })
    .await?;
    Ok(Json(json!({ "schedule": updated })).into_response())
}

pub(super) async fn disable(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Query(query): Query<ScheduleQuery>,
) -> Result<Response, ApiError> {
    require_session(&state, &headers).await?;
    let schedule_id = schedule_id.trim().to_string();
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let existing = get_schedule(&state, &workspace_id, &schedule_id).await?;
    let Some(existing) = existing else {
        return Ok(not_found());
    };
    let mut spec = existing.spec;
    spec.enabled = false;
    let now = now_unix_millis();
    let updated = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).update_schedule(
            &schedule_id,
            UpdateSchedule {
                spec: Some(spec),
                enabled: Some(false),
                next_run_at: Some(None),
                lease_owner: Some(None),
                lease_until: Some(None),
                ..UpdateSchedule::default()
            },
            now,
        )
    })
    .await?;
    Ok(Json(json!({ "schedule": updated })).into_response())
}

pub(super) async fn runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Query(query): Query<ScheduleQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_session(&state, &headers).await?;
    let (workspace_root, workspace_id) = resolve_workspace(&state, &query)?;
    register_workspace(&state, &workspace_root);
    let limit = parse_limit(query.limit.as_deref());
    let schedule_id = schedule_id.trim().to_string();
    let runs = run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).list_runs(&schedule_id, limit)
    })
    .await?;
    Ok(Json(json!({ "runs": runs })))
}

fn resolve_workspace(
    state: &AppState,
    query: &ScheduleQuery,
) -> Result<(String, String), ApiError> {
    let raw = query.workspace.as_deref().unwrap_or_default().trim();
    let workspace_root = if raw.is_empty() {
        state.default_workspace_root.to_string_lossy().to_string()
    } else {
        let validated =
            validate_workspace_path(raw, &state.allowed_dirs, false).map_err(|failure| {
                let message = match failure {
                    crate::paths::PathValidationFailure::MissingPath => {
                        "Workspace path is required".to_string()
                    }
                    crate::paths::PathValidationFailure::NotAllowed => {
                        "Workspace is not allowed".to_string()
                    }
                    crate::paths::PathValidationFailure::NotExists => {
                        format!("Workspace does not exist: {raw}")
                    }
                    crate::paths::PathValidationFailure::NotDirectory => {
                        format!("Workspace is not a directory: {raw}")
                    }
                };
                ApiError::bad_request(message)
            })?;
        validated.workspace_root.to_string_lossy().to_string()
    };
    let workspace_id = derive_workspace_state_id(&workspace_root);
    Ok((workspace_root, workspace_id))
}

fn register_workspace(state: &AppState, workspace_root: &str) {
    if let Some(scheduler) = state.scheduler.as_ref() {
        scheduler.register_workspace(workspace_root);
    }
}

fn parse_limit(raw: Option<&str>) -> Option<i64> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok())
}

async fn get_schedule(
    state: &AppState,
    workspace_id: &str,
    schedule_id: &str,
) -> Result<Option<StoredSchedule>, ApiError> {
    let workspace_id = workspace_id.to_string();
    let schedule_id = schedule_id.to_string();
    run_workspace_db(state.workspace_db.clone(), move |connection| {
        ScheduleStore::new(&connection, &workspace_id).get_schedule(&schedule_id)
    })
    .await
}

async fn compile_schedule(
    state: &AppState,
    owner: &str,
    workspace_root: &str,
    instruction: &str,
) -> Result<ScheduleSpec, ApiError> {
    let compiler = state
        .schedule_compiler
        .as_ref()
        .ok_or_else(ApiError::internal)?;
    compiler
        .compile(ScheduleCompileRequest {
            owner,
            workspace_root,
            instruction,
        })
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error))
}

fn resolve_compiled_schedule(
    compiled: ScheduleSpec,
    instruction: &str,
    enable_requested: bool,
    now: i64,
) -> (ScheduleSpec, bool, Option<i64>) {
    let mut enabled = enable_requested && compiled.enabled && compiled.questions.is_empty();
    let mut next_run_at = None;
    let mut spec = compiled;
    spec.instruction = instruction.to_string();
    spec.enabled = enabled;
    if enabled {
        match compute_next_cron_run_at(&spec.schedule.cron, &spec.schedule.timezone, now) {
            Ok(value) => next_run_at = Some(value),
            Err(_) => {
                enabled = false;
                spec.enabled = false;
                spec.questions.push(format!(
                    "Cron expression is not supported by runtime: {}",
                    spec.schedule.cron
                ));
            }
        }
    }
    (spec, enabled, next_run_at)
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not Found" }))).into_response()
}
