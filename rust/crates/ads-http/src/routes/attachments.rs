use std::path::{Component, Path, PathBuf};

use ads_contract::attachments::AttachmentKind;
use ads_state::{
    AttachmentStore, CreateImageAttachment, derive_workspace_state_id, workspace_state_path_in,
};
use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::form_urlencoded;

use super::{read_request_bytes, require_session};
use crate::AppState;
use crate::error::ApiError;
use crate::images::detect_image_info;
use crate::multipart::extract_multipart_file;
use crate::paths::{PathValidationFailure, validate_workspace_path_detailed};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const CACHE_CONTROL_IMMUTABLE: &str = "private, max-age=31536000, immutable";

const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageAttachmentResponse {
    id: String,
    url: String,
    sha256: String,
    width: i64,
    height: i64,
    content_type: String,
    size_bytes: i64,
}

pub(super) async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    request: Request,
) -> Result<Response, ApiError> {
    require_session(&state, &headers).await?;
    let workspace_root = resolve_workspace_root(&state, &uri)?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let body = read_request_bytes(request, &state)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Image too large"))?;

    let part = extract_multipart_file(&body, &content_type, "file")
        .map_err(ApiError::bad_request)?
        .ok_or_else(|| ApiError::bad_request("Missing multipart field: file"))?;
    if part.data.is_empty() {
        return Err(ApiError::bad_request("Empty file"));
    }
    if part.data.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Image too large (>25MB)",
        ));
    }
    let info = detect_image_info(&part.data).ok_or_else(|| {
        ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported image type")
    })?;
    if !matches!(info.content_type, "image/png" | "image/jpeg" | "image/webp") {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported image content-type",
        ));
    }

    let sha256 = hex::encode(Sha256::digest(&part.data));
    let storage_key = format!("attachments/{}/{sha256}.{}", &sha256[..2], info.ext);
    let absolute_path = workspace_state_path_in(
        state.workspace_state_dir.as_path(),
        &workspace_root,
        &storage_key,
    );
    let bytes = part.data;
    let size_bytes = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    let write_path = absolute_path.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(parent) = write_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !write_path.exists() {
            std::fs::write(&write_path, &bytes)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] attachment storage worker failed: {error}");
        ApiError::internal()
    })?
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to store image: {error}"),
        )
    })?;

    let input = CreateImageAttachment {
        task_id: None,
        filename: part.filename,
        content_type: info.content_type.to_string(),
        size_bytes,
        width: i64::from(info.width),
        height: i64::from(info.height),
        sha256,
        storage_key,
        now: None,
    };
    let workspace_id = derive_workspace_state_id(&workspace_root);
    let db = state.workspace_db.clone();
    let attachment = tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        AttachmentStore::new(&connection, &workspace_id).create_or_get_image_attachment(input)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] attachment database worker failed: {error}");
        ApiError::internal()
    })?
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let payload = ImageAttachmentResponse {
        id: attachment.id.clone(),
        url: build_attachment_raw_url(&uri, &attachment.id),
        sha256: attachment.sha256,
        width: attachment.width,
        height: attachment.height,
        content_type: attachment.content_type,
        size_bytes: attachment.size_bytes,
    };
    Ok((StatusCode::CREATED, Json(payload)).into_response())
}

pub(super) async fn raw(
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ApiError> {
    let headers = request.headers().clone();
    let uri = request.uri().clone();
    require_session(&state, &headers).await?;

    let encoded_id = uri
        .path()
        .strip_prefix("/api/attachments/")
        .and_then(|rest| rest.strip_suffix("/raw"))
        .unwrap_or_default();
    let id = decode_attachment_id(encoded_id)
        .ok_or_else(|| ApiError::bad_request("Invalid attachment id"))?;
    let workspace_root = resolve_workspace_root(&state, &uri)?;

    let workspace_id = derive_workspace_state_id(&workspace_root);
    let db = state.workspace_db.clone();
    let attachment = tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        AttachmentStore::new(&connection, &workspace_id).get_attachment(&id)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] attachment database worker failed: {error}");
        ApiError::internal()
    })?
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .ok_or_else(|| ApiError::not_found("Attachment not found"))?;
    if attachment.kind != AttachmentKind::Image {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported attachment kind",
        ));
    }

    let Some(absolute_path) = safe_storage_path(
        state.workspace_state_dir.as_path(),
        &workspace_root,
        &attachment.storage_key,
    ) else {
        return Err(ApiError::not_found("Attachment not found"));
    };
    let metadata = match tokio::fs::metadata(&absolute_path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return Err(ApiError::not_found("Attachment not found")),
    };

    let etag = format!("\"sha256-{}\"", attachment.sha256);
    let if_none_match = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim();
    if !if_none_match.is_empty() && if_none_match == etag {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .header(header::CACHE_CONTROL, CACHE_CONTROL_IMMUTABLE)
            .body(Body::empty())
            .map_err(|_| ApiError::internal());
    }

    let bytes = tokio::fs::read(&absolute_path)
        .await
        .map_err(|_| ApiError::not_found("Attachment not found"))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, attachment.content_type)
        .header(header::CONTENT_LENGTH, metadata.len())
        .header(header::CACHE_CONTROL, CACHE_CONTROL_IMMUTABLE)
        .header(header::ETAG, etag)
        .body(Body::from(bytes))
        .map_err(|_| ApiError::internal())
}

fn resolve_workspace_root(state: &AppState, uri: &Uri) -> Result<PathBuf, ApiError> {
    let raw_workspace = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(key, _)| key == "workspace")
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();
    if raw_workspace.is_empty() {
        return Ok((*state.default_workspace_root).clone());
    }

    match validate_workspace_path_detailed(&raw_workspace, &state.allowed_dirs, false) {
        Ok(validated) => Ok(validated.workspace_root),
        Err(error) => Err(match error.failure {
            PathValidationFailure::MissingPath => {
                return Ok((*state.default_workspace_root).clone());
            }
            PathValidationFailure::NotExists => {
                let path = error
                    .absolute_path
                    .unwrap_or_else(|| PathBuf::from(&raw_workspace));
                ApiError::bad_request(format!("Workspace does not exist: {}", path.display()))
            }
            PathValidationFailure::NotDirectory => {
                let path = error
                    .resolved_path
                    .or(error.absolute_path)
                    .unwrap_or_else(|| PathBuf::from(&raw_workspace));
                ApiError::bad_request(format!("Workspace is not a directory: {}", path.display()))
            }
            PathValidationFailure::NotAllowed => ApiError::bad_request("Workspace is not allowed"),
        }),
    }
}

fn decode_attachment_id(raw: &str) -> Option<String> {
    if has_invalid_percent_escape(raw) {
        return None;
    }
    percent_decode_str(raw)
        .decode_utf8()
        .ok()
        .map(|value| value.trim().to_string())
}

fn has_invalid_percent_escape(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return true;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    false
}

fn safe_storage_path(
    state_dir: &Path,
    workspace_root: &Path,
    storage_key: &str,
) -> Option<PathBuf> {
    let relative = Path::new(storage_key);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(workspace_state_path_in(
        state_dir,
        workspace_root,
        storage_key,
    ))
}

fn build_attachment_raw_url(uri: &Uri, attachment_id: &str) -> String {
    let encoded_id = encode_uri_component(attachment_id);
    let workspace = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(key, _)| key == "workspace")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    if workspace.is_empty() {
        format!("/api/attachments/{encoded_id}/raw")
    } else {
        format!(
            "/api/attachments/{encoded_id}/raw?workspace={}",
            encode_uri_component(&workspace)
        )
    }
}

fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}
