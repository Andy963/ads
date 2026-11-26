use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{StateDb, WorkspaceDb};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use flate2::read::GzDecoder;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct TestApp {
    router: Router,
    _directory: TempDir,
}

fn test_app(client_dir: Option<PathBuf>) -> TestApp {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
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
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![],
        HashSet::new(),
        workspace_db,
        workspace,
    )
    .with_client_dir(client_dir)
    .with_workspace_state_dir(directory.path().join("state"));
    TestApp {
        router: build_router(auth, config),
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
    headers: &[(&'static str, &str)],
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::empty()).expect("request"))
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

fn write_client(dir: &Path) {
    fs::create_dir_all(dir.join("assets")).expect("assets dir");
    fs::write(
        dir.join("index.html"),
        "<!doctype html><html><body>ADS</body></html>",
    )
    .expect("index");
    fs::write(
        dir.join("assets/app.js"),
        "console.log('ads asset');\n".repeat(128),
    )
    .expect("asset");
}

fn header<'a>(response: &'a TestResponse, name: &str) -> &'a str {
    response
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

#[tokio::test]
async fn serves_spa_assets_health_and_api_not_found() {
    let root = tempfile::tempdir().expect("root");
    let client = root.path().join("client");
    write_client(&client);
    let app = test_app(Some(client));

    let index = request(&app.router, Method::GET, "/", &[]).await;
    assert_eq!(index.status, StatusCode::OK);
    assert_eq!(header(&index, "content-type"), "text/html; charset=utf-8");
    assert_eq!(
        header(&index, "cache-control"),
        "no-cache, no-store, must-revalidate"
    );
    assert_eq!(header(&index, "x-content-type-options"), "nosniff");
    assert_eq!(header(&index, "x-frame-options"), "DENY");
    assert_eq!(
        header(&index, "referrer-policy"),
        "strict-origin-when-cross-origin"
    );
    assert_eq!(index.body, b"<!doctype html><html><body>ADS</body></html>");

    let asset = request(&app.router, Method::GET, "/assets/app.js", &[]).await;
    assert_eq!(asset.status, StatusCode::OK);
    assert_eq!(
        header(&asset, "content-type"),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        header(&asset, "cache-control"),
        "public, max-age=31536000, immutable"
    );

    let spa = request(&app.router, Method::GET, "/dashboard", &[]).await;
    assert_eq!(spa.status, StatusCode::OK);
    assert_eq!(spa.body, index.body);

    let missing = request(&app.router, Method::GET, "/missing.css", &[]).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.body, b"Not Found");

    let health = request(&app.router, Method::GET, "/healthz", &[]).await;
    assert_eq!(health.status, StatusCode::OK);
    assert_eq!(health.body, b"ok");

    let api = request(&app.router, Method::GET, "/api/not-a-route", &[]).await;
    assert_eq!(api.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        serde_json::from_slice::<Value>(&api.body).expect("json"),
        json!({"error": "Unauthorized"})
    );

    let non_get = request(&app.router, Method::POST, "/", &[]).await;
    assert_eq!(non_get.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn gzip_compresses_eligible_assets() {
    let root = tempfile::tempdir().expect("root");
    let client = root.path().join("client");
    write_client(&client);
    let app = test_app(Some(client));

    let response = request(
        &app.router,
        Method::GET,
        "/assets/app.js",
        &[("accept-encoding", "br, gzip")],
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(header(&response, "content-encoding"), "gzip");
    assert_eq!(header(&response, "vary"), "Accept-Encoding");

    let mut decoder = GzDecoder::new(response.body.as_slice());
    let mut decoded = String::new();
    decoder.read_to_string(&mut decoded).expect("decode gzip");
    assert_eq!(decoded, "console.log('ads asset');\n".repeat(128));
}

#[tokio::test]
async fn unbuilt_client_returns_the_typescript_service_unavailable_text() {
    let root = tempfile::tempdir().expect("root");
    let app = test_app(Some(root.path().join("missing-client")));
    let response = request(&app.router, Method::GET, "/", &[]).await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.body,
        b"Web app not built. Run: npm --prefix client run build\n"
    );
}

#[tokio::test]
async fn unknown_api_requests_still_enforce_origin() {
    let app = test_app(None);
    let response = request(
        &app.router,
        Method::POST,
        "/api/not-a-route",
        &[("host", "ads.example"), ("origin", "https://evil.example")],
    )
    .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(
        serde_json::from_slice::<Value>(&response.body).expect("json"),
        json!({"error": "Forbidden"})
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escape_is_forbidden() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("root");
    let client = root.path().join("client");
    write_client(&client);
    let secret = root.path().join("secret.txt");
    fs::write(&secret, "outside").expect("secret");
    symlink(&secret, client.join("linked.txt")).expect("symlink");
    let app = test_app(Some(client));

    let response = request(&app.router, Method::GET, "/linked.txt", &[]).await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
}
