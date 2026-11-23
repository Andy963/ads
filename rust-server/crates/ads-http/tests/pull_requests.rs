use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_contract::pull_requests::PullRequestListResponse;
use ads_http::{CookieSecureMode, GhRunner, RouterConfig, build_router};
use ads_state::{StateDb, UpsertWebProject, WorkspaceDb, insert_user, upsert_web_project};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const SAMPLE_PR_LIST: &str = r#"[
  {
    "number": 42,
    "title": "Fix project navigation",
    "url": "https://github.com/Andy963/ads/pull/42",
    "state": "OPEN",
    "isDraft": false,
    "author": { "login": "andy" },
    "updatedAt": "2026-11-20T10:00:00Z",
    "createdAt": "2026-11-19T10:00:00Z",
    "labels": [{ "name": "bug", "color": "d73a4a" }],
    "statusCheckRollup": [
      { "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/42" }
    ],
    "additions": 12,
    "deletions": 3,
    "headRefName": "fix/navigation",
    "baseRefName": "dev"
  },
  {
    "number": 43,
    "title": "Add PR workspace",
    "url": "https://github.com/Andy963/ads/pull/43",
    "state": "OPEN",
    "isDraft": true,
    "author": { "login": "andy" },
    "updatedAt": "2026-11-20T11:00:00Z",
    "createdAt": "2026-11-19T11:00:00Z",
    "labels": [],
    "statusCheckRollup": [{ "name": "test", "status": "IN_PROGRESS", "conclusion": "" }],
    "additions": 20,
    "deletions": 1,
    "headRefName": "feat/pr-workspace",
    "baseRefName": "dev"
  },
  {
    "number": 44,
    "title": "Retire stale path",
    "url": "https://github.com/Andy963/ads/pull/44",
    "state": "CLOSED",
    "isDraft": false,
    "author": { "login": "other" },
    "updatedAt": "2026-11-20T12:00:00Z",
    "createdAt": "2026-11-19T12:00:00Z",
    "labels": [{ "name": "chore", "color": "ffffff" }],
    "statusCheckRollup": [{ "name": "test", "status": "COMPLETED", "conclusion": "FAILURE" }],
    "additions": 4,
    "deletions": 8,
    "headRefName": "chore/path",
    "baseRefName": "dev"
  }
]"#;

fn sample_pr_detail() -> String {
    json!({
      "number": 42,
      "title": "Fix project navigation",
      "url": "https://github.com/Andy963/ads/pull/42",
      "state": "OPEN",
      "isDraft": false,
      "author": { "login": "andy" },
      "updatedAt": "2026-11-20T10:00:00Z",
      "createdAt": "2026-11-19T10:00:00Z",
      "labels": [{ "name": "bug", "color": "d73a4a" }],
      "statusCheckRollup": [
        { "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/42" }
      ],
      "additions": 12,
      "deletions": 3,
      "headRefName": "fix/navigation",
      "baseRefName": "dev",
      "body": "## Summary\nDetails",
      "mergeable": "MERGEABLE",
      "mergeStateStatus": "CLEAN",
      "reviewDecision": "APPROVED",
      "reviews": [{ "author": { "login": "reviewer" }, "state": "APPROVED", "submittedAt": "2026-11-20T12:00:00Z" }],
      "files": [{ "path": "client/src/App.vue", "additions": 2, "deletions": 1 }]
    }).to_string()
}

struct MockGhRunner {
    calls: AtomicUsize,
    recorded_args: std::sync::Mutex<Vec<Vec<String>>>,
    list_response: std::sync::Mutex<Result<String, String>>,
    detail_response: std::sync::Mutex<Result<String, String>>,
}

impl MockGhRunner {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            recorded_args: std::sync::Mutex::new(Vec::new()),
            list_response: std::sync::Mutex::new(Ok(SAMPLE_PR_LIST.to_string())),
            detail_response: std::sync::Mutex::new(Ok(sample_pr_detail())),
        }
    }
}

#[async_trait::async_trait]
impl GhRunner for MockGhRunner {
    async fn run(&self, args: &[String], _cwd: &Path) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.recorded_args.lock().unwrap().push(args.to_vec());
        if args.contains(&"view".to_string()) {
            self.detail_response.lock().unwrap().clone()
        } else {
            self.list_response.lock().unwrap().clone()
        }
    }
}

struct TestContext {
    router: Router,
    runner: Arc<MockGhRunner>,
    cookie: String,
    _directory: TempDir,
}

async fn setup_app(runner: Arc<MockGhRunner>) -> TestContext {
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

    let conn = db.connect().expect("conn");
    upsert_web_project(
        &conn,
        UpsertWebProject {
            user_id: "user-1",
            project_id: "p1",
            workspace_root: "/repo/p1",
            name: "Project 1",
            chat_session_id: Some("main"),
        },
        1_700_000_000,
    )
    .expect("upsert project");

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
    std::fs::create_dir_all(&workspace).expect("workspace dir");
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        HashSet::new(),
        workspace_db,
        workspace.clone(),
    )
    .with_gh_runner(runner.clone());

    let router = build_router(auth, config);
    let cookie = login(&router).await;

    TestContext {
        router,
        runner,
        cookie,
        _directory: directory,
    }
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
        .expect("cookie")
        .to_str()
        .expect("utf8")
        .to_string()
}

async fn send_request(app: &Router, uri: &str, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method("GET").uri(uri);
    if let Some(c) = cookie {
        builder = builder.header(header::COOKIE, c);
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
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

#[tokio::test]
async fn test_pull_requests_list_requires_auth_and_project_id() {
    let runner = Arc::new(MockGhRunner::new());
    let ctx = setup_app(runner).await;

    // Unauthorized when no session cookie
    let (status, val) =
        send_request(&ctx.router, "/api/pull-requests?projectId=default", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(val["error"], "Unauthorized");

    // 400 when projectId missing
    let (status, val) = send_request(&ctx.router, "/api/pull-requests", Some(&ctx.cookie)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(val["error"], "projectId is required");

    // 404 when project not found
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=nonexistent",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(val["error"], "Project not found");

    // 400 when invalid filters
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=default&state=invalid",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(val["error"], "Invalid pull request filters");
}

#[tokio::test]
async fn test_pull_requests_list_pagination_and_fields() {
    let runner = Arc::new(MockGhRunner::new());
    let ctx = setup_app(runner).await;

    // Request page 1 with limit=2
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1&limit=2",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list: PullRequestListResponse = serde_json::from_value(val).expect("valid list response");
    assert_eq!(list.items.len(), 2);
    assert_eq!(list.items[0].number, 42);
    assert_eq!(list.items[0].repository, "Andy963/ads");
    assert_eq!(list.items[0].author, "andy");
    assert_eq!(list.items[0].checks, "passing");
    assert_eq!(list.items[0].additions, 12);
    assert_eq!(list.items[0].deletions, 3);
    assert_eq!(list.items[1].number, 43);
    assert_eq!(list.items[1].checks, "pending");
    assert!(list.next_cursor.is_some());

    let cursor = list.next_cursor.unwrap();

    // Request page 2 using next_cursor
    let (status, val2) = send_request(
        &ctx.router,
        &format!("/api/pull-requests?projectId=p1&limit=2&cursor={cursor}"),
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list2: PullRequestListResponse =
        serde_json::from_value(val2).expect("valid list response 2");
    assert_eq!(list2.items.len(), 1);
    assert_eq!(list2.items[0].number, 44);
    assert_eq!(list2.items[0].checks, "failing");
    assert!(list2.next_cursor.is_none());
}

#[tokio::test]
async fn test_pull_requests_search_terms_mapping() {
    let runner = Arc::new(MockGhRunner::new());
    let ctx = setup_app(runner).await;

    let (status, _) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1&state=merged&involvement=review-requested&label=ready%20for%20review&author=andy&checks=failing",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let args = ctx.runner.recorded_args.lock().unwrap();
    let last_call = args.last().expect("last call");
    assert!(last_call.contains(&"--state".to_string()));
    assert!(last_call.contains(&"merged".to_string()));
    let search_idx = last_call
        .iter()
        .position(|r| r == "--search")
        .expect("search arg");
    let search_str = &last_call[search_idx + 1];
    assert!(search_str.contains("review-requested:@me"));
    assert!(search_str.contains(r#"label:"ready for review""#));
    assert!(search_str.contains(r#"author:"andy""#));
    assert!(search_str.contains("status:failure"));
}

#[tokio::test]
async fn test_pull_requests_caching_and_refresh() {
    let runner = Arc::new(MockGhRunner::new());
    let ctx = setup_app(runner).await;

    // First call -> runner call count 1
    let (status, _) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctx.runner.calls.load(Ordering::SeqCst), 1);

    // Second call -> cached, runner call count remains 1
    let (status, _) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctx.runner.calls.load(Ordering::SeqCst), 1);

    // Call with refresh=1 -> cache invalidated, runner call count becomes 2
    let (status, _) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1&refresh=1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ctx.runner.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn test_pull_requests_detail() {
    let runner = Arc::new(MockGhRunner::new());
    let ctx = setup_app(runner).await;

    // Detail endpoint requires projectId
    let (status, val) = send_request(&ctx.router, "/api/pull-requests/42", Some(&ctx.cookie)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(val["error"], "projectId is required");

    // Invalid PR number
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests/0?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(val["error"], "Invalid pull request number");

    // Success detail
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests/42?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["item"]["number"], 42);
    assert_eq!(val["item"]["title"], "Fix project navigation");
    assert_eq!(val["item"]["body"], "## Summary\nDetails");
    assert_eq!(val["item"]["mergeable"], "MERGEABLE");
    assert_eq!(val["item"]["checksDetail"][0]["name"], "test");
    assert_eq!(val["item"]["reviews"][0]["author"], "reviewer");
    assert_eq!(val["item"]["files"][0]["path"], "client/src/App.vue");
}

#[tokio::test]
async fn test_pull_requests_failure_handling() {
    let runner = Arc::new(MockGhRunner::new());
    *runner.list_response.lock().unwrap() = Err("gh: command not found".to_string());
    *runner.detail_response.lock().unwrap() = Err("gh: timeout".to_string());
    let ctx = setup_app(runner).await;

    // List endpoint returns 200 with error property on failure
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(val["items"], json!([]));
    assert_eq!(val["error"], "gh: command not found");

    // Detail endpoint returns 502 with error property on failure
    let (status, val) = send_request(
        &ctx.router,
        "/api/pull-requests/42?projectId=p1",
        Some(&ctx.cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(val["error"], "gh: timeout");
}
