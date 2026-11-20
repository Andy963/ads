use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{
    StateDb, WorkspaceDb, derive_workspace_state_id, insert_user, workspace_state_path_in,
};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct TestApp {
    router: Router,
    workspace: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    _directory: TempDir,
}

fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&640u32.to_be_bytes());
    bytes.extend_from_slice(&480u32.to_be_bytes());
    bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
    bytes
}

fn test_app() -> TestApp {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    insert_user(
        &db,
        "user-1",
        "admin",
        &hash_password_scrypt("secret"),
        1_700_000_000,
    )
    .expect("user");
    let auth = Arc::new(AuthService::new(
        db,
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    ));
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let state_dir = directory.path().join("state");
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        HashSet::new(),
        workspace_db,
        workspace.clone(),
    )
    .with_workspace_state_dir(&state_dir);
    TestApp {
        router: build_router(auth, config),
        workspace,
        state_dir,
        _directory: directory,
    }
}

struct TestResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

async fn request(
    app: &Router,
    method: Method,
    uri: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body)).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    TestResponse {
        status,
        headers,
        body,
    }
}

fn header<'a>(response: &'a TestResponse, name: &str) -> &'a str {
    response
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

async fn login_cookie(app: &Router) -> String {
    let response = request(
        app,
        Method::POST,
        "/api/auth/login",
        &[("content-type", "application/json")],
        json!({"username": "admin", "password": "secret"})
            .to_string()
            .into_bytes(),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    header(&response, "set-cookie")
        .split(';')
        .next()
        .expect("cookie")
        .to_string()
}

fn multipart(
    boundary: &str,
    field: &str,
    filename: &str,
    content_type: &str,
    data: &[u8],
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

async fn upload_png(app: &Router, cookie: &str) -> TestResponse {
    let boundary = "ads-test-boundary";
    request(
        app,
        Method::POST,
        "/api/attachments/images",
        &[
            ("cookie", cookie),
            (
                "content-type",
                &format!("multipart/form-data; boundary={boundary}"),
            ),
        ],
        multipart(boundary, "file", "shot.png", "image/png", &png()),
    )
    .await
}

#[tokio::test]
async fn uploads_and_serves_image_attachments() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;
    let upload = upload_png(&app.router, &cookie).await;
    assert_eq!(upload.status, StatusCode::CREATED);
    let payload: Value = serde_json::from_slice(&upload.body).expect("json");
    assert_eq!(payload["contentType"], "image/png");
    assert_eq!(payload["width"], 640);
    assert_eq!(payload["height"], 480);
    assert_eq!(payload["sizeBytes"], png().len());
    let id = payload["id"].as_str().expect("id");
    let sha256 = payload["sha256"].as_str().expect("sha256");
    assert_eq!(payload["url"], format!("/api/attachments/{id}/raw"));
    let encoded_workspace = app.workspace.to_string_lossy().replace('/', "%2F");
    let scoped_uri = format!("/api/attachments/images?workspace={encoded_workspace}");
    let scoped = request(
        &app.router,
        Method::POST,
        &scoped_uri,
        &[
            ("cookie", &cookie),
            (
                "content-type",
                "multipart/form-data; boundary=ads-test-boundary",
            ),
        ],
        multipart(
            "ads-test-boundary",
            "file",
            "scoped.png",
            "image/png",
            &png(),
        ),
    )
    .await;
    assert_eq!(scoped.status, StatusCode::CREATED);
    let scoped_payload: Value = serde_json::from_slice(&scoped.body).expect("json");
    assert_eq!(
        scoped_payload["url"],
        format!("/api/attachments/{id}/raw?workspace={encoded_workspace}")
    );

    let stored = workspace_state_path_in(
        &app.state_dir,
        &app.workspace,
        &format!("attachments/{}/{sha256}.png", &sha256[..2]),
    );
    assert_eq!(std::fs::read(&stored).expect("stored image"), png());
    assert_eq!(
        stored,
        app.state_dir
            .join("workspaces")
            .join(derive_workspace_state_id(&app.workspace))
            .join(format!("attachments/{}/{sha256}.png", &sha256[..2]))
    );

    let raw = request(
        &app.router,
        Method::GET,
        &format!("/api/attachments/{id}/raw"),
        &[("cookie", &cookie)],
        Vec::new(),
    )
    .await;
    assert_eq!(raw.status, StatusCode::OK);
    assert_eq!(header(&raw, "content-type"), "image/png");
    assert_eq!(header(&raw, "content-length"), png().len().to_string());
    assert_eq!(
        header(&raw, "cache-control"),
        "private, max-age=31536000, immutable"
    );
    let etag = format!("\"sha256-{sha256}\"");
    assert_eq!(header(&raw, "etag"), etag);
    assert_eq!(raw.body, png());

    let not_modified = request(
        &app.router,
        Method::GET,
        &format!("/api/attachments/{id}/raw"),
        &[("cookie", &cookie), ("if-none-match", &etag)],
        Vec::new(),
    )
    .await;
    assert_eq!(not_modified.status, StatusCode::NOT_MODIFIED);
    assert!(not_modified.body.is_empty());
    assert_eq!(header(&not_modified, "etag"), etag);

    let missing = request(
        &app.router,
        Method::GET,
        "/api/attachments/not-found/raw",
        &[("cookie", &cookie)],
        Vec::new(),
    )
    .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(
        serde_json::from_slice::<Value>(&missing.body).expect("json")["error"],
        "Attachment not found"
    );
}

#[tokio::test]
async fn rejects_missing_empty_and_unsupported_uploads() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;
    let boundary = "ads-test-boundary";
    let content_type = format!("multipart/form-data; boundary={boundary}");

    let missing = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("cookie", &cookie), ("content-type", &content_type)],
        multipart(boundary, "other", "a.png", "image/png", &png()),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&missing.body).expect("json")["error"],
        "Missing multipart field: file"
    );

    let empty = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("cookie", &cookie), ("content-type", &content_type)],
        multipart(boundary, "file", "a.png", "image/png", b""),
    )
    .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&empty.body).expect("json")["error"],
        "Empty file"
    );

    let unsupported = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("cookie", &cookie), ("content-type", &content_type)],
        multipart(boundary, "file", "a.txt", "text/plain", b"not an image"),
    )
    .await;
    assert_eq!(unsupported.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        serde_json::from_slice::<Value>(&unsupported.body).expect("json")["error"],
        "Unsupported image type"
    );

    let unauthorized = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("content-type", &content_type)],
        multipart(boundary, "file", "a.png", "image/png", &png()),
    )
    .await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rejects_oversized_files_and_request_bodies() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;
    let boundary = "ads-test-boundary";
    let content_type = format!("multipart/form-data; boundary={boundary}");

    let oversized_file = vec![0u8; 25 * 1024 * 1024 + 1];
    let file_response = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("cookie", &cookie), ("content-type", &content_type)],
        multipart(boundary, "file", "large.bin", "image/png", &oversized_file),
    )
    .await;
    assert_eq!(file_response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        serde_json::from_slice::<Value>(&file_response.body).expect("json")["error"],
        "Image too large (>25MB)"
    );
    drop(oversized_file);

    let oversized_body = vec![0u8; 25 * 1024 * 1024 + 512 * 1024 + 1];
    let body_response = request(
        &app.router,
        Method::POST,
        "/api/attachments/images",
        &[("cookie", &cookie), ("content-type", &content_type)],
        multipart(boundary, "file", "large.bin", "image/png", &oversized_body),
    )
    .await;
    assert_eq!(body_response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        serde_json::from_slice::<Value>(&body_response.body).expect("json")["error"],
        "Image too large"
    );
}

#[tokio::test]
async fn validates_workspace_query_before_reading_body() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;
    let boundary = "ads-test-boundary";
    let outside = tempfile::tempdir().expect("outside");
    let uri = format!(
        "/api/attachments/images?workspace={}",
        outside.path().to_string_lossy().replace('/', "%2F")
    );
    let denied = request(
        &app.router,
        Method::POST,
        &uri,
        &[
            ("cookie", &cookie),
            (
                "content-type",
                &format!("multipart/form-data; boundary={boundary}"),
            ),
        ],
        multipart(boundary, "file", "a.png", "image/png", &png()),
    )
    .await;
    assert_eq!(denied.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_slice::<Value>(&denied.body).expect("json")["error"],
        "Workspace is not allowed"
    );

    let missing_workspace = app.workspace.join("missing");
    let missing_uri = format!(
        "/api/attachments/images?workspace={}",
        missing_workspace.to_string_lossy().replace('/', "%2F")
    );
    let missing = request(
        &app.router,
        Method::POST,
        &missing_uri,
        &[
            ("cookie", &cookie),
            (
                "content-type",
                &format!("multipart/form-data; boundary={boundary}"),
            ),
        ],
        multipart(boundary, "file", "a.png", "image/png", &png()),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&missing.body).expect("json");
    assert_eq!(
        body["error"],
        format!("Workspace does not exist: {}", missing_workspace.display())
    );
}
