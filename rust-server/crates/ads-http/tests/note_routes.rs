use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{StateDb, WorkspaceDb};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};
use tower::ServiceExt;

struct TestApp {
    _dir: TempDir,
    auth: Arc<AuthService>,
    router: Router,
}

fn test_app() -> TestApp {
    let dir = tempdir().expect("temp dir");
    let db = StateDb::open(dir.path().join("state.db")).expect("state db");
    let workspace_db =
        Arc::new(WorkspaceDb::open(dir.path().join("workspaces.db")).expect("workspace db"));
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
    auth.init_admin("admin", "secret-password")
        .expect("init admin");
    let router = build_router(
        Arc::clone(&auth),
        RouterConfig::new(
            CookieSecureMode::Never,
            vec![dir.path().to_path_buf()],
            HashSet::new(),
            workspace_db,
            dir.path().to_path_buf(),
        ),
    );
    TestApp {
        _dir: dir,
        auth,
        router,
    }
}

async fn login(router: &Router, username: &str, password: &str) -> String {
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "username": username, "password": password }).to_string(),
        ))
        .expect("login request");
    let response = router.clone().oneshot(request).await.expect("login");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("cookie")
        .to_str()
        .expect("cookie str")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string()
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    payload: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let body = if let Some(payload) = payload {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(payload.to_string())
    } else {
        Body::empty()
    };
    let response = router
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
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn notes_routes_require_authentication() {
    let app = test_app();
    let (status, _) = send(&app.router, "GET", "/api/notes?projectId=p1", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(
        &app.router,
        "POST",
        "/api/notes",
        None,
        Some(json!({ "projectId": "p1", "content": "Idea" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn notes_crud_filtering_archiving_and_user_isolation() {
    let app = test_app();
    let admin_cookie = login(&app.router, "admin", "secret-password").await;

    let (status, note_a) = send(
        &app.router,
        "POST",
        "/api/notes",
        Some(&admin_cookie),
        Some(json!({ "projectId": "proj-a", "content": "Investigate cache invalidation" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{note_a}");
    let note_a_id = note_a["id"].as_str().expect("note a id").to_string();
    assert_eq!(note_a["projectId"], json!("proj-a"));
    assert_eq!(note_a["isArchived"], json!(false));

    let (status, note_b) = send(
        &app.router,
        "POST",
        "/api/notes",
        Some(&admin_cookie),
        Some(json!({ "projectId": "proj-b", "content": "Refactor mobile swipe" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{note_b}");
    let note_b_id = note_b["id"].as_str().expect("note b id").to_string();

    let (status, _) = send(
        &app.router,
        "POST",
        "/api/notes",
        Some(&admin_cookie),
        Some(json!({ "projectId": "proj-a", "content": "   " })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, list_a) = send(
        &app.router,
        "GET",
        "/api/notes?projectId=proj-a",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list_a["notes"].as_array().expect("notes").len(), 1);
    assert_eq!(list_a["notes"][0]["id"], json!(note_a_id));

    let (status, list_all) = send(
        &app.router,
        "GET",
        "/api/notes?projectId=proj-a&all=true",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list_all["notes"].as_array().expect("notes").len(), 2);

    let (status, updated) = send(
        &app.router,
        "PATCH",
        &format!("/api/notes/{note_a_id}"),
        Some(&admin_cookie),
        Some(json!({ "content": "Updated note content", "is_archived": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["content"], json!("Updated note content"));
    assert_eq!(updated["isArchived"], json!(true));

    let (status, active_only) = send(
        &app.router,
        "GET",
        "/api/notes?projectId=proj-a",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(active_only["notes"].as_array().expect("notes").len(), 0);

    let (status, with_archived) = send(
        &app.router,
        "GET",
        "/api/notes?projectId=proj-a&includeArchived=true",
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(with_archived["notes"].as_array().expect("notes").len(), 1);

    ads_state::insert_user(
        app.auth.db(),
        "user-2",
        "bob",
        &hash_password_scrypt("bob-password"),
        1,
    )
    .expect("insert bob");
    let bob_cookie = login(&app.router, "bob", "bob-password").await;
    let (status, bob_list) = send(
        &app.router,
        "GET",
        "/api/notes?all=true&includeArchived=true",
        Some(&bob_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bob_list["notes"].as_array().expect("bob notes").len(), 0);

    let (status, _) = send(
        &app.router,
        "PATCH",
        &format!("/api/notes/{note_b_id}"),
        Some(&bob_cookie),
        Some(json!({ "content": "Hijacked" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send(
        &app.router,
        "DELETE",
        &format!("/api/notes/{note_b_id}"),
        Some(&bob_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, deleted) = send(
        &app.router,
        "DELETE",
        &format!("/api/notes/{note_b_id}"),
        Some(&admin_cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted, json!({ "success": true }));
}
