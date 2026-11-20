use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{StateDb, WorkspaceDb, derive_project_session_id, insert_user};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct TestApp {
    router: Router,
    workspace: PathBuf,
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
    std::fs::create_dir_all(workspace.join("project-a")).expect("project dir");
    std::fs::create_dir_all(workspace.join("project-b")).expect("project dir");
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        HashSet::new(),
        workspace_db,
        workspace.clone(),
    )
    .with_workspace_state_dir(directory.path().join("state"));
    let router = build_router(auth, config);
    TestApp {
        router,
        workspace,
        _directory: directory,
    }
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !cookie.is_empty() {
        builder = builder.header(header::COOKIE, cookie);
    }
    let body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json")
    };
    (status, value)
}

async fn login(app: &Router) -> String {
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
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie")
        .to_string();
    cookie.split(';').next().expect("cookie pair").to_string()
}

#[tokio::test]
async fn project_routes_require_authentication() {
    let app = test_app();
    let (status, body) = send(&app.router, "GET", "/api/projects", "", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({"error": "Unauthorized"}));
}

#[tokio::test]
async fn project_routes_create_list_reorder_update_and_delete() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let (status, body) = send(&app.router, "GET", "/api/projects", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"projects": [], "activeProjectId": null}));

    let project_a = app.workspace.join("project-a");
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects",
        &cookie,
        Some(json!({"path": project_a.to_string_lossy()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let expected_id = derive_project_session_id(&project_a.to_string_lossy());
    assert_eq!(body["project"]["id"], json!(expected_id));
    assert_eq!(body["project"]["name"], json!("project-a"));
    assert_eq!(body["project"]["chatSessionId"], json!("main"));
    assert_eq!(body["activeProjectId"], json!(expected_id));

    let project_b = app.workspace.join("project-b");
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects",
        &cookie,
        Some(json!({"path": project_b.to_string_lossy(), "name": "Bee"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["project"]["name"], json!("Bee"));
    let project_b_id = body["project"]["id"].as_str().expect("id").to_string();

    let (status, body) = send(&app.router, "GET", "/api/projects", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"].as_array().expect("projects").len(), 2);
    assert_eq!(body["activeProjectId"], json!(project_b_id));

    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects/reorder",
        &cookie,
        Some(json!({"ids": [project_b_id, expected_id]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"success": true}));

    let (status, body) = send(&app.router, "GET", "/api/projects", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["projects"][0]["id"], json!(project_b_id));

    let (status, body) = send(
        &app.router,
        "PATCH",
        &format!("/api/projects/{}", project_b_id),
        &cookie,
        Some(json!({"name": "Renamed"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["project"]["name"], json!("Renamed"));

    let (status, body) = send(
        &app.router,
        "PATCH",
        "/api/projects/active",
        &cookie,
        Some(json!({"projectId": null})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "unexpected body: {body}");
    let (_, body) = send(&app.router, "GET", "/api/projects", &cookie, None).await;
    assert_eq!(body["activeProjectId"], json!("default"));

    let (status, _) = send(
        &app.router,
        "PATCH",
        "/api/projects/active",
        &cookie,
        Some(json!({"projectId": project_b_id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &app.router,
        "DELETE",
        &format!("/api/projects/{}", project_b_id),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], json!(true));
    assert_eq!(body["activeProjectId"], json!(expected_id));

    let (status, body) = send(
        &app.router,
        "DELETE",
        "/api/projects/missing",
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], json!(false));
}

#[tokio::test]
async fn project_creation_rejects_paths_outside_the_allowlist() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let outside = app._directory.path().join("outside");
    std::fs::create_dir_all(&outside).expect("outside dir");
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects",
        &cookie,
        Some(json!({"path": outside.to_string_lossy()})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "path is not allowed"}));

    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects",
        &cookie,
        Some(json!({"path": ""})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "Invalid payload"}));

    let missing = app.workspace.join("does-not-exist");
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/projects",
        &cookie,
        Some(json!({"path": missing.to_string_lossy()})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "path does not exist"}));
}
