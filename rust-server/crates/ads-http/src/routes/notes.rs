use ads_contract::projects::SuccessResponse;
use ads_contract::time::now_unix_millis;
use ads_state::{
    ProjectNote, create_project_note, delete_project_note, list_project_notes, update_project_note,
};
use axum::Json;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

use super::{read_json_payload, require_session, run_db};
use crate::AppState;
use crate::error::ApiError;

#[derive(Debug, Deserialize)]
pub(super) struct NotesListQuery {
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    all: Option<String>,
    #[serde(rename = "includeArchived", alias = "include_archived")]
    include_archived: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NotesListResponse {
    notes: Vec<ProjectNote>,
}

#[derive(Debug, Deserialize)]
struct CreateNoteRequest {
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateNoteRequest {
    content: Option<String>,
    #[serde(rename = "isArchived", alias = "is_archived")]
    is_archived: Option<bool>,
}

fn parse_bool_query(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes")
    )
}

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<NotesListQuery>,
) -> Result<Json<NotesListResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let user_id = session.user.id;
    let all = parse_bool_query(query.all.as_deref());
    let include_archived = parse_bool_query(query.include_archived.as_deref());
    let project_id = if all {
        None
    } else {
        query
            .project_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let notes = run_db(state.auth.db().clone(), move |connection| {
        list_project_notes(
            &connection,
            &user_id,
            project_id.as_deref(),
            include_archived,
        )
    })
    .await?;

    Ok(Json(NotesListResponse { notes }))
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<(StatusCode, Json<ProjectNote>), ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<CreateNoteRequest>(body, &state).await?;
    let project_id = request.project_id.unwrap_or_default().trim().to_string();
    let content = request.content.unwrap_or_default();
    if project_id.is_empty() || content.trim().is_empty() {
        return Err(ApiError::bad_request(
            "projectId and non-empty content are required",
        ));
    }
    let user_id = session.user.id;
    let now = now_unix_millis();
    let note = run_db(state.auth.db().clone(), move |connection| {
        create_project_note(&connection, &user_id, &project_id, &content, now)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(note)))
}

pub(super) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
    body: Request,
) -> Result<Json<ProjectNote>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let request = read_json_payload::<UpdateNoteRequest>(body, &state).await?;
    if request.content.is_none() && request.is_archived.is_none() {
        return Err(ApiError::bad_request("No note fields provided to update"));
    }
    if let Some(content) = request.content.as_deref()
        && content.trim().is_empty()
    {
        return Err(ApiError::bad_request("Note content cannot be empty"));
    }
    let user_id = session.user.id;
    let now = now_unix_millis();
    let updated = run_db(state.auth.db().clone(), move |connection| {
        update_project_note(
            &connection,
            &user_id,
            &note_id,
            request.content.as_deref(),
            request.is_archived,
            now,
        )
    })
    .await?;
    let Some(note) = updated else {
        return Err(ApiError::not_found("Note not found"));
    };
    Ok(Json(note))
}

pub(super) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(note_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let user_id = session.user.id;
    let deleted = run_db(state.auth.db().clone(), move |connection| {
        delete_project_note(&connection, &user_id, &note_id)
    })
    .await?;
    if !deleted {
        return Err(ApiError::not_found("Note not found"));
    }
    Ok(Json(SuccessResponse { success: true }))
}
