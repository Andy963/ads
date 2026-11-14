use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ads_actions::{ReviewQueue, ReviewQueueOptions};
use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{
    ActionJobIssueSnapshot, ActionJobKind, ActionJobStatus, CreateActionJob, StateDb,
    UpsertWebProject, WorkspaceDb, create_action_job, derive_project_session_id,
    ensure_web_project_tables, insert_user, upsert_web_project,
};
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
    project_id: String,
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
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace_root = workspace.to_string_lossy().to_string();
    let project_id = derive_project_session_id(&workspace_root);
    {
        let connection = db.connect().expect("connection");
        ensure_web_project_tables(&connection).expect("project tables");
        upsert_web_project(
            &connection,
            UpsertWebProject {
                user_id: "user-1",
                project_id: &project_id,
                workspace_root: &workspace_root,
                name: "Workspace",
                chat_session_id: Some("main"),
            },
            1_700_000_000_000,
        )
        .expect("project");
        create_action_job(
            &connection,
            CreateActionJob {
                id: "job-1".to_string(),
                project_id: project_id.clone(),
                lane_generation: Some(2),
                job_kind: ActionJobKind::PullRequestReview,
                issue_id: 7,
                issue_title: "Fix the bug".to_string(),
                issue_snapshot: ActionJobIssueSnapshot::default(),
                status: Some(ActionJobStatus::Completed),
                branch: "codex/issue-7".to_string(),
                base_sha: "base".to_string(),
                head_sha: "head".to_string(),
                reviewer_profile_ids_json: "[]".to_string(),
                pr_number: 12,
                pr_url: "https://example.test/pr/12".to_string(),
                auth_user_id: "user-1".to_string(),
                chat_session_id: "main".to_string(),
            },
            1_700_000_000_000,
        )
        .expect("job");
    }
    let review_queue = Arc::new(ReviewQueue::new(
        db.clone(),
        "route-test",
        ReviewQueueOptions::default(),
    ));
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
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        HashSet::new(),
        workspace_db,
        workspace.clone(),
    )
    .with_review_queue(review_queue)
    .with_workspace_state_dir(directory.path().join("state"));
    TestApp {
        router: build_router(auth, config),
        workspace,
        project_id,
        _directory: directory,
    }
}

async fn send(app: &Router, method: &str, uri: &str, cookie: &str) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !cookie.is_empty() {
        builder = builder.header(header::COOKIE, cookie);
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
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string()
}

#[tokio::test]
async fn action_jobs_require_authentication_and_an_owned_project() {
    let app = test_app();
    let (status, body) = send(
        &app.router,
        "GET",
        "/api/actions/jobs?projectId=missing",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({"error": "Unauthorized"}));

    let cookie = login(&app.router).await;
    let (status, body) = send(
        &app.router,
        "GET",
        "/api/actions/jobs?projectId=missing",
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"error": "Invalid or unauthorized project 'missing'"})
    );
}

#[tokio::test]
async fn action_jobs_list_public_rows_by_project_id_or_workspace() {
    let app = test_app();
    let cookie = login(&app.router).await;
    for candidate in [
        app.project_id.clone(),
        app.workspace.to_string_lossy().to_string(),
    ] {
        let uri = format!("/api/actions/jobs?projectId={candidate}");
        let (status, body) = send(&app.router, "GET", &uri, &cookie).await;
        assert_eq!(status, StatusCode::OK);
        let jobs = body.as_array().expect("jobs array");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["id"], "job-1");
        assert_eq!(jobs[0]["project_id"], app.project_id);
        assert!(jobs[0].get("auth_user_id").is_none());
        assert!(jobs[0].get("chat_session_id").is_none());
    }
    for uri in [
        format!(
            "/api/actions/jobs?workspace={}",
            app.workspace.to_string_lossy()
        ),
        "/api/actions/jobs".to_string(),
    ] {
        let (status, body) = send(&app.router, "GET", &uri, &cookie).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().expect("jobs array").len(), 1);
    }
}

#[tokio::test]
async fn retired_action_posts_return_gone() {
    let app = test_app();
    let cookie = login(&app.router).await;
    for (path, message) in [
        (
            "/api/actions/dispatch",
            "Asynchronous Actions dispatch is retired; implement in Acopilot.",
        ),
        (
            "/api/actions/queue/start",
            "Asynchronous Actions queue execution is retired; continue in Acopilot.",
        ),
        (
            "/api/actions/jobs/job-1",
            "Asynchronous Actions job operations are retired; continue implementation and review in Acopilot.",
        ),
    ] {
        let (status, body) = send(&app.router, "POST", path, &cookie).await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(body, json!({"error": message}));
    }
}
