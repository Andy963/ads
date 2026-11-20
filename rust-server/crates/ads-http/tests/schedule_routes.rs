use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_contract::schedule::ScheduleSpec;
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_runtime::scheduler::{ScheduleCompileFuture, ScheduleCompileRequest, ScheduleCompiler};
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
    workspace: PathBuf,
    _directory: TempDir,
}

#[derive(Clone)]
struct FakeCompiler {
    spec: ScheduleSpec,
}

impl ScheduleCompiler for FakeCompiler {
    fn compile<'a>(&'a self, _request: ScheduleCompileRequest<'a>) -> ScheduleCompileFuture<'a> {
        let spec = self.spec.clone();
        Box::pin(async move { Ok(spec) })
    }
}

fn schedule_spec(questions: Vec<String>) -> ScheduleSpec {
    serde_json::from_value(json!({
        "version": 1,
        "name": "daily-sample",
        "enabled": true,
        "schedule": { "type": "cron", "cron": "0 9 * * *", "timezone": "UTC" },
        "instruction": "original",
        "delivery": {
            "channels": ["web"],
            "web": { "audience": "owner" },
            "telegram": { "chatId": null }
        },
        "policy": {
            "workspaceWrite": false,
            "network": "deny",
            "maxDurationMs": 600000,
            "maxRetries": 0,
            "concurrencyKey": "schedule:{scheduleId}",
            "idempotencyKeyTemplate": "sch:{scheduleId}:{runAtIso}"
        },
        "compiledTask": {
            "title": "Produce a sample report",
            "prompt": "Return a single JSON object.",
            "expectedResultSchema": { "type": "object" },
            "verification": { "commands": [] }
        },
        "questions": questions
    }))
    .expect("schedule spec")
}

fn test_app(spec: ScheduleSpec) -> TestApp {
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
    .with_workspace_state_dir(directory.path().join("state"))
    .with_schedule_compiler(Arc::new(FakeCompiler { spec }));
    TestApp {
        router: build_router(auth, config),
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

fn workspace_uri(path: &Path, suffix: &str) -> String {
    format!(
        "/api/schedules{suffix}?workspace={}",
        path.to_string_lossy().replace(' ', "%20")
    )
}

#[tokio::test]
async fn schedule_routes_create_list_enable_disable_and_list_runs() {
    let app = test_app(schedule_spec(Vec::new()));
    let cookie = login(&app.router).await;
    let create_uri = workspace_uri(&app.workspace, "");
    let (status, body) = send(
        &app.router,
        "POST",
        &create_uri,
        &cookie,
        Some(json!({ "instruction": "Every day at 09:00 UTC" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let schedule = &body["schedule"];
    let schedule_id = schedule["id"].as_str().expect("schedule id").to_string();
    assert_eq!(schedule["enabled"], true);
    assert_eq!(schedule["instruction"], "Every day at 09:00 UTC");
    assert!(schedule["nextRunAt"].as_i64().is_some());

    let (status, body) = send(&app.router, "GET", &create_uri, &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schedules"].as_array().expect("schedules").len(), 1);

    let disable_uri = workspace_uri(&app.workspace, &format!("/{schedule_id}/disable"));
    let (status, body) = send(&app.router, "POST", &disable_uri, &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["schedule"]["enabled"], false);
    assert_eq!(body["schedule"]["nextRunAt"], Value::Null);

    let enable_uri = workspace_uri(&app.workspace, &format!("/{schedule_id}/enable"));
    let (status, body) = send(&app.router, "POST", &enable_uri, &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["schedule"]["enabled"], true);
    assert!(body["schedule"]["nextRunAt"].as_i64().is_some());

    let runs_uri = workspace_uri(&app.workspace, &format!("/{schedule_id}/runs"));
    let (status, body) = send(&app.router, "GET", &runs_uri, &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["runs"], json!([]));
}

#[tokio::test]
async fn schedule_routes_require_clarification_before_enable() {
    let app = test_app(schedule_spec(vec![
        "Which Telegram chatId should receive the schedule result?".to_string(),
    ]));
    let cookie = login(&app.router).await;
    let (status, body) = send(
        &app.router,
        "POST",
        &workspace_uri(&app.workspace, ""),
        &cookie,
        Some(json!({ "instruction": "send a joke" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["schedule"]["enabled"], false);
    let schedule_id = body["schedule"]["id"].as_str().expect("schedule id");

    let (status, body) = send(
        &app.router,
        "POST",
        &workspace_uri(&app.workspace, &format!("/{schedule_id}/enable")),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body["questions"],
        json!(["Which Telegram chatId should receive the schedule result?"])
    );
}

#[tokio::test]
async fn schedule_routes_update_compiles_a_new_instruction() {
    let app = test_app(schedule_spec(Vec::new()));
    let cookie = login(&app.router).await;
    let (status, body) = send(
        &app.router,
        "POST",
        &workspace_uri(&app.workspace, ""),
        &cookie,
        Some(json!({ "instruction": "first" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let schedule_id = body["schedule"]["id"].as_str().expect("schedule id");

    let (status, body) = send(
        &app.router,
        "PATCH",
        &workspace_uri(&app.workspace, &format!("/{schedule_id}")),
        &cookie,
        Some(json!({ "instruction": "second" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["schedule"]["instruction"], "second");
    assert!(body["schedule"]["nextRunAt"].as_i64().is_some());
}
