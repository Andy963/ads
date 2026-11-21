use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::GzEncoder;
use percent_encoding::percent_decode_str;

use crate::AppState;
use crate::error::ApiError;
use crate::origin::is_origin_allowed_for_request;

const WEB_NOT_BUILT: &str = "Web app not built. Run: npm --prefix client run build\n";

pub fn resolve_client_dir(start_dir: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("ADS_WEB_CLIENT_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let root = crate::paths::detect_workspace_root(start_dir);
    let candidates = [
        root.join("client").join("dist"),
        root.join("dist").join("client"),
        root.join("client"),
    ];
    candidates
        .iter()
        .find(|candidate| candidate.join("index.html").exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

pub async fn handle_fallback(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    if path.starts_with("/api/") {
        if is_state_changing_method(request.method())
            && !is_origin_allowed_for_request(request.headers(), &state.allowed_origins)
        {
            let mut response = ApiError::new(StatusCode::FORBIDDEN, "Forbidden").into_response();
            insert_no_store(&mut response);
            return response;
        }
        if let Err(error) = crate::routes::require_session(&state, request.headers()).await {
            return error.into_response();
        }
        let mut response = ApiError::not_found("Not Found").into_response();
        insert_no_store(&mut response);
        return response;
    }

    if request.method() != Method::GET {
        return text_response(StatusCode::NOT_FOUND, "Not Found");
    }
    if path.starts_with("/healthz") {
        return Response::builder()
            .status(StatusCode::OK)
            .body(Body::from("ok"))
            .unwrap_or_else(|_| {
                text_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
            });
    }

    let Some(client_dir) = state.client_dir.clone() else {
        return not_built_response();
    };
    serve_ui(&client_dir, &path, request.headers()).await
}

async fn serve_ui(client_dir: &Arc<PathBuf>, raw_path: &str, headers: &HeaderMap) -> Response {
    let decoded = match percent_decode_str(raw_path).decode_utf8() {
        Ok(value) => value,
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "Bad Request"),
    };
    let normalized = normalize_url_path(decoded.as_ref());
    let relative = normalized.trim_start_matches('/').trim_end_matches('/');
    let relative_path = PathBuf::from(relative);
    let accepts_gzip = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("gzip"));

    if relative.is_empty() {
        return match read_static_file(
            client_dir.clone(),
            PathBuf::from("index.html"),
            accepts_gzip,
        )
        .await
        {
            FileOutcome::Served(file) => file.into_response(),
            FileOutcome::Forbidden => text_response(StatusCode::FORBIDDEN, "Forbidden"),
            FileOutcome::Missing => not_built_response(),
        };
    }

    match read_static_file(client_dir.clone(), relative_path.clone(), accepts_gzip).await {
        FileOutcome::Served(file) => return file.into_response(),
        FileOutcome::Forbidden => return text_response(StatusCode::FORBIDDEN, "Forbidden"),
        FileOutcome::Missing => {}
    }

    let basename = relative_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !basename.contains('.') {
        return match read_static_file(
            client_dir.clone(),
            PathBuf::from("index.html"),
            accepts_gzip,
        )
        .await
        {
            FileOutcome::Served(file) => file.into_response(),
            FileOutcome::Forbidden => text_response(StatusCode::FORBIDDEN, "Forbidden"),
            FileOutcome::Missing => not_built_response(),
        };
    }

    text_response(StatusCode::NOT_FOUND, "Not Found")
}

fn normalize_url_path(path: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in Path::new(path.trim_start_matches('/')).components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::ParentDir => {
                parts.pop();
            }
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
        }
    }
    format!("/{}", parts.join("/"))
}

enum FileOutcome {
    Served(StaticFile),
    Forbidden,
    Missing,
}

struct StaticFile {
    bytes: Vec<u8>,
    content_type: &'static str,
    cache_control: &'static str,
    gzip: bool,
}

impl StaticFile {
    fn into_response(self) -> Response {
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, self.content_type)
            .header(header::CACHE_CONTROL, self.cache_control);
        if self.gzip {
            builder = builder
                .header(header::CONTENT_ENCODING, "gzip")
                .header(header::VARY, "Accept-Encoding");
        }
        builder.body(Body::from(self.bytes)).unwrap_or_else(|_| {
            text_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
        })
    }
}

async fn read_static_file(
    client_dir: Arc<PathBuf>,
    relative: PathBuf,
    accepts_gzip: bool,
) -> FileOutcome {
    tokio::task::spawn_blocking(move || {
        read_static_file_blocking(&client_dir, &relative, accepts_gzip)
    })
    .await
    .unwrap_or(FileOutcome::Missing)
}

fn read_static_file_blocking(
    client_dir: &Path,
    relative: &Path,
    accepts_gzip: bool,
) -> FileOutcome {
    let root = fs::canonicalize(client_dir).unwrap_or_else(|_| client_dir.to_path_buf());
    let candidate = client_dir.join(relative);
    if !matches!(fs::metadata(&candidate), Ok(metadata) if metadata.is_file()) {
        return FileOutcome::Missing;
    }
    let canonical = fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
    if canonical != root && !canonical.starts_with(&root) {
        return FileOutcome::Forbidden;
    }

    let mut bytes = match fs::read(&candidate) {
        Ok(bytes) => bytes,
        Err(_) => return FileOutcome::Missing,
    };
    let content_type = content_type_for(relative);
    let gzip = accepts_gzip && is_compressible(relative);
    if gzip {
        let input = bytes;
        match compress_gzip(input) {
            Ok(compressed) => bytes = compressed,
            Err(_) => return FileOutcome::Missing,
        }
    }

    FileOutcome::Served(StaticFile {
        bytes,
        content_type,
        cache_control: cache_control_for(relative),
        gzip,
    })
}

fn compress_gzip(input: Vec<u8>) -> std::io::Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&input)?;
    encoder.finish()
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn is_compressible(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "html" | "js" | "css" | "json" | "svg" | "map" | "txt"
    )
}

fn cache_control_for(path: &Path) -> &'static str {
    let hashed_asset = path
        .components()
        .any(|component| component.as_os_str() == "assets")
        && !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("html"));
    if hashed_asset {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache, no-store, must-revalidate"
    }
}

fn is_state_changing_method(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn insert_no_store(response: &mut Response) {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("cache header"),
    );
}

fn not_built_response() -> Response {
    text_response(StatusCode::SERVICE_UNAVAILABLE, WEB_NOT_BUILT)
}

fn text_response(status: StatusCode, body: &'static str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_url_paths_like_posix_normalize() {
        assert_eq!(normalize_url_path("/"), "/");
        assert_eq!(normalize_url_path("/a/../b"), "/b");
        assert_eq!(normalize_url_path("/../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize_url_path("dashboard"), "/dashboard");
    }

    #[test]
    fn maps_content_types_and_cache_policy() {
        assert_eq!(
            content_type_for(Path::new("app.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for(Path::new("app.woff2")), "font/woff2");
        assert_eq!(
            cache_control_for(Path::new("assets/app.js")),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache_control_for(Path::new("index.html")),
            "no-cache, no-store, must-revalidate"
        );
    }
}
