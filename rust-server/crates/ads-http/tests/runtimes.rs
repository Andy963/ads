use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_acp::{
    AcpDriver, AgyDriver, ConfigOptionsState, DesiredConfigAlignment, resolve_agy_profile_dir,
};
use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{
    AGY_DEFAULT_AGENT_ID, CODEX_AGENT_ID, CookieSecureMode, NATIVE_AGENT_ID, RouterConfig,
    RoutingPromptRunner, RuntimeRegistry, RuntimeRegistryConfig, WebSocketConfig, WebSocketHub,
    build_router,
};
use ads_runtime::scheduler::{ScheduleExecuteFuture, ScheduleExecutor, SchedulerExecutionInput};
use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueFuture, PromptQueueRunOutcome,
    PromptQueueRunner, PromptRunContext,
};
use ads_state::{
    HistoryStore, StateDb, StateResult, WEB_ACTIONS_NAMESPACE, WorkspaceDb, insert_user,
};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

struct RecordingNativeRunner {
    calls: Mutex<Vec<String>>,
    aborted: Mutex<Vec<String>>,
}

impl RecordingNativeRunner {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            aborted: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls lock").clone()
    }

    fn aborted(&self) -> Vec<String> {
        self.aborted.lock().expect("aborted lock").clone()
    }
}

impl PromptQueueRunner for RecordingNativeRunner {
    fn run_lane_turn<'a>(
        &'a self,
        entry: LaneTurn,
        context: PromptRunContext,
    ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
        Box::pin(async move {
            let text = entry
                .payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            self.calls.lock().expect("calls lock").push(text.clone());
            let reply = format!("native-echo: {text}");
            context.emit(json!({
                "type": "result",
                "ok": true,
                "output": reply,
                "activeAgentId": NATIVE_AGENT_ID,
                "client_message_id": entry.client_message_id,
            }));
            Ok(PromptQueueRunOutcome::success())
        })
    }

    fn abort_lane_turn(&self, entry: &LaneTurn) {
        self.aborted
            .lock()
            .expect("aborted lock")
            .push(entry.client_message_id.clone());
    }
}

impl ScheduleExecutor for RecordingNativeRunner {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a> {
        Box::pin(async move { Ok(format!("scheduled-ok: {}", input.prompt)) })
    }
}

fn write_mock_agy_script(dir: &Path, isolated_root: &Path) -> PathBuf {
    let script_path = dir.join("mock-agy.py");
    let isolated_root_escaped = isolated_root.to_string_lossy().replace('\\', "\\\\");
    let script = format!(
        r#"#!/usr/bin/env python3
import json, os, sys

ISOLATED_ROOT = "{isolated_root_escaped}"

args = sys.argv[1:]
if "--version" in args:
    print("1.5.18")
    sys.exit(0)

if "--login" in args:
    print("Please visit the following URL to authorize the application:", flush=True)
    print("https://accounts.google.com/o/oauth2/auth?response_type=code&state=teststate&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback", flush=True)
    line = sys.stdin.readline().strip()
    if line == "ok-code":
        home = os.environ.get("GEMINI_HOME")
        if home:
            acp_dir = os.path.join(home, "antigravity-acp")
            os.makedirs(acp_dir, exist_ok=True)
            with open(os.path.join(acp_dir, "antigravity-oauth-token"), "w") as fh:
                json.dump({{
                    "token": "super-secret-oauth-token",
                    "auth_method": "oauth-personal",
                    "id_token_email": "work.user@example.com"
                }}, fh)
        print("Authentication successful.", flush=True)
        sys.exit(0)
    print("Invalid authorization code", file=sys.stderr, flush=True)
    sys.exit(1)

def is_authenticated():
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return True
    home = os.environ.get("GEMINI_HOME", "").strip()
    if not home or not home.startswith(ISOLATED_ROOT):
        # Host default profile is treated as pre-authenticated in tests.
        return True
    acp_dir = os.path.join(home, "antigravity-acp")
    return (
        os.path.exists(os.path.join(acp_dir, "antigravity-oauth-token"))
        or os.path.exists(os.path.join(acp_dir, "oauth_creds.json"))
    )

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({{
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {{
                "protocolVersion": 1,
                "agentInfo": {{"name": "antigravity", "version": "1.5.18"}},
                "agentCapabilities": {{}},
                "authMethods": [{{"id": "oauth-personal", "name": "Google OAuth"}}]
            }}
        }})
    elif method == "session/new":
        if not is_authenticated():
            send({{
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {{"code": -32000, "message": "Authentication required"}}
            }})
            continue
        send({{
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {{
                "sessionId": "agy-sess-1",
                "_meta": {{
                    "antigravity": {{
                        "tier": {{
                            "id": "g1-pro-tier",
                            "name": "Google AI Pro"
                        }}
                    }}
                }},
                "configOptions": [
                    {{
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "gemini-2.5-pro",
                        "options": [
                            {{"value": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"}},
                            {{"value": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"}}
                        ]
                    }},
                    {{
                        "id": "thought_level",
                        "name": "Thinking",
                        "category": "thought_level",
                        "type": "select",
                        "currentValue": "medium",
                        "options": [
                            {{"value": "low", "name": "Low"}},
                            {{"value": "medium", "name": "Medium"}},
                            {{"value": "high", "name": "High"}}
                        ]
                    }}
                ]
            }}
        }})
    elif method == "session/set_config_option":
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{"configOptions": []}}}})
    elif method == "session/set_mode":
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{}}}})
    elif method == "session/prompt":
        params = msg.get("params") or {{}}
        session_id = params.get("sessionId", "agy-sess-1")
        blocks = params.get("prompt") or []
        text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        send({{
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {{
                "sessionId": session_id,
                "update": {{
                    "sessionUpdate": "agent_message_chunk",
                    "content": {{"type": "text", "text": f"{{text}} [via-mock-agy]"}}
                }}
            }}
        }})
        send({{
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {{"stopReason": "end_turn"}}
        }})
    elif req_id is not None:
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{}}}})
"#
    );
    fs::write(&script_path, script).expect("write mock agy script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }
    script_path
}

struct TestRuntimeFixture {
    app: Router,
    db: StateDb,
    state_dir: PathBuf,
    registry: Arc<RuntimeRegistry>,
    native_runner: Arc<RecordingNativeRunner>,
    _dir: TempDir,
}

fn build_runtime_fixture() -> TestRuntimeFixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(dir.path().join("state.db")).expect("state db");
    insert_user(
        &db,
        "user-1",
        "admin",
        &hash_password_scrypt("secret"),
        1_700_000_000,
    )
    .expect("user");
    let auth = Arc::new(AuthService::new(
        db.clone(),
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    ));
    let workspace = dir.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    let workspace_db =
        Arc::new(WorkspaceDb::open(dir.path().join("workspaces.db")).expect("workspaces db"));

    let mock_agy = write_mock_agy_script(dir.path(), &state_dir.join("providers").join("agy"));
    let native_runner = Arc::new(RecordingNativeRunner::new());

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir.clone(), workspace.clone());
    reg_cfg.preferred_default_agent_id = NATIVE_AGENT_ID.to_string();
    reg_cfg.native_runner = Some(native_runner.clone());
    reg_cfg.native_scheduler = Some(native_runner.clone());
    reg_cfg.codex_acp_binary = dir
        .path()
        .join("definitely-missing-codex-acp-bin")
        .to_string_lossy()
        .to_string();
    reg_cfg.agy_binary = mock_agy.to_string_lossy().to_string();
    reg_cfg.agy_probe_timeout = Duration::from_secs(10);

    let registry = RuntimeRegistry::new(reg_cfg);
    let routing_runner = Arc::new(RoutingPromptRunner::new(Arc::clone(&registry)));
    let ws_hub = Arc::new(WebSocketHub::new(WebSocketConfig::default()));

    let mut origins = HashSet::new();
    origins.insert("http://localhost".to_string());
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        origins,
        workspace_db,
        workspace,
    )
    .with_workspace_state_dir(state_dir.clone())
    .with_websocket_hub(ws_hub)
    .with_prompt_queue_runner(routing_runner)
    .with_runtime_registry(Arc::clone(&registry));

    let app = build_router(auth, config);
    TestRuntimeFixture {
        app,
        db,
        state_dir,
        registry,
        native_runner,
        _dir: dir,
    }
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

async fn login_cookie(app: &Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost")
                .body(Body::from(r#"{"username":"admin","password":"secret"}"#))
                .expect("login"),
        )
        .await
        .expect("login response");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie str")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string()
}

async fn authed_request(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, "http://localhost");
    let req_body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(req_body).expect("authed request"))
        .await
        .expect("authed response");
    let status = response.status();
    let json_body = response_json(response).await;
    (status, json_body)
}

#[tokio::test]
async fn startup_probe_lists_runtimes_and_merges_discovered_agy_models_into_api_models() {
    let fixture = build_runtime_fixture();

    // Unauthenticated request must be rejected.
    let unauth = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/runtimes")
                .body(Body::empty())
                .expect("unauth request"),
        )
        .await
        .expect("unauth response");
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    fixture.registry.probe_all().await;
    let cookie = login_cookie(&fixture.app).await;

    let runtimes_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/runtimes")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("runtimes request"),
        )
        .await
        .expect("runtimes response");
    assert_eq!(runtimes_resp.status(), StatusCode::OK);
    let snapshot = response_json(runtimes_resp).await;
    assert_eq!(snapshot["activeAgentId"], NATIVE_AGENT_ID);
    let agents = snapshot["agents"].as_array().expect("agents array");
    let native = agents
        .iter()
        .find(|a| a["id"] == NATIVE_AGENT_ID)
        .expect("native");
    assert_eq!(native["ready"], true);
    let codex = agents
        .iter()
        .find(|a| a["id"] == CODEX_AGENT_ID)
        .expect("codex");
    assert_eq!(codex["ready"], false);
    let agy = agents
        .iter()
        .find(|a| a["id"] == AGY_DEFAULT_AGENT_ID)
        .expect("agy");
    assert_eq!(agy["ready"], true);
    assert_eq!(agy["version"], "1.5.18");

    // GET /api/models merges discovered agy models with allowedAgents & reasoningEfforts.
    let models_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/models")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .expect("models request"),
        )
        .await
        .expect("models response");
    assert_eq!(models_resp.status(), StatusCode::OK);
    let models = response_json(models_resp).await;
    let models = models.as_array().expect("models array");
    let pro = models
        .iter()
        .find(|m| m["modelId"] == "gemini-2.5-pro")
        .expect("gemini-2.5-pro discovered");
    assert_eq!(pro["provider"], "antigravity");
    assert_eq!(pro["configJson"]["allowedAgents"], json!(["agy"]));
    assert_eq!(
        pro["configJson"]["reasoningEfforts"],
        json!(["low", "medium", "high"])
    );

    fixture.registry.shutdown_all().await;
}

#[tokio::test]
async fn multi_account_agy_crud_encrypted_api_key_and_headless_oauth_flow() {
    let fixture = build_runtime_fixture();
    fixture.registry.probe_all().await;
    let cookie = login_cookie(&fixture.app).await;

    // 1. Create an API-key account and verify key is encrypted (never plaintext in kv_state or settings.json).
    let secret_key = "AIza-super-secret-test-key-9999";
    let create_api_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtimes/agy/accounts")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "label": "API Key Account",
                        "authMethod": "gemini-api-key",
                        "apiKey": secret_key,
                    })
                    .to_string(),
                ))
                .expect("create api account"),
        )
        .await
        .expect("create api response");
    assert_eq!(create_api_resp.status(), StatusCode::OK);
    let api_account = response_json(create_api_resp).await;
    let api_account_id = api_account["id"].as_str().expect("id").to_string();
    assert_eq!(api_account["ready"], true);
    assert_eq!(api_account["hasApiKey"], true);
    assert_eq!(api_account["modelCount"], 2);
    assert!(!api_account.to_string().contains(secret_key));

    // Check kv_state web_agy_accounts and profile settings.json never store plaintext API key.
    {
        let conn = fixture.db.connect().expect("db conn");
        let kv_value: String = conn
            .query_row(
                "SELECT value FROM kv_state WHERE namespace = 'web_agy_accounts' AND key = ?1",
                [&api_account_id],
                |row| row.get(0),
            )
            .expect("kv row");
        assert!(!kv_value.contains(secret_key));

        let mut stmt = conn
            .prepare("SELECT value FROM kv_state WHERE namespace = 'web_upstream_credentials'")
            .expect("cred stmt");
        let cred_rows: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("cred query")
            .filter_map(Result::ok)
            .collect();
        assert!(
            !cred_rows.is_empty(),
            "expected encrypted credential row in web_upstream_credentials"
        );
        for cred_raw in &cred_rows {
            assert!(
                !cred_raw.contains(secret_key),
                "credential row must be encrypted, not plaintext"
            );
        }
    }
    let api_profile_dir = resolve_agy_profile_dir(&fixture.state_dir, &api_account_id);
    let settings_json_path = api_profile_dir
        .join("antigravity-acp")
        .join("settings.json");
    assert!(
        settings_json_path.exists(),
        "expected isolated settings.json at {}",
        settings_json_path.display()
    );
    let settings_text = fs::read_to_string(&settings_json_path).expect("settings.json");
    assert!(!settings_text.contains(secret_key));

    // Verify reserved 'agy' and path-traversal account IDs are rejected.
    for bad_id in ["agy", "default", "../escape", "bad/id"] {
        let resp = fixture
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/runtimes/agy/accounts")
                    .header(header::COOKIE, &cookie)
                    .header(header::ORIGIN, "http://localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "id": bad_id,
                            "label": "Invalid",
                            "authMethod": "oauth-personal",
                        })
                        .to_string(),
                    ))
                    .expect("bad id req"),
            )
            .await
            .expect("bad id resp");
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "expected 400 for account id '{bad_id}'"
        );
    }

    // Disallowed CSRF Origin must be rejected with 403 Forbidden.
    let csrf_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtimes/refresh")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "https://evil.example")
                .body(Body::empty())
                .expect("csrf req"),
        )
        .await
        .expect("csrf resp");
    assert_eq!(csrf_resp.status(), StatusCode::FORBIDDEN);

    // 2. Create an isolated OAuth account, run headless start -> complete -> logout -> delete.
    let create_oauth_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/runtimes/agy/accounts")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "label": "Work Google",
                        "authMethod": "oauth-personal",
                    })
                    .to_string(),
                ))
                .expect("create oauth account"),
        )
        .await
        .expect("create oauth response");
    assert_eq!(create_oauth_resp.status(), StatusCode::OK);
    let oauth_account = response_json(create_oauth_resp).await;
    let oauth_id = oauth_account["id"].as_str().expect("oauth id").to_string();
    assert_eq!(oauth_account["ready"], false);
    assert_eq!(oauth_account["status"], "authentication_required");

    let start_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/runtimes/agy/accounts/{oauth_id}/login/start"))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .expect("start login"),
        )
        .await
        .expect("start login response");
    assert_eq!(start_resp.status(), StatusCode::OK);
    let started = response_json(start_resp).await;
    assert!(
        started["authorizationUrl"]
            .as_str()
            .expect("auth url")
            .starts_with("https://accounts.google.com/o/oauth2/auth?")
    );

    // Verify malformed code returns 400 WITHOUT killing the live login subprocess,
    // so retrying immediately with the valid code succeeds.
    let bad_code_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/runtimes/agy/accounts/{oauth_id}/login/complete"
                ))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "code": "https://evil.example/cb?code=x&state=wrong" }).to_string(),
                ))
                .expect("bad complete login"),
        )
        .await
        .expect("bad complete login response");
    assert_eq!(bad_code_resp.status(), StatusCode::BAD_REQUEST);

    let complete_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/runtimes/agy/accounts/{oauth_id}/login/complete"
                ))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "code": "ok-code" }).to_string()))
                .expect("complete login"),
        )
        .await
        .expect("complete login response");
    assert_eq!(complete_resp.status(), StatusCode::OK);
    let completed = response_json(complete_resp).await;
    assert_eq!(completed["ready"], true);
    assert_eq!(completed["modelCount"], 2);
    assert_eq!(completed["loginPending"], false);

    let oauth_profile_dir = resolve_agy_profile_dir(&fixture.state_dir, &oauth_id);
    assert!(
        oauth_profile_dir
            .join("antigravity-acp")
            .join("antigravity-oauth-token")
            .exists(),
        "expected antigravity-oauth-token inside hashed antigravity-acp profile dir"
    );

    // Logout removes credentials on disk; re-probing via /refresh confirms authentication_required.
    let logout_resp = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/runtimes/agy/accounts/{oauth_id}/logout"))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .expect("logout"),
        )
        .await
        .expect("logout response");
    assert_eq!(logout_resp.status(), StatusCode::OK);
    let logged_out = response_json(logout_resp).await;
    assert_eq!(logged_out["ready"], false);
    assert_eq!(logged_out["status"], "authentication_required");
    assert!(
        !oauth_profile_dir
            .join("antigravity-acp")
            .join("antigravity-oauth-token")
            .exists(),
        "logout must delete antigravity-oauth-token on disk"
    );

    let refresh_after_logout = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/runtimes/agy/accounts/{oauth_id}/refresh"))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .expect("refresh after logout"),
        )
        .await
        .expect("refresh after logout resp");
    assert_eq!(refresh_after_logout.status(), StatusCode::OK);
    let refreshed = response_json(refresh_after_logout).await;
    assert_eq!(refreshed["ready"], false);
    assert_eq!(refreshed["status"], "authentication_required");

    // Deleting built-in default profile is rejected.
    let del_default = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/runtimes/agy/accounts/default")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .expect("delete default"),
        )
        .await
        .expect("delete default resp");
    assert_eq!(del_default.status(), StatusCode::BAD_REQUEST);

    // Deleting isolated account succeeds and removes the hashed profile directory.
    assert!(
        oauth_profile_dir.exists(),
        "expected hashed profile dir to exist before deletion"
    );
    let del_oauth = fixture
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/runtimes/agy/accounts/{oauth_id}"))
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost")
                .body(Body::empty())
                .expect("delete oauth"),
        )
        .await
        .expect("delete oauth resp");
    assert_eq!(del_oauth.status(), StatusCode::OK);
    assert!(
        !oauth_profile_dir.exists(),
        "expected hashed profile dir to be deleted"
    );

    fixture.registry.shutdown_all().await;
}

async fn recv_json_frame(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(item) = ws.next().await {
            let msg = item.expect("ws msg");
            if let Message::Text(text) = msg {
                return serde_json::from_str::<Value>(&text).expect("json ws frame");
            }
        }
        panic!("websocket closed before expected frame");
    })
    .await
    .expect("ws frame timeout")
}

async fn recv_frame_of_type(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    expected_type: &str,
) -> Value {
    for _ in 0..20 {
        let frame = recv_json_frame(ws).await;
        if frame["type"] == expected_type {
            return frame;
        }
    }
    panic!("did not receive frame of type '{expected_type}'");
}

#[tokio::test]
async fn ws_set_agent_persists_per_lane_and_routes_prompts_dynamically() {
    let fixture = build_runtime_fixture();
    fixture.registry.probe_all().await;
    let cookie = login_cookie(&fixture.app).await;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = fixture.app.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let ws_url = format!("ws://{addr}/ws?session=proj-1&chat_session_id=main");
    let connect_ws = || {
        let req = Request::builder()
            .method("GET")
            .uri(&ws_url)
            .header(header::HOST, addr.to_string())
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .header(
                header::SEC_WEBSOCKET_PROTOCOL,
                "ads-session.proj-1, ads-chat.main",
            )
            .header(header::COOKIE, &cookie)
            .header(header::ORIGIN, "http://localhost")
            .body(())
            .expect("ws req");
        connect_async(req)
    };

    let (mut ws, _) = connect_ws().await.expect("ws connect");
    let welcome = recv_frame_of_type(&mut ws, "welcome").await;
    assert_eq!(welcome["activeAgentId"], NATIVE_AGENT_ID);

    let agents_frame = recv_frame_of_type(&mut ws, "agents").await;
    assert_eq!(agents_frame["activeAgentId"], NATIVE_AGENT_ID);

    // Reject switching to unready codex runtime.
    ws.send(Message::Text(
        json!({ "type": "set_agent", "payload": { "agentId": CODEX_AGENT_ID } })
            .to_string()
            .into(),
    ))
    .await
    .expect("send set_agent codex");
    let err_frame = recv_frame_of_type(&mut ws, "error").await;
    assert_eq!(err_frame["type"], "error");
    let revert_agents = recv_frame_of_type(&mut ws, "agents").await;
    assert_eq!(revert_agents["activeAgentId"], NATIVE_AGENT_ID);

    // Switch to ready `agy` runtime.
    ws.send(Message::Text(
        json!({ "type": "set_agent", "payload": { "agentId": AGY_DEFAULT_AGENT_ID } })
            .to_string()
            .into(),
    ))
    .await
    .expect("send set_agent agy");
    let switched = recv_frame_of_type(&mut ws, "agents").await;
    assert_eq!(switched["activeAgentId"], AGY_DEFAULT_AGENT_ID);

    // Send a prompt -> routed to mock `agy`.
    ws.send(Message::Text(
        json!({
            "type": "prompt",
            "client_message_id": "cm-agy-1",
            "payload": { "text": "hello antigravity", "model": "gemini-2.5-pro" }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send agy prompt");

    let mut saw_agy_result = false;
    for _ in 0..30 {
        let frame = recv_json_frame(&mut ws).await;
        if frame["type"] == "error" {
            panic!("unexpected ws error during agy prompt: {frame}");
        }
        let matches_id =
            frame["client_message_id"] == "cm-agy-1" || frame["clientMessageId"] == "cm-agy-1";
        if frame["type"] == "result" && matches_id {
            assert_eq!(frame["activeAgentId"], AGY_DEFAULT_AGENT_ID);
            assert!(
                frame["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("[via-mock-agy]")
            );
            saw_agy_result = true;
            break;
        }
    }
    assert!(saw_agy_result, "expected result frame from mock agy");
    drop(ws);

    // Reconnect on the same lane: persisted `agy` preference must survive reconnect.
    let (mut ws2, _) = connect_ws().await.expect("ws2 connect");
    let welcome2 = recv_json_frame(&mut ws2).await;
    assert_eq!(welcome2["type"], "welcome");
    assert_eq!(welcome2["activeAgentId"], AGY_DEFAULT_AGENT_ID);

    // Drain initial agents/history frames until we switch back to `native`.
    ws2.send(Message::Text(
        json!({ "type": "set_agent", "payload": { "agentId": NATIVE_AGENT_ID } })
            .to_string()
            .into(),
    ))
    .await
    .expect("switch back to native");

    let mut switched_native = false;
    for _ in 0..10 {
        let frame = recv_json_frame(&mut ws2).await;
        if frame["type"] == "agents" && frame["activeAgentId"] == NATIVE_AGENT_ID {
            switched_native = true;
            break;
        }
    }
    assert!(switched_native, "expected agents frame switching to native");

    // Send follow-up prompt -> routed to Native runner on the same lane.
    ws2.send(Message::Text(
        json!({
            "type": "prompt",
            "client_message_id": "cm-native-2",
            "payload": { "text": "follow up native" }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send native prompt");

    let mut saw_native_result = false;
    for _ in 0..30 {
        let frame = recv_json_frame(&mut ws2).await;
        if frame["type"] == "error" {
            panic!("unexpected ws error during native prompt: {frame}");
        }
        let matches_id = frame["client_message_id"] == "cm-native-2"
            || frame["clientMessageId"] == "cm-native-2";
        if frame["type"] == "result" && matches_id {
            assert_eq!(frame["activeAgentId"], NATIVE_AGENT_ID);
            assert_eq!(frame["output"], "native-echo: follow up native");
            saw_native_result = true;
            break;
        }
    }
    assert!(
        saw_native_result,
        "expected result frame from native runner"
    );
    assert_eq!(
        fixture.native_runner.calls(),
        vec!["follow up native".to_string()]
    );

    // Verify shared HistoryStore holds the agy turn for ADR 0028 continuity.
    let conn = fixture.db.connect().expect("db conn");
    let history = HistoryStore::new(WEB_ACTIONS_NAMESPACE, 200, 100_000);
    let entries = history
        .get(&conn, "user-1::proj-1::main")
        .expect("history entries");
    assert!(
        entries
            .iter()
            .any(|e| e.role == "ai" && e.text.contains("[via-mock-agy]"))
    );

    drop(ws2);
    server.abort();
    fixture.registry.shutdown_all().await;
}

#[tokio::test]
async fn handoff_turns_abort_scheduler_model_collision_and_multiplexed_broadcast() {
    let fixture = build_runtime_fixture();
    fixture.registry.probe_all().await;

    // 1. Model ID collision prefixing (`agy:`) and AgyDriver stripping in map_model_id / resolve_alignment.
    let mut existing_ids = HashSet::new();
    existing_ids.insert("gemini-2.5-pro".to_string());
    let merged = fixture.registry.discovered_agy_models(&existing_ids);
    let collided = merged
        .iter()
        .find(|m| m.model_id == "gemini-2.5-pro")
        .expect("collided model");
    assert_eq!(collided.id, "agy:gemini-2.5-pro");
    let driver = AgyDriver::from_env();
    assert_eq!(driver.map_model_id("agy:gemini-2.5-pro"), "gemini-2.5-pro");
    let aligned = driver.resolve_alignment(
        &ConfigOptionsState::default(),
        None,
        DesiredConfigAlignment {
            model: Some("agy:gemini-2.5-pro".to_string()),
            ..DesiredConfigAlignment::default()
        },
    );
    assert_eq!(aligned.model.as_deref(), Some("gemini-2.5-pro"));

    // 2. LaneTurnKind::AgentHandoff with legacy `"agentId": "codex"` routes to the lane's
    // active ready runtime (`native`) even when `codex` is unavailable.
    let routing = RoutingPromptRunner::new(Arc::clone(&fixture.registry));
    let mut handoff_payload = serde_json::Map::new();
    handoff_payload.insert("agentId".to_string(), json!(CODEX_AGENT_ID));
    handoff_payload.insert("text".to_string(), json!("review handoff wake"));
    let handoff_turn = LaneTurn {
        kind: LaneTurnKind::AgentHandoff,
        key: LaneTurnKey::AgentHandoff("42".to_string()),
        client_message_id: "handoff-42".to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "proj-1".to_string(),
        chat_session_id: "acopilot".to_string(),
        history_key: "user-1::proj-1::acopilot".to_string(),
        logical_history_key: "user-1::proj-1::acopilot".to_string(),
        lane_namespace: ads_state::WEB_ACOPILOT_NAMESPACE.to_string(),
        lane_generation: 1,
        workspace_root: "/tmp/ws".to_string(),
        payload: handoff_payload,
        history_display_text: None,
        created_at: 1_000,
    };
    let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
    let emitted_clone = Arc::clone(&emitted);
    let outcome = routing
        .run_lane_turn(
            handoff_turn.clone(),
            PromptRunContext::new(Arc::new(move |val| {
                emitted_clone.lock().expect("emitted").push(val);
            })),
        )
        .await
        .expect("handoff run");
    assert!(outcome.ok);
    assert_eq!(
        fixture.native_runner.calls(),
        vec!["review handoff wake".to_string()]
    );

    // 3. abort_lane_turn & ScheduleExecutor resolution (native, agy, and unready codex fallback).
    routing.abort_lane_turn(&handoff_turn);
    assert_eq!(
        fixture.native_runner.aborted(),
        vec!["handoff-42".to_string()]
    );
    assert!(
        fixture
            .registry
            .schedule_executor_for(Some(NATIVE_AGENT_ID))
            .is_some()
    );
    assert!(
        fixture
            .registry
            .schedule_executor_for(Some(AGY_DEFAULT_AGENT_ID))
            .is_some()
    );
    assert!(
        fixture
            .registry
            .schedule_executor_for(Some(CODEX_AGENT_ID))
            .is_some()
    );

    // 4. Multiplexed WebSocket receives unsequenced `agents` broadcast on BOTH lanes without activeAgentId.
    let cookie = login_cookie(&fixture.app).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = fixture.app.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let req = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws"))
        .header(header::HOST, addr.to_string())
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(
            header::SEC_WEBSOCKET_PROTOCOL,
            "ads-session.mux-1, ads-chat.main, ads-chat.acopilot",
        )
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, "http://localhost")
        .body(())
        .expect("mux ws req");
    let (mut mux_ws, _) = connect_async(req).await.expect("mux ws connect");
    // Drain initial bootstrap frames for both lanes (2 welcome + 2 agents + optional snapshots).
    let mut initial_agents = 0;
    while initial_agents < 2 {
        let frame = recv_json_frame(&mut mux_ws).await;
        if frame["type"] == "agents" {
            initial_agents += 1;
        }
    }
    // Trigger runtime refresh broadcast -> both multiplexed lanes must receive an unsequenced
    // `agents` frame omitting `activeAgentId`.
    fixture.registry.probe_all().await;
    let mut broadcast_lanes = HashSet::new();
    for _ in 0..10 {
        let frame = recv_json_frame(&mut mux_ws).await;
        if frame["type"] == "agents" && frame.get("activeAgentId").is_none() {
            if let Some(lane) = frame.get("lane").and_then(Value::as_str) {
                broadcast_lanes.insert(lane.to_string());
            }
            if broadcast_lanes.len() == 2 {
                break;
            }
        }
    }
    assert_eq!(
        broadcast_lanes.len(),
        2,
        "both multiplexed lanes must receive agents broadcast"
    );

    drop(mux_ws);
    server.abort();
    fixture.registry.shutdown_all().await;
}

#[tokio::test]
async fn agy_account_email_and_tier_are_exposed_and_cleared_on_logout() {
    let fixture = build_runtime_fixture();
    fixture.registry.probe_all().await;
    let cookie = login_cookie(&fixture.app).await;

    // 1. Create an isolated OAuth account and complete login -> writes antigravity-oauth-token.
    let (status, created) = authed_request(
        &fixture.app,
        "POST",
        "/api/runtimes/agy/accounts",
        &cookie,
        Some(json!({
            "label": "Work Pro",
            "authMethod": "oauth-personal"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let account_id = created["id"].as_str().expect("account id").to_string();
    let agent_id = created["agentId"].as_str().expect("agent id").to_string();
    assert!(created.get("accountEmail").is_none());
    assert!(created.get("tier").is_none());

    let (status, started) = authed_request(
        &fixture.app,
        "POST",
        &format!("/api/runtimes/agy/accounts/{account_id}/login/start"),
        &cookie,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");

    let (status, completed) = authed_request(
        &fixture.app,
        "POST",
        &format!("/api/runtimes/agy/accounts/{account_id}/login/complete"),
        &cookie,
        Some(json!({ "code": "ok-code" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(completed["ready"], json!(true));
    assert_eq!(completed["accountEmail"], json!("work.user@example.com"));
    assert_eq!(completed["tier"], json!("Pro"));
    assert!(
        !completed.to_string().contains("super-secret-oauth-token"),
        "OAuth token secret must never appear in account view"
    );

    // 2. Verify /api/runtimes and /api/runtimes/agy/accounts expose email & tier without secret.
    let (status, runtimes_body) =
        authed_request(&fixture.app, "GET", "/api/runtimes", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{runtimes_body}");
    assert!(!runtimes_body.to_string().contains("super-secret-oauth-token"));
    let work_agent = runtimes_body["agents"]
        .as_array()
        .expect("agents array")
        .iter()
        .find(|entry| entry["id"] == agent_id)
        .expect("work agent in /api/runtimes");
    assert_eq!(work_agent["accountEmail"], json!("work.user@example.com"));
    assert_eq!(work_agent["tier"], json!("Pro"));

    // 3. Create an API-key isolated account: must omit accountEmail while exposing tier.
    let (status, api_key_acc) = authed_request(
        &fixture.app,
        "POST",
        "/api/runtimes/agy/accounts",
        &cookie,
        Some(json!({
            "label": "Key Account",
            "authMethod": "gemini-api-key",
            "apiKey": "AIza-test-secret"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{api_key_acc}");
    assert_eq!(api_key_acc["ready"], json!(true));
    assert!(api_key_acc.get("accountEmail").is_none());
    assert_eq!(api_key_acc["tier"], json!("Pro"));

    // 4. Verify WebSocket `agents` frame carries accountEmail and tier without leaking token secret.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = fixture.app.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let req = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws?session=proj-email&chat_session_id=main"))
        .header(header::HOST, addr.to_string())
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(
            header::SEC_WEBSOCKET_PROTOCOL,
            "ads-session.proj-email, ads-chat.main",
        )
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, "http://localhost")
        .body(())
        .expect("ws req");
    let (mut ws, _) = connect_async(req).await.expect("ws connect");
    let agents_frame = recv_frame_of_type(&mut ws, "agents").await;
    assert!(!agents_frame.to_string().contains("super-secret-oauth-token"));
    let ws_work = agents_frame["agents"]
        .as_array()
        .expect("ws agents array")
        .iter()
        .find(|entry| entry["id"] == agent_id)
        .expect("work agent in ws agents");
    assert_eq!(ws_work["accountEmail"], json!("work.user@example.com"));
    assert_eq!(ws_work["tier"], json!("Pro"));

    // 5. Logout must delete antigravity-oauth-token and clear accountEmail & tier everywhere.
    let profile_dir = resolve_agy_profile_dir(&fixture.state_dir, &account_id);
    let token_path = profile_dir
        .join(ads_acp::AGY_APP_DATA_DIR_NAME)
        .join("antigravity-oauth-token");
    assert!(token_path.exists(), "expected token file before logout");

    let (status, logged_out) = authed_request(
        &fixture.app,
        "POST",
        &format!("/api/runtimes/agy/accounts/{account_id}/logout"),
        &cookie,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{logged_out}");
    assert_eq!(logged_out["ready"], json!(false));
    assert!(logged_out.get("accountEmail").is_none());
    assert!(logged_out.get("tier").is_none());
    assert!(
        !token_path.exists(),
        "antigravity-oauth-token must be removed on logout"
    );

    let (status, runtimes_after) =
        authed_request(&fixture.app, "GET", "/api/runtimes", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{runtimes_after}");
    let work_after = runtimes_after["agents"]
        .as_array()
        .expect("agents array after logout")
        .iter()
        .find(|entry| entry["id"] == agent_id)
        .expect("work agent after logout");
    assert_eq!(work_after["ready"], json!(false));
    assert!(work_after.get("accountEmail").is_none());
    assert!(work_after.get("tier").is_none());

    drop(ws);
    server.abort();
    fixture.registry.shutdown_all().await;
}

fn write_mock_codex_acp_script(dir: &Path) -> PathBuf {
    let script_path = dir.join("mock-codex-acp-http.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def has_auth():
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    if not codex_home:
        return False
    auth_path = os.path.join(codex_home, "auth.json")
    return os.path.isfile(auth_path) and os.path.getsize(auth_path) > 2

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentInfo": {"name": "codex-acp", "version": "0.10.2"},
                "agentCapabilities": {"loadSession": True},
                "authMethods": [{"id": "chatgpt", "name": "ChatGPT"}]
            }
        })
    elif method == "session/new":
        if not has_auth():
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "Authentication required: run codex login"}
            })
            continue
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": "codex-sess-1",
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "gpt-5.3-codex",
                        "options": [
                            {"value": "gpt-5.3-codex", "name": "GPT-5.3 Codex"},
                            {"value": "gpt-4.1", "name": "GPT-4.1 (Codex)"}
                        ]
                    },
                    {
                        "id": "reasoning_effort",
                        "name": "Reasoning Effort",
                        "category": "reasoning_effort",
                        "type": "select",
                        "currentValue": "high",
                        "options": [
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"}
                        ]
                    }
                ]
            }
        })
    elif method == "session/set_config_option":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"configOptions": []}})
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        params = msg.get("params") or {}
        session_id = params.get("sessionId", "codex-sess-1")
        blocks = params.get("prompt") or []
        text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": f"{text} [via-mock-codex-acp]"}
                }
            }
        })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
    elif req_id is not None:
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
"#;
    fs::write(&script_path, script).expect("write mock codex-acp script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }
    script_path
}

#[tokio::test]
async fn codex_acp_probing_three_way_runtime_switching_and_persistent_auth_reuse() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = StateDb::open(dir.path().join("state.db")).expect("state db");
    insert_user(
        &db,
        "user-1",
        "admin",
        &hash_password_scrypt("secret"),
        1_700_000_000,
    )
    .expect("user");
    let auth = Arc::new(AuthService::new(
        db.clone(),
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    ));
    let workspace = dir.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    let codex_home = dir.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("codex home");
    fs::write(
        codex_home.join("auth.json"),
        r#"{"auth_mode":"chatgpt","account_email":"codex.user@example.com","tokens":{"access_token":"codex-secret-tok"}}"#,
    )
    .expect("write persistent codex auth.json");
    let workspace_db =
        Arc::new(WorkspaceDb::open(dir.path().join("workspaces.db")).expect("workspaces db"));

    let mock_codex = write_mock_codex_acp_script(dir.path());
    let mock_agy = write_mock_agy_script(dir.path(), &state_dir.join("providers").join("agy"));
    let native_runner = Arc::new(RecordingNativeRunner::new());

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir.clone(), workspace.clone());
    reg_cfg.preferred_default_agent_id = NATIVE_AGENT_ID.to_string();
    reg_cfg.native_runner = Some(native_runner.clone());
    reg_cfg.native_scheduler = Some(native_runner.clone());
    reg_cfg.codex_acp_binary = mock_codex.to_string_lossy().to_string();
    reg_cfg.codex_home = Some(codex_home.clone());
    reg_cfg.codex_probe_timeout = Duration::from_secs(10);
    reg_cfg.agy_binary = mock_agy.to_string_lossy().to_string();
    reg_cfg.agy_probe_timeout = Duration::from_secs(10);

    let registry = RuntimeRegistry::new(reg_cfg.clone());
    registry.probe_all().await;

    let routing_runner = Arc::new(RoutingPromptRunner::new(Arc::clone(&registry)));
    let ws_hub = Arc::new(WebSocketHub::new(WebSocketConfig::default()));
    let mut origins = HashSet::new();
    origins.insert("http://localhost".to_string());
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![workspace.clone()],
        origins,
        workspace_db,
        workspace.clone(),
    )
    .with_workspace_state_dir(state_dir)
    .with_websocket_hub(ws_hub)
    .with_prompt_queue_runner(routing_runner)
    .with_runtime_registry(Arc::clone(&registry));
    let app = build_router(auth, config);
    let cookie = login_cookie(&app).await;

    // 1. Add a Native Settings -> Providers model (`gpt-4.1`) and enable it in conversation service.
    let (status, provider) = authed_request(
        &app,
        "POST",
        "/api/model-providers",
        &cookie,
        Some(json!({
            "name": "NativeOpenAI",
            "baseUrl": "https://api.example.com/v1",
            "wireApi": "responses",
            "isEnabled": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provider}");
    let provider_id = provider["id"].as_str().expect("provider id").to_string();
    let (status, native_model) = authed_request(
        &app,
        "POST",
        "/api/model-configs",
        &cookie,
        Some(json!({
            "id": "gpt-4.1",
            "modelId": "gpt-4.1",
            "displayName": "GPT-4.1 Native",
            "provider": "NativeOpenAI",
            "providerId": provider_id,
            "isEnabled": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{native_model}");
    let native_model_id = native_model["id"]
        .as_str()
        .expect("native model id")
        .to_string();
    let (status, service_res) = authed_request(
        &app,
        "PUT",
        "/api/model-services/conversation",
        &cookie,
        Some(json!({
            "modelIds": [native_model_id],
            "defaultModelId": native_model_id
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{service_res}");

    // 2. Verify /api/runtimes shows native, codex (via ACP), and agy all ready without leaking secrets.
    let (status, runtimes_body) = authed_request(&app, "GET", "/api/runtimes", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{runtimes_body}");
    assert!(!runtimes_body.to_string().contains("codex-secret-tok"));
    let codex_agent = runtimes_body["agents"]
        .as_array()
        .expect("agents")
        .iter()
        .find(|a| a["id"] == CODEX_AGENT_ID)
        .expect("codex agent");
    assert_eq!(codex_agent["ready"], json!(true));
    assert_eq!(codex_agent["version"], json!("0.10.2"));
    assert_eq!(codex_agent["authMethod"], json!("chatgpt"));
    assert_eq!(codex_agent["accountEmail"], json!("codex.user@example.com"));

    // 3. Verify /api/models scopes DB provider model to `native`, and tags Codex & Agy
    // discovered models to their respective runtimes (plus collision disambiguation).
    let (status, models_body) = authed_request(&app, "GET", "/api/models", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{models_body}");
    let models = models_body.as_array().expect("models array");
    let native_entry = models
        .iter()
        .find(|m| m["id"] == native_model_id)
        .expect("native gpt-4.1");
    assert_eq!(
        native_entry["configJson"]["allowedAgents"],
        json!([NATIVE_AGENT_ID])
    );
    let codex_primary = models
        .iter()
        .find(|m| m["id"] == "gpt-5.3-codex")
        .expect("codex gpt-5.3-codex");
    assert_eq!(codex_primary["provider"], json!("codex"));
    assert_eq!(
        codex_primary["configJson"]["allowedAgents"],
        json!([CODEX_AGENT_ID])
    );
    let mut collided_ids = HashSet::new();
    collided_ids.insert("gpt-4.1".to_string());
    let collided_codex = registry.discovered_codex_models(&collided_ids);
    let codex_collided = collided_codex
        .iter()
        .find(|m| m.model_id == "gpt-4.1")
        .expect("disambiguated codex:gpt-4.1");
    assert_eq!(codex_collided.id, "codex:gpt-4.1");
    let agy_entry = models
        .iter()
        .find(|m| m["id"] == "gemini-2.5-pro")
        .expect("agy gemini-2.5-pro");
    assert_eq!(agy_entry["provider"], json!("antigravity"));

    // 4. Three-way WebSocket switching on the same lane: native -> codex -> agy -> codex.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app_clone = app.clone();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app_clone).await;
    });

    let req = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/ws?session=proj-3way&chat_session_id=main"))
        .header(header::HOST, addr.to_string())
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(
            header::SEC_WEBSOCKET_PROTOCOL,
            "ads-session.proj-3way, ads-chat.main",
        )
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, "http://localhost")
        .body(())
        .expect("ws req");
    let (mut ws, _) = connect_async(req).await.expect("ws connect");
    let _ = recv_frame_of_type(&mut ws, "agents").await;

    // Step 4a: Turn on `native`.
    ws.send(Message::Text(
        json!({
            "type": "prompt",
            "client_message_id": "cm-3way-native",
            "payload": { "text": "turn one native", "model": "gpt-4.1" }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("native prompt");
    let mut saw_native = false;
    for _ in 0..30 {
        let frame = recv_json_frame(&mut ws).await;
        let id_ok = frame["client_message_id"] == "cm-3way-native"
            || frame["clientMessageId"] == "cm-3way-native";
        if frame["type"] == "result" && id_ok {
            assert_eq!(frame["activeAgentId"], NATIVE_AGENT_ID);
            saw_native = true;
            break;
        }
    }
    assert!(saw_native);

    // Step 4b: Switch to `codex` (ACP) and run turn.
    ws.send(Message::Text(
        json!({ "type": "set_agent", "payload": { "agentId": CODEX_AGENT_ID } })
            .to_string()
            .into(),
    ))
    .await
    .expect("switch to codex");
    let switched_codex = recv_frame_of_type(&mut ws, "agents").await;
    assert_eq!(switched_codex["activeAgentId"], CODEX_AGENT_ID);

    ws.send(Message::Text(
        json!({
            "type": "prompt",
            "client_message_id": "cm-3way-codex",
            "payload": { "text": "turn two codex", "model": "codex:gpt-4.1" }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("codex prompt");
    let mut saw_codex = false;
    for _ in 0..30 {
        let frame = recv_json_frame(&mut ws).await;
        if frame["type"] == "error" {
            panic!("unexpected codex error: {frame}");
        }
        let id_ok = frame["client_message_id"] == "cm-3way-codex"
            || frame["clientMessageId"] == "cm-3way-codex";
        if frame["type"] == "result" && id_ok {
            assert_eq!(frame["activeAgentId"], CODEX_AGENT_ID);
            assert!(
                frame["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("[via-mock-codex-acp]")
            );
            saw_codex = true;
            break;
        }
    }
    assert!(saw_codex);

    // Step 4c: Switch to `agy` (ACP) and run turn.
    ws.send(Message::Text(
        json!({ "type": "set_agent", "payload": { "agentId": AGY_DEFAULT_AGENT_ID } })
            .to_string()
            .into(),
    ))
    .await
    .expect("switch to agy");
    let switched_agy = recv_frame_of_type(&mut ws, "agents").await;
    assert_eq!(switched_agy["activeAgentId"], AGY_DEFAULT_AGENT_ID);

    ws.send(Message::Text(
        json!({
            "type": "prompt",
            "client_message_id": "cm-3way-agy",
            "payload": { "text": "turn three agy", "model": "gemini-2.5-pro" }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("agy prompt");
    let mut saw_agy = false;
    for _ in 0..30 {
        let frame = recv_json_frame(&mut ws).await;
        if frame["type"] == "error" {
            panic!("unexpected agy error: {frame}");
        }
        let id_ok = frame["client_message_id"] == "cm-3way-agy"
            || frame["clientMessageId"] == "cm-3way-agy";
        if frame["type"] == "result" && id_ok {
            assert_eq!(frame["activeAgentId"], AGY_DEFAULT_AGENT_ID);
            assert!(
                frame["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("[via-mock-agy]")
            );
            saw_agy = true;
            break;
        }
    }
    assert!(saw_agy);

    // Step 4d: Verify ADR 0028 shared HistoryStore recorded both ACP runtimes' turns on the same lane.
    let conn = db.connect().expect("db conn");
    let history = HistoryStore::new(WEB_ACTIONS_NAMESPACE, 200, 100_000);
    let entries = history
        .get(&conn, "user-1::proj-3way::main")
        .expect("history entries");
    assert!(
        entries
            .iter()
            .any(|e| e.role == "ai" && e.text.contains("[via-mock-codex-acp]"))
    );
    assert!(
        entries
            .iter()
            .any(|e| e.role == "ai" && e.text.contains("[via-mock-agy]"))
    );

    drop(ws);
    server.abort();
    registry.shutdown_all().await;

    // 5. Simulate daemon restart: a fresh RuntimeRegistry reusing the same CODEX_HOME
    // becomes ready immediately with zero re-login.
    let restarted_registry = RuntimeRegistry::new(reg_cfg);
    restarted_registry.probe_all().await;
    assert!(
        restarted_registry.is_codex_ready(),
        "Codex ACP must reuse persisted CODEX_HOME auth across restarts without re-login"
    );
    restarted_registry.shutdown_all().await;
}
