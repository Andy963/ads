use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{StateDb, WorkspaceDb, insert_user};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct TestApp {
    router: Router,
    _directory: TempDir,
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
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![],
        HashSet::new(),
        workspace_db,
        workspace,
    )
    .with_workspace_state_dir(directory.path().join("state"));
    TestApp {
        router: build_router(auth, config),
        _directory: directory,
    }
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: impl Into<Body>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if !cookie.is_empty() {
        builder = builder.header(header::COOKIE, cookie);
    }
    let response = app
        .clone()
        .oneshot(builder.body(body.into()).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json")
    };
    (status, body)
}

async fn login(app: &Router, body: String) -> (StatusCode, Value) {
    send(app, "POST", "/api/auth/login", "", body).await
}

async fn login_cookie(app: &Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"username": "admin", "password": "secret"}).to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie")
        .split(';')
        .next()
        .expect("pair")
        .to_string()
}

fn oversized_body() -> String {
    let prefix = "{\"x\":\"";
    let suffix = "\"}";
    format!(
        "{prefix}{}{suffix}",
        "a".repeat(1_000_001 - prefix.len() - suffix.len())
    )
}

fn boundary_body() -> String {
    let prefix = "{\"username\":\"admin\",\"password\":\"secret\",\"padding\":\"";
    let suffix = "\"}";
    format!(
        "{prefix}{}{suffix}",
        "a".repeat(1_000_000 - prefix.len() - suffix.len())
    )
}

#[tokio::test]
async fn oversized_json_bodies_match_the_typescript_route_responses() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;
    let body = oversized_body();

    let (status, response) = login(&app.router, body.clone()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response, json!({"error": "Internal Server Error"}));

    for (method, uri) in [
        ("POST", "/api/projects"),
        ("POST", "/api/model-configs"),
        ("POST", "/api/model-providers"),
    ] {
        let (status, response) = send(&app.router, method, uri, &cookie, body.clone()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{method} {uri}");
        assert_eq!(
            response,
            json!({"error": "Internal Server Error"}),
            "{method} {uri}"
        );
    }

    let (status, response) = send(
        &app.router,
        "PUT",
        "/api/role-profiles/worker",
        &cookie,
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(response, json!({"error": "Invalid JSON body"}));

    let (status, response) = send(
        &app.router,
        "POST",
        "/api/models/upstream/discover",
        &cookie,
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response,
        json!({"ok": false, "models": [], "error": "Invalid JSON payload"})
    );

    let (status, response) = send(
        &app.router,
        "PUT",
        "/api/model-services/conversation",
        &cookie,
        body,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(response, json!({"error": "Request body too large"}));
}

#[tokio::test]
async fn json_body_at_the_exact_limit_is_not_rejected() {
    let app = test_app();
    let (status, response) = login(&app.router, boundary_body()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response, json!({"success": true}));
}

#[tokio::test]
async fn malformed_json_matches_the_route_error_contract() {
    let app = test_app();
    let cookie = login_cookie(&app.router).await;

    let (status, response) = login(&app.router, "{".to_string()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response, json!({"error": "Internal Server Error"}));

    let (status, response) = send(&app.router, "POST", "/api/projects", &cookie, "{").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response, json!({"error": "Internal Server Error"}));

    let (status, response) = send(
        &app.router,
        "PUT",
        "/api/role-profiles/worker",
        &cookie,
        "{",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(response, json!({"error": "Invalid JSON body"}));

    let (status, response) = send(
        &app.router,
        "POST",
        "/api/models/upstream/discover",
        &cookie,
        "{",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        response,
        json!({"ok": false, "models": [], "error": "Invalid JSON payload"})
    );
}

#[tokio::test]
async fn json_routes_ignore_content_type_like_typescript() {
    let app = test_app();
    let response = app
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .body(Body::from(
                    json!({"username": "admin", "password": "secret"}).to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).expect("json"),
        json!({"success": true})
    );
}

#[tokio::test]
async fn authentication_precedes_json_body_validation() {
    let app = test_app();
    let body = oversized_body();
    for (method, uri) in [
        ("POST", "/api/projects"),
        ("POST", "/api/model-configs"),
        ("POST", "/api/model-providers"),
        ("PUT", "/api/role-profiles/worker"),
        ("POST", "/api/models/upstream/discover"),
        ("PUT", "/api/model-services/conversation"),
    ] {
        let (status, response) = send(&app.router, method, uri, "", body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(response, json!({"error": "Unauthorized"}), "{method} {uri}");
    }
}
