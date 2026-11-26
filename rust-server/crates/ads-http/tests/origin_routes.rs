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

fn test_app(allowed_origins: &[&str]) -> TestApp {
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
    let origins = allowed_origins
        .iter()
        .map(|origin| origin.to_string())
        .collect::<HashSet<_>>();
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![],
        origins,
        workspace_db,
        workspace,
    )
    .with_workspace_state_dir(directory.path().join("state"));
    TestApp {
        router: build_router(auth, config),
        _directory: directory,
    }
}

async fn post_logout(app: &Router, origin: Option<&str>, host: &str) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header(header::HOST, host);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::empty()).expect("request"))
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

#[tokio::test]
async fn state_changing_requests_reject_untrusted_cross_origin_before_auth() {
    let app = test_app(&[]);
    let (status, body) =
        post_logout(&app.router, Some("https://evil.example"), "ads.example").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "Forbidden"}));
}

#[tokio::test]
async fn configured_allowlist_requires_an_exact_origin() {
    let app = test_app(&["https://allowed.example"]);

    let (status, _) =
        post_logout(&app.router, Some("https://allowed.example"), "ads.example").await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = post_logout(
        &app.router,
        Some("https://allowed.example:8443"),
        "ads.example",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "Forbidden"}));

    let (status, body) = post_logout(&app.router, None, "ads.example").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "Forbidden"}));
}

#[tokio::test]
async fn missing_origin_is_allowed_when_no_allowlist_is_configured() {
    let app = test_app(&[]);
    let (status, body) = post_logout(&app.router, None, "ads.example").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"success": true}));
}

#[tokio::test]
async fn reverse_proxy_headers_drive_origin_cookie_secure_and_cache_transparency() {
    let directory = tempfile::tempdir().expect("temp dir");
    let client_dir = directory.path().join("client");
    std::fs::create_dir_all(&client_dir).expect("client dir");
    std::fs::write(
        client_dir.join("index.html"),
        "<!doctype html><html></html>",
    )
    .expect("index.html");
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
        CookieSecureMode::Auto,
        vec![],
        HashSet::new(),
        workspace_db,
        workspace,
    )
    .with_client_dir(Some(client_dir))
    .with_workspace_state_dir(directory.path().join("state"));
    let router = build_router(auth, config);

    // 1. Proxied login with rewritten Host=127.0.0.1:8787 + X-Forwarded-Host + X-Forwarded-Proto: https
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::HOST, "127.0.0.1:8787")
                .header("x-forwarded-host", "ads-cf.example.com")
                .header("x-forwarded-proto", "https")
                .header("origin", "https://ads-cf.example.com")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "username": "admin", "password": "secret" }).to_string(),
                ))
                .expect("login req"),
        )
        .await
        .expect("login resp");
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie str");
    assert!(set_cookie.contains("; Secure"), "cookie={set_cookie}");
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );

    // 2. Cloudflare CF-Visitor HTTPS detection + RFC 7239 Forwarded host matching
    let cf_response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::HOST, "127.0.0.1:8787")
                .header("forwarded", "for=198.51.100.1;host=\"cf.example.com\"")
                .header("cf-visitor", "{\"scheme\":\"https\"}")
                .header("origin", "https://cf.example.com")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "username": "admin", "password": "secret" }).to_string(),
                ))
                .expect("cf login req"),
        )
        .await
        .expect("cf login resp");
    assert_eq!(cf_response.status(), StatusCode::OK);
    assert!(
        cf_response
            .headers()
            .get(header::SET_COOKIE)
            .expect("set-cookie")
            .to_str()
            .expect("cookie")
            .contains("; Secure")
    );

    // 3. Untrusted cross-origin still rejected behind proxy headers
    let evil = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(header::HOST, "127.0.0.1:8787")
                .header("x-forwarded-host", "ads-cf.example.com")
                .header("origin", "https://evil.example.com")
                .body(Body::empty())
                .expect("evil req"),
        )
        .await
        .expect("evil resp");
    assert_eq!(evil.status(), StatusCode::FORBIDDEN);

    // 4. Healthz returns Cache-Control: no-store; uncompressed HTML includes Vary: Accept-Encoding
    let healthz = router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/healthz")
                .body(Body::empty())
                .expect("healthz req"),
        )
        .await
        .expect("healthz resp");
    assert_eq!(healthz.status(), StatusCode::OK);
    assert_eq!(
        healthz
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );

    let index = router
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/")
                .body(Body::empty())
                .expect("index req"),
        )
        .await
        .expect("index resp");
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(
        index
            .headers()
            .get(header::VARY)
            .and_then(|v| v.to_str().ok()),
        Some("Accept-Encoding")
    );
}
