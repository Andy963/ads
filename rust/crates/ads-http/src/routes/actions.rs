use std::path::PathBuf;

use ads_state::{StateDb, get_web_project, list_action_jobs};
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{require_session, run_db};
use crate::AppState;
use crate::error::ApiError;
use crate::paths::validate_workspace_path;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionsQuery {
    project_id: Option<String>,
    workspace: Option<String>,
}

#[derive(Debug)]
struct ResolvedProject {
    project_id: String,
    repo_path: PathBuf,
}

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ActionsQuery>,
) -> Result<Json<Value>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let requested = query.project_id.unwrap_or_default().trim().to_string();
    let candidate = if requested.is_empty() {
        query
            .workspace
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| state.default_workspace_root.to_string_lossy().to_string())
    } else {
        requested.clone()
    };
    let candidate_for_error = requested;
    let user_id = session.user.id;
    let resolve_user_id = user_id.clone();
    let resolve_candidate = candidate.clone();
    let allowed_dirs = (*state.allowed_dirs).clone();
    let db = state.auth.db().clone();
    let resolved = tokio::task::spawn_blocking(move || {
        resolve_project_context(&db, &resolve_user_id, &resolve_candidate, &allowed_dirs)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] actions project resolver failed: {error}");
        ApiError::internal()
    })?;
    let Some(resolved) = resolved else {
        return Err(ApiError::bad_request(format!(
            "Invalid or unauthorized project '{candidate_for_error}'"
        )));
    };
    if let Some(queue) = state.review_queue.as_ref() {
        queue.spawn_process(&resolved.project_id, &resolved.repo_path);
    }

    let project_id = resolved.project_id;
    let jobs = run_db(state.auth.db().clone(), move |connection| {
        list_action_jobs(&connection, &project_id, None, Some(&user_id))
    })
    .await?;
    let jobs = jobs
        .into_iter()
        .map(|job| {
            let mut value = serde_json::to_value(job).map_err(|error| {
                eprintln!("[ads-http] failed to serialize action job: {error}");
                ApiError::internal()
            })?;
            if let Some(record) = value.as_object_mut() {
                record.remove("auth_user_id");
                record.remove("chat_session_id");
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(Value::Array(jobs)))
}

pub(super) async fn retired(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    retired_with(
        &state,
        &headers,
        "Asynchronous Actions job operations are retired; continue implementation and review in Acopilot.",
    )
    .await
}

pub(super) async fn retired_dispatch(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    retired_with(
        &state,
        &headers,
        "Asynchronous Actions dispatch is retired; implement in Acopilot.",
    )
    .await
}

pub(super) async fn retired_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    retired_with(
        &state,
        &headers,
        "Asynchronous Actions queue execution is retired; continue in Acopilot.",
    )
    .await
}

async fn retired_with(
    state: &AppState,
    headers: &HeaderMap,
    message: &str,
) -> Result<Response, ApiError> {
    require_session(state, headers).await?;
    Ok((StatusCode::GONE, Json(json!({ "error": message }))).into_response())
}

fn resolve_project_context(
    db: &StateDb,
    user_id: &str,
    candidate: &str,
    allowed_dirs: &[PathBuf],
) -> Option<ResolvedProject> {
    let candidate = candidate.trim();
    let user_id = user_id.trim();
    if candidate.is_empty() || user_id.is_empty() || allowed_dirs.is_empty() {
        return None;
    }
    let connection = db.connect().ok()?;
    if let Ok(Some(project)) = get_web_project(&connection, user_id, candidate) {
        return validate_project(&project.id, &project.workspace_root, allowed_dirs);
    }
    let validated = validate_workspace_path(candidate, allowed_dirs, false).ok()?;
    let workspace_root = validated.workspace_root.to_string_lossy().to_string();
    let project = connection
        .query_row(
            "SELECT project_id, workspace_root FROM web_projects
             WHERE user_id = ?1 AND workspace_root = ?2 LIMIT 1",
            rusqlite::params![user_id, workspace_root],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .ok()??;
    validate_project(&project.0, &project.1, allowed_dirs)
}

fn validate_project(
    project_id: &str,
    workspace_root: &str,
    allowed_dirs: &[PathBuf],
) -> Option<ResolvedProject> {
    let project_id = project_id.trim();
    let workspace_root = workspace_root.trim();
    if project_id.is_empty() || workspace_root.is_empty() {
        return None;
    }
    let validated = validate_workspace_path(workspace_root, allowed_dirs, false).ok()?;
    Some(ResolvedProject {
        project_id: project_id.to_string(),
        repo_path: validated.workspace_root,
    })
}
