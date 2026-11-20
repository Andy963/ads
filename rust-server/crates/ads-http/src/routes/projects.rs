use ads_contract::projects::{
    CreateProjectRequest, CreateProjectResponse, DeleteProjectResponse, ProjectsResponse,
    ReorderProjectsRequest, SetActiveProjectRequest, SuccessResponse, UpdateProjectRequest,
    UpdateProjectResponse,
};
use ads_contract::time::now_unix_millis;
use ads_state::{
    DEFAULT_PROJECT_ID, UpdateWebProject, UpsertWebProject, delete_web_project,
    derive_project_session_id, get_active_project_id, list_web_projects, reorder_web_projects,
    set_active_project_id, update_web_project, upsert_web_project,
};
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::HeaderMap;

use super::{read_json_payload, require_session, run_db};
use crate::AppState;
use crate::error::ApiError;
use crate::paths::{PathValidationFailure, validate_workspace_path};

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProjectsResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let db = state.auth.db().clone();
    let user_id = session.user.id;

    let (projects, active_project_id) = run_db(db, move |connection| {
        Ok((
            list_web_projects(&connection, &user_id)?,
            get_active_project_id(&connection, &user_id)?,
        ))
    })
    .await?;

    Ok(Json(ProjectsResponse {
        projects,
        active_project_id,
    }))
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<CreateProjectResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<CreateProjectRequest>(body, &state).await?;

    let candidate = request.path.trim().to_string();
    if candidate.is_empty() {
        return Err(ApiError::bad_request("Invalid payload"));
    }
    if request
        .name
        .as_deref()
        .is_some_and(|name| name.trim().is_empty())
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }

    let allowed_dirs = (*state.allowed_dirs).clone();
    let validated = tokio::task::spawn_blocking(move || {
        validate_workspace_path(&candidate, &allowed_dirs, true)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] workspace path worker failed: {error}");
        ApiError::internal()
    })?
    .map_err(path_failure_response)?;

    let workspace_root = validated.workspace_root.to_string_lossy().to_string();
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            validated
                .workspace_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());
    let project_id = derive_project_session_id(&workspace_root);
    let user_id = session.user.id;
    let db = state.auth.db().clone();
    let project_id_for_db = project_id.clone();

    let project = run_db(db, move |connection| {
        let project = upsert_web_project(
            &connection,
            UpsertWebProject {
                user_id: &user_id,
                project_id: &project_id_for_db,
                workspace_root: &workspace_root,
                name: &name,
                chat_session_id: Some("main"),
            },
            now_unix_millis(),
        )?;
        set_active_project_id(&connection, &user_id, Some(&project.id), now_unix_millis())?;
        Ok(project)
    })
    .await?;

    Ok(Json(CreateProjectResponse {
        active_project_id: project.id.clone(),
        project,
    }))
}

pub(super) async fn reorder(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<SuccessResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<ReorderProjectsRequest>(body, &state).await?;
    if request.ids.iter().any(|id| id.trim().is_empty()) {
        return Err(ApiError::bad_request("Invalid payload"));
    }

    let user_id = session.user.id;
    let db = state.auth.db().clone();
    run_db(db, move |mut connection| {
        reorder_web_projects(&mut connection, &user_id, &request.ids)
    })
    .await?;

    Ok(Json(SuccessResponse { success: true }))
}

pub(super) async fn set_active(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<SuccessResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<SetActiveProjectRequest>(body, &state).await?;
    let Some(project_id) = request.project_id else {
        return Err(ApiError::bad_request("Invalid payload"));
    };
    if project_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(ApiError::bad_request("Invalid payload"));
    }

    let resolved = project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != DEFAULT_PROJECT_ID)
        .map(ToString::to_string)
        .unwrap_or_else(|| DEFAULT_PROJECT_ID.to_string());

    let user_id = session.user.id;
    let db = state.auth.db().clone();
    run_db(db, move |connection| {
        set_active_project_id(&connection, &user_id, Some(&resolved), now_unix_millis())
    })
    .await?;

    Ok(Json(SuccessResponse { success: true }))
}

pub(super) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    body: Request,
) -> Result<Json<UpdateProjectResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(ApiError::bad_request("projectId is required"));
    }
    let request = read_json_payload::<UpdateProjectRequest>(body, &state).await?;
    for value in [request.name.as_deref(), request.chat_session_id.as_deref()]
        .into_iter()
        .flatten()
    {
        if value.trim().is_empty() {
            return Err(ApiError::bad_request("Invalid payload"));
        }
    }

    let user_id = session.user.id;
    let db = state.auth.db().clone();
    let project = run_db(db, move |connection| {
        update_web_project(
            &connection,
            UpdateWebProject {
                user_id: &user_id,
                project_id: &project_id,
                name: request.name.as_deref(),
                chat_session_id: request.chat_session_id.as_deref(),
            },
            now_unix_millis(),
        )
    })
    .await?
    .ok_or_else(|| ApiError::not_found("Not Found"))?;

    Ok(Json(UpdateProjectResponse {
        success: true,
        project,
    }))
}

pub(super) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<Json<DeleteProjectResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(ApiError::bad_request("projectId is required"));
    }

    let user_id = session.user.id;
    let db = state.auth.db().clone();
    let (success, active_project_id) = run_db(db, move |connection| {
        let deleted = delete_web_project(&connection, &user_id, &project_id)?;
        let current = get_active_project_id(&connection, &user_id)?;
        let mut next_active = current.clone();
        if deleted && current.as_deref() == Some(project_id.as_str()) {
            let remaining = list_web_projects(&connection, &user_id)?;
            let next = remaining
                .first()
                .map(|project| project.id.clone())
                .unwrap_or_else(|| DEFAULT_PROJECT_ID.to_string());
            set_active_project_id(&connection, &user_id, Some(&next), now_unix_millis())?;
            next_active = Some(next);
        }
        Ok((deleted, next_active))
    })
    .await?;

    Ok(Json(DeleteProjectResponse {
        success,
        active_project_id,
    }))
}

fn path_failure_response(failure: PathValidationFailure) -> ApiError {
    ApiError::bad_request(failure.message())
}
