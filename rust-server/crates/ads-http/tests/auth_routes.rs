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

fn test_app(login_max_attempts: u32) -> (Router, TempDir) {
    let directory = tempdir();
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
            login_max_attempts,
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
    (build_router(auth, config), directory)
}

fn tempdir() -> TempDir {
    tempfile::tempdir().expect("temp dir")
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("json response")
}

async fn login(app: &Router, password: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "username": "admin", "password": password }).to_string(),
                ))
                .expect("login request"),
        )
        .await
        .expect("login response")
}

#[tokio::test]
async fn login_me_logout_round_trip_matches_node_contract() {
    let (app, _directory) = test_app(5);

    let status_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/status")
                .body(Body::empty())
                .expect("status request"),
        )
        .await
        .expect("status response");
    assert_eq!(status_response.status(), StatusCode::OK);
    assert_eq!(
        response_json(status_response).await,
        json!({ "initialized": true })
    );

    let login_response = login(&app, "secret").await;
    assert_eq!(login_response.status(), StatusCode::OK);
    let set_cookie = login_response
        .headers()
        .get(header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .expect("cookie text")
        .to_string();
    assert!(set_cookie.starts_with("ads_session="));
    assert!(set_cookie.contains("Path=/"));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    let cookie = set_cookie
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string();
    assert_eq!(
        response_json(login_response).await,
        json!({ "success": true })
    );

    let me_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("me request"),
        )
        .await
        .expect("me response");
    assert_eq!(me_response.status(), StatusCode::OK);
    assert_eq!(
        response_json(me_response).await,
        json!({ "id": "user-1", "username": "admin" })
    );

    let logout_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("logout request"),
        )
        .await
        .expect("logout response");
    assert_eq!(logout_response.status(), StatusCode::OK);
    assert_eq!(
        response_json(logout_response).await,
        json!({ "success": true })
    );

    let me_after_logout = app
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("me request"),
        )
        .await
        .expect("me response");
    assert_eq!(me_after_logout.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rejects_invalid_login_payloads() {
    let (app, _directory) = test_app(5);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await,
        json!({ "error": "Invalid payload" })
    );
}

#[tokio::test]
async fn locks_repeated_login_failures() {
    let (app, _directory) = test_app(2);

    assert_eq!(
        login(&app, "wrong").await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, "wrong").await.status(),
        StatusCode::UNAUTHORIZED
    );

    let locked = login(&app, "wrong").await;
    assert_eq!(locked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(locked.headers().get(header::RETRY_AFTER).is_some());
}
