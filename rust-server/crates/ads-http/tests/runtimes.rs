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
        params = msg.get("params") or {{}}
        cid = params.get("configId")
        val = params.get("value")
        if cid == "model" and val not in ("gemini-2.5-pro", "gemini-2.5-flash"):
            send({{
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {{"code": -32602, "message": f"Invalid params: unknown model {{val}}"}}
            }})
            continue
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{"configOptions": []}}}})
    elif method == "session/set_mode":
        send({{"jsonrpc": "2.0", "id": req_id, "result": {{}}}})
    elif method == "session/prompt":
        params = msg.get("params") or {{}}
        session_id = params.get("sessionId", "agy-sess-1")
        blocks = params.get("prompt") or []
        text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        reply = (
            json.dumps({{"status": "PASS", "summary": "Mock Agy reviewer pass", "defects": []}})
            if "Review runtime protocol:" in text
            else f"{{text}} [via-mock-agy]"
        )
        send({{
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {{
                "sessionId": session_id,
                "update": {{
                    "sessionUpdate": "agent_message_chunk",
                    "content": {{"type": "text", "text": reply}}
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
        params = msg.get("params") or {}
        cid = params.get("configId")
        val = params.get("value")
        if cid == "model" and val not in ("gpt-5.3-codex", "gpt-4.1"):
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"Invalid params: unknown model {val}"}
            })
            continue
        if cid == "reasoning_effort" and val not in ("medium", "high"):
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": f"Invalid params: unsupported effort {val}"}
            })
            continue
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": val if cid == "model" else "gpt-5.3-codex",
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
                        "currentValue": val if cid == "reasoning_effort" else "high",
                        "options": [
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"}
                        ]
                    }
                ]
            }
        })
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        params = msg.get("params") or {}
        session_id = params.get("sessionId", "codex-sess-1")
        blocks = params.get("prompt") or []
        text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        reply = (
            json.dumps({"status": "PASS", "summary": "Mock Codex reviewer pass", "defects": []})
            if "Review runtime protocol:" in text
            else f"{text} [via-mock-codex-acp]"
        )
        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": reply}
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

struct ReviewerRoutingFixture {
    app: Router,
    db: StateDb,
    registry: Arc<RuntimeRegistry>,
    cookie: String,
    workspace: PathBuf,
    _dir: TempDir,
}

async fn setup_reviewer_routing_fixture() -> ReviewerRoutingFixture {
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
            session_pepper: "reviewer-routing-pepper".to_string(),
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
        r#"{"auth_mode":"chatgpt","account_email":"reviewer@example.com","tokens":{"access_token":"codex-secret-tok"}}"#,
    )
    .expect("write codex auth.json");
    let workspace_db =
        Arc::new(WorkspaceDb::open(dir.path().join("workspaces.db")).expect("workspaces db"));

    let mock_codex = write_mock_codex_acp_script(dir.path());
    let mock_agy = write_mock_agy_script(dir.path(), &state_dir.join("providers").join("agy"));
    let native_runner = Arc::new(RecordingNativeRunner::new());

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir.clone(), workspace.clone());
    reg_cfg.preferred_default_agent_id = NATIVE_AGENT_ID.to_string();
    reg_cfg.native_runner = Some(native_runner.clone());
    reg_cfg.native_scheduler = Some(native_runner);
    reg_cfg.codex_acp_binary = mock_codex.to_string_lossy().to_string();
    reg_cfg.codex_home = Some(codex_home);
    reg_cfg.codex_probe_timeout = Duration::from_secs(10);
    reg_cfg.agy_binary = mock_agy.to_string_lossy().to_string();
    reg_cfg.agy_probe_timeout = Duration::from_secs(10);

    let registry = RuntimeRegistry::new(reg_cfg);
    registry.probe_all().await;

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
    .with_prompt_queue_runner(Arc::new(RoutingPromptRunner::new(Arc::clone(&registry))))
    .with_runtime_registry(Arc::clone(&registry));
    let app = build_router(auth, config);
    let cookie = login_cookie(&app).await;

    ReviewerRoutingFixture {
        app,
        db,
        registry,
        cookie,
        workspace,
        _dir: dir,
    }
}

fn init_git_repo_for_review(workspace: &Path) -> String {
    let run_git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(workspace)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    run_git(&["init"]);
    run_git(&["config", "user.name", "ADS Test"]);
    run_git(&["config", "user.email", "test@example.com"]);
    fs::write(workspace.join("README.md"), "hello review\n").expect("write readme");
    run_git(&["add", "README.md"]);
    run_git(&["commit", "-m", "initial commit"]);
    run_git(&["rev-parse", "HEAD"])
}

fn make_reviewer_request(workspace: &Path, head_commit: &str, job_id: &str) -> ads_actions::ReviewerRequest {
    ads_actions::ReviewerRequest {
        payload: ads_reviewer::ReviewPayload {
            issue: ads_reviewer::ReviewIssue {
                id: Some(746),
                title: "Verify dynamic reviewer runtime routing".to_string(),
                ..Default::default()
            },
            diff_range: Some(ads_reviewer::ReviewDiffRange {
                base_ref: "dev".to_string(),
                head_ref: "HEAD".to_string(),
                base_commit: Some(head_commit.to_string()),
                head_commit: Some(head_commit.to_string()),
                range: format!("{head_commit}^..{head_commit}"),
            }),
            diff: "diff --git a/README.md b/README.md\n+hello review\n".to_string(),
            ..Default::default()
        },
        repo_path: workspace.to_path_buf(),
        profile_id: None,
        job_id: job_id.to_string(),
        owner: "user-1".to_string(),
        cancellation: ads_native::Cancellation::new(),
        verification_report: Arc::new(std::sync::Mutex::new(
            ads_reviewer::ReviewVerificationReport::default(),
        )),
    }
}

#[tokio::test]
async fn role_profile_update_accepts_discovered_acp_models_and_rejects_unknown() {
    let fixture = setup_reviewer_routing_fixture().await;

    for (requested, expected_saved) in [
        ("gpt-5.3-codex", "gpt-5.3-codex"),
        ("codex:gpt-4.1", "gpt-4.1"),
        ("gemini-2.5-pro", "gemini-2.5-pro"),
    ] {
        let (status, updated) = authed_request(
            &fixture.app,
            "PUT",
            "/api/role-profiles/profile-default-reviewer",
            &fixture.cookie,
            Some(json!({ "model_id": requested })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "requested={requested}: {updated}");
        assert_eq!(updated["model_id"], expected_saved);
    }

    // When a DB model shares 'gemini-2.5-pro', GET /api/models disambiguates Agy as
    // 'agy:gemini-2.5-pro', and PUT /api/role-profiles accepts that prefixed ID.
    let (status, created_db) = authed_request(
        &fixture.app,
        "POST",
        "/api/model-configs",
        &fixture.cookie,
        Some(json!({ "modelId": "gemini-2.5-pro", "provider": "openai" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created_db}");
    let created_db_id = created_db["id"].as_str().expect("id").to_string();

    let (status, svc_before) = authed_request(
        &fixture.app,
        "GET",
        "/api/model-services",
        &fixture.cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut conv_ids: Vec<String> = svc_before
        .as_array()
        .expect("services")
        .iter()
        .find(|item| item["service"] == "conversation")
        .expect("conversation")["modelIds"]
        .as_array()
        .expect("modelIds")
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    conv_ids.push(created_db_id.clone());
    let (status, _) = authed_request(
        &fixture.app,
        "PUT",
        "/api/model-services/conversation",
        &fixture.cookie,
        Some(json!({ "modelIds": conv_ids, "defaultModelId": created_db_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, prefixed_res) = authed_request(
        &fixture.app,
        "PUT",
        "/api/role-profiles/profile-default-reviewer",
        &fixture.cookie,
        Some(json!({ "model_id": "agy:gemini-2.5-pro" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prefixed_res}");
    assert_eq!(prefixed_res["model_id"], "agy:gemini-2.5-pro");

    let (status, err_body) = authed_request(
        &fixture.app,
        "PUT",
        "/api/role-profiles/profile-default-reviewer",
        &fixture.cookie,
        Some(json!({ "model_id": "does-not-exist-anywhere" })),
    )
    .await;
    assert!(
        !status.is_success(),
        "unknown model should be rejected, got {status}: {err_body}"
    );
}

#[tokio::test]
async fn reviewer_runner_routes_dynamically_across_native_cpa_codex_and_agy() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use axum::routing::post;
    use tokio::net::TcpListener;

    let fixture = setup_reviewer_routing_fixture().await;
    let head_commit = init_git_repo_for_review(&fixture.workspace);

    // Local mock CPA OpenAI-compatible upstream proving Native execution for provider models.
    let native_hits = Arc::new(AtomicUsize::new(0));
    let hits_for_chat = Arc::clone(&native_hits);
    let hits_for_resp = Arc::clone(&native_hits);
    let verdict_json = r#"{"status":"REJECT","summary":"Native CPA reviewer reject","defects":[{"file":"README.md","line":1,"severity":"blocker","description":"native path verified"}]}"#;
    let sse_body = format!(
        "data: {{\"type\":\"response.content_part.added\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"part\":{{\"type\":\"output_text\",\"text\":\"\",\"annotations\":[]}}}}\n\n\
         data: {{\"type\":\"response.output_text.delta\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"delta\":{delta}}}\n\n\
         data: {{\"type\":\"response.content_part.done\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"part\":{{\"type\":\"output_text\",\"text\":{delta},\"annotations\":[]}}}}\n\n\
         data: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{{\"type\":\"message\",\"id\":\"msg-1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{{\"type\":\"output_text\",\"text\":{delta},\"annotations\":[]}}]}}}}\n\n\
         data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp-1\",\"status\":\"completed\",\"output\":[{{\"type\":\"message\",\"id\":\"msg-1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{{\"type\":\"output_text\",\"text\":{delta},\"annotations\":[]}}]}}],\"usage\":{{\"input_tokens\":5,\"output_tokens\":5,\"total_tokens\":10}}}}}}\n\n",
        delta = serde_json::to_string(verdict_json).expect("json string")
    );
    let sse_arc = Arc::new(sse_body);
    let upstream_router = Router::new()
        .route(
            "/v1/responses",
            post(move || {
                let hits = Arc::clone(&hits_for_resp);
                let body = Arc::clone(&sse_arc);
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                        body.as_str().to_string(),
                    )
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move || {
                let hits = Arc::clone(&hits_for_chat);
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    axum::Json(json!({
                        "choices": [{
                            "message": { "role": "assistant", "content": verdict_json },
                            "finish_reason": "stop"
                        }],
                        "usage": { "prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10 }
                    }))
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock cpa");
    let cpa_addr = listener.local_addr().expect("cpa addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, upstream_router).await;
    });

    // Provision CPA provider + gpt-5.6-luna model via API.
    let (status, cpa_provider) = authed_request(
        &fixture.app,
        "POST",
        "/api/model-providers",
        &fixture.cookie,
        Some(json!({
            "name": "CPA",
            "baseUrl": format!("http://{cpa_addr}/v1"),
            "apiKey": "cpa-secret-key",
            "wireApi": "responses"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cpa_provider}");
    let provider_id = cpa_provider["id"].as_str().expect("provider id");

    let (status, cpa_model) = authed_request(
        &fixture.app,
        "POST",
        "/api/model-configs",
        &fixture.cookie,
        Some(json!({
            "modelId": "gpt-5.6-luna",
            "displayName": "GPT-5.6 Luna",
            "provider": "cpa",
            "providerId": provider_id
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cpa_model}");
    let cpa_model_id = cpa_model["id"].as_str().expect("cpa model id").to_string();

    let (status, _) = authed_request(
        &fixture.app,
        "PUT",
        "/api/model-services/conversation",
        &fixture.cookie,
        Some(json!({ "modelIds": [cpa_model_id], "defaultModelId": cpa_model_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let runner = fixture.registry.reviewer_runner();

    // 1. Provider-backed CPA model must route to Native (never Codex/Agy ACP).
    let (status, _) = authed_request(
        &fixture.app,
        "PUT",
        "/api/role-profiles/profile-default-reviewer",
        &fixture.cookie,
        Some(json!({ "model_id": cpa_model_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        fixture.registry.resolve_reviewer_acp_agent(&cpa_model_id),
        Ok(None)
    );
    let cpa_verdict = runner(make_reviewer_request(
        &fixture.workspace,
        &head_commit,
        "job-route-cpa",
    ))
    .await
    .expect("CPA native reviewer must succeed");
    assert_eq!(
        cpa_verdict.status,
        ads_reviewer::ReviewVerdictStatus::Reject
    );
    assert!(cpa_verdict.summary.contains("Native CPA reviewer reject"));
    assert_eq!(native_hits.load(Ordering::SeqCst), 1);

    // 2. Discovered Codex model routes to CodexDriver and passes without affecting Native hits.
    let (status, _) = authed_request(
        &fixture.app,
        "PUT",
        "/api/role-profiles/profile-default-reviewer",
        &fixture.cookie,
        Some(json!({ "model_id": "gpt-5.3-codex" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        fixture.registry.resolve_reviewer_acp_agent("gpt-5.3-codex"),
        Ok(Some(CODEX_AGENT_ID.to_string()))
    );
    let codex_verdict = runner(make_reviewer_request(
        &fixture.workspace,
        &head_commit,
        "job-route-codex",
    ))
    .await
    .expect("Codex ACP reviewer must succeed");
    assert_eq!(
        codex_verdict.status,
        ads_reviewer::ReviewVerdictStatus::Pass
    );
    assert!(codex_verdict.summary.contains("Mock Codex reviewer pass"));
    assert_eq!(native_hits.load(Ordering::SeqCst), 1);

    // 3. Legacy seeded 'gpt-5.5' routes to CodexDriver and skips unknown model alignment safely.
    {
        let conn = fixture.db.connect().expect("conn");
        conn.execute(
            "UPDATE role_profiles SET model_id = 'gpt-5.5' WHERE id = 'profile-default-reviewer'",
            [],
        )
        .expect("set legacy gpt-5.5");
    }
    let legacy_verdict = runner(make_reviewer_request(
        &fixture.workspace,
        &head_commit,
        "job-route-legacy-codex",
    ))
    .await
    .expect("legacy seeded gpt-5.5 must not trigger -32602");
    assert_eq!(
        legacy_verdict.status,
        ads_reviewer::ReviewVerdictStatus::Pass
    );
    assert!(legacy_verdict.summary.contains("Mock Codex reviewer pass"));

    // 4. Discovered Agy model routes to AgyDriver and passes.
    let (status, _) = authed_request(
        &fixture.app,
        "PUT",
        "/api/role-profiles/profile-default-reviewer",
        &fixture.cookie,
        Some(json!({ "model_id": "agy:gemini-2.5-pro" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        fixture
            .registry
            .resolve_reviewer_acp_agent("agy:gemini-2.5-pro"),
        Ok(Some(AGY_DEFAULT_AGENT_ID.to_string()))
    );
    let agy_verdict = runner(make_reviewer_request(
        &fixture.workspace,
        &head_commit,
        "job-route-agy",
    ))
    .await
    .expect("Agy ACP reviewer must succeed");
    assert_eq!(
        agy_verdict.status,
        ads_reviewer::ReviewVerdictStatus::Pass
    );
    assert!(agy_verdict.summary.contains("Mock Agy reviewer pass"));
    assert_eq!(native_hits.load(Ordering::SeqCst), 1);
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

    // 1. Verify fresh-DB seeded models carrying legacy `allowedAgents: ["codex"]` are scoped
    // to `native` in GET /api/models so they never leak into Codex ACP.
    let (status, initial_models_body) =
        authed_request(&app, "GET", "/api/models", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{initial_models_body}");
    let mut saw_seeded_codex_model = false;
    for model in initial_models_body.as_array().expect("initial models array") {
        let provider = model["provider"].as_str().unwrap_or_default();
        if provider != "codex" && provider != "antigravity" {
            let allowed = model["configJson"]["allowedAgents"]
                .as_array()
                .expect("scoped allowedAgents on DB model");
            assert!(
                !allowed.iter().any(|v| v == CODEX_AGENT_ID),
                "DB-seeded/provider model {} must not leak into codex ACP: {model}",
                model["id"]
            );
            if model["id"]
                .as_str()
                .is_some_and(|id| id.contains("codex"))
            {
                saw_seeded_codex_model = true;
                assert!(
                    allowed.iter().any(|v| v == NATIVE_AGENT_ID),
                    "legacy codex-seeded DB model {} must fall back to native: {model}",
                    model["id"]
                );
                assert_eq!(model["configJson"]["runtime"], NATIVE_AGENT_ID);
            }
        }
    }
    assert!(
        saw_seeded_codex_model,
        "expected fresh DB to contain at least one legacy codex-seeded model to verify scoping"
    );

    // 1b. Add a Native Settings -> Providers model (`gpt-4.1`) even with legacy
    // `allowedAgents: ["codex"]` and verify it is still scoped exclusively to `native`.
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
            "configJson": { "allowedAgents": ["codex"] },
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
    let restarted_registry = RuntimeRegistry::new(reg_cfg.clone());
    restarted_registry.probe_all().await;
    assert!(
        restarted_registry.is_codex_ready(),
        "Codex ACP must reuse persisted CODEX_HOME auth across restarts without re-login"
    );
    restarted_registry.shutdown_all().await;

    // 6. Verify unauthenticated CODEX_HOME reports ready=false with actionable auth error.
    let unauth_codex_home = dir.path().join("codex-home-unauth");
    fs::create_dir_all(&unauth_codex_home).expect("unauth codex home");
    let mut unauth_cfg = reg_cfg;
    unauth_cfg.codex_home = Some(unauth_codex_home);
    let unauth_registry = RuntimeRegistry::new(unauth_cfg);
    unauth_registry.probe_all().await;
    assert!(!unauth_registry.is_codex_ready());
    let unauth_codex = unauth_registry
        .list_agents()
        .into_iter()
        .find(|a| a.id == CODEX_AGENT_ID)
        .expect("unauth codex agent");
    assert!(!unauth_codex.ready);
    assert!(
        unauth_codex
            .error
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("auth")
    );
    unauth_registry.shutdown_all().await;
}

#[tokio::test]
async fn agy_account_creation_allows_omitted_label_and_falls_back_to_email() {
    let fixture = build_runtime_fixture();
    fixture.registry.probe_all().await;
    let cookie = login_cookie(&fixture.app).await;

    let (status, created) = authed_request(
        &fixture.app,
        "POST",
        "/api/runtimes/agy/accounts",
        &cookie,
        Some(json!({
            "authMethod": "oauth-personal"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let account_id = created["id"].as_str().expect("account id").to_string();
    assert!(account_id.starts_with("acct-"));
    assert_eq!(created["label"], json!("Google OAuth (Personal)"));
    assert_eq!(created["ready"], json!(false));

    let (status, _) = authed_request(
        &fixture.app,
        "POST",
        &format!("/api/runtimes/agy/accounts/{account_id}/login/start"),
        &cookie,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

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
    assert_eq!(completed["label"], json!("work.user@example.com"));

    // /api/runtimes descriptor `name` for the label-less isolated account also resolves to email.
    let (status, runtimes_body) =
        authed_request(&fixture.app, "GET", "/api/runtimes", &cookie, None).await;
    assert_eq!(status, StatusCode::OK, "{runtimes_body}");
    let agent_id = completed["agentId"].as_str().expect("agentId");
    let runtime_entry = runtimes_body["agents"]
        .as_array()
        .expect("agents array")
        .iter()
        .find(|entry| entry["id"] == agent_id)
        .expect("label-less agent in /api/runtimes");
    assert_eq!(runtime_entry["name"], json!("work.user@example.com"));

    // Logging out reverts the resolved label from email back to the auth method display label.
    let (status, logged_out) = authed_request(
        &fixture.app,
        "POST",
        &format!("/api/runtimes/agy/accounts/{account_id}/logout"),
        &cookie,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{logged_out}");
    assert_eq!(logged_out["label"], json!("Google OAuth (Personal)"));

    // Whitespace-only label is treated as omitted, and oauth-business seeds ID/label from gcpProject.
    let (status, gcp_created) = authed_request(
        &fixture.app,
        "POST",
        "/api/runtimes/agy/accounts",
        &cookie,
        Some(json!({
            "label": "   ",
            "authMethod": "oauth-business",
            "gcpProject": "Acme Prod",
            "gcpLocation": "us-central1"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gcp_created}");
    assert_eq!(gcp_created["id"], json!("acme-prod"));
    assert_eq!(gcp_created["label"], json!("Acme Prod"));

    let too_long_label = "x".repeat(81);
    let (status, err_body) = authed_request(
        &fixture.app,
        "POST",
        "/api/runtimes/agy/accounts",
        &cookie,
        Some(json!({
            "label": too_long_label,
            "authMethod": "oauth-personal"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err_body}");

    fixture.registry.shutdown_all().await;
}

#[tokio::test]
async fn runtime_registry_config_defaults_to_native_without_env_override() {
    let dir = TempDir::new().expect("tempdir");
    let db = StateDb::open(dir.path().join("state.db")).expect("state db");
    let workspace = dir.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    let codex_home = dir.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("codex home");
    fs::write(
        codex_home.join("auth.json"),
        r#"{"auth_mode":"chatgpt","account_email":"codex.user@example.com","tokens":{"access_token":"tok"}}"#,
    )
    .expect("auth.json");

    let mock_codex = write_mock_codex_acp_script(dir.path());
    let mock_agy = write_mock_agy_script(dir.path(), &state_dir.join("providers").join("agy"));
    let native_runner = Arc::new(RecordingNativeRunner::new());

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir, workspace);
    assert_eq!(reg_cfg.preferred_default_agent_id, NATIVE_AGENT_ID);
    reg_cfg.native_runner = Some(native_runner);
    reg_cfg.codex_acp_binary = mock_codex.to_string_lossy().to_string();
    reg_cfg.codex_home = Some(codex_home);
    reg_cfg.codex_probe_timeout = Duration::from_secs(10);
    reg_cfg.agy_binary = mock_agy.to_string_lossy().to_string();
    reg_cfg.agy_probe_timeout = Duration::from_secs(10);

    let registry = RuntimeRegistry::new(reg_cfg);
    registry.probe_all().await;

    assert_eq!(registry.default_active_agent_id(), NATIVE_AGENT_ID);
    assert_eq!(
        registry.resolve_active_agent_for_lane("user-1::proj-new::acopilot"),
        NATIVE_AGENT_ID
    );

    registry
        .save_lane_agent("user-1::proj-new::acopilot", CODEX_AGENT_ID)
        .expect("save client lane agent");
    assert_eq!(
        registry.resolve_active_agent_for_lane("user-1::proj-new::acopilot"),
        CODEX_AGENT_ID
    );

    registry.shutdown_all().await;
}

#[tokio::test]
async fn runtime_registry_wires_review_action_handoff_to_codex_and_agy_acp_runners() {
    use std::process::Command as StdCommand;
    use ads_actions::{ReviewQueue, ReviewQueueOptions, canonical_project_id, review_action_tools_factory};
    use ads_state::{
        UpsertWebProject, WEB_ACOPILOT_NAMESPACE, ensure_web_project_tables, list_action_jobs,
        upsert_web_project,
    };

    let dir = TempDir::new().expect("tempdir");
    let repo = dir.path().join("repo");
    fs::create_dir_all(&repo).expect("repo");
    for args in [
        &["init", "-q"][..],
        &["config", "user.email", "acopilot@example.com"],
        &["config", "user.name", "Acopilot"],
    ] {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .expect("git init");
        assert!(out.status.success());
    }
    fs::write(repo.join("README.md"), "# 758\n").expect("readme");
    for args in [
        &["add", "."][..],
        &["commit", "-q", "-m", "initial"],
        &["branch", "-m", "feat/758-acp-review-action-handoff"],
    ] {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(&repo)
            .output()
            .expect("git commit");
        assert!(out.status.success());
    }

    let state_dir = dir.path().join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    let db = StateDb::open(state_dir.join("state.db")).expect("state db");
    let project_id = canonical_project_id("proj-758", Some(&repo));
    {
        let conn = db.connect().expect("conn");
        conn.execute(
            "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
             VALUES ('user-1', 'admin', 'hash', 1, 1)",
            [],
        )
        .expect("user");
        ensure_web_project_tables(&conn).expect("web project tables");
        upsert_web_project(
            &conn,
            UpsertWebProject {
                user_id: "user-1",
                project_id: &project_id,
                workspace_root: &repo.to_string_lossy(),
                name: "ADS 758",
                chat_session_id: Some("main"),
            },
            1_000,
        )
        .expect("upsert project");
    }

    let codex_home = dir.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("codex home");
    fs::write(
        codex_home.join("auth.json"),
        r#"{"auth_mode":"chatgpt","account_email":"codex@example.com","tokens":{"access_token":"tok"}}"#,
    )
    .expect("codex auth");

    // Mock ACP binary serving both `codex-acp` and `agy acp --stdio`
    let mock_acp = dir.path().join("mock-acp-758.py");
    let script = r#"#!/usr/bin/env python3
import json, sys

if "--version" in sys.argv:
    print("mock-acp 1.0.0")
    sys.exit(0)

session_num = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False, "sessionCapabilities": {}},
                "agentInfo": {"name": "mock-acp-758", "version": "1.0.0"},
                "authMethods": [],
            },
        }
    elif method == "session/new":
        session_num += 1
        resp = {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": f"s-{session_num}",
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}, {"id": "acceptEdits", "name": "Accept Edits"}, {"id": "plan", "name": "Plan"}]},
                "configOptions": [{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "mock-model", "options": [{"value": "mock-model", "name": "Mock Model"}]}],
            },
        }
    elif method in ("session/set_mode", "session/set_config_option"):
        resp = {"jsonrpc": "2.0", "id": req_id, "result": {}}
    elif method == "session/prompt":
        sid = params.get("sessionId", "s-1")
        reply = "Enqueuing PR review now.\n\n```ads-review-action\n{}\n```"
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": sid,
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}},
            },
        }) + "\n")
        resp = {"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}}
    else:
        continue
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"#;
    fs::write(&mock_acp, script).expect("write mock acp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&mock_acp).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&mock_acp, perms).expect("chmod");
    }

    let review_queue = Arc::new(ReviewQueue::new(
        db.clone(),
        "worker-758",
        ReviewQueueOptions::default(),
    ));
    let factory = review_action_tools_factory(Arc::clone(&review_queue));

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir, repo.clone());
    reg_cfg.action_tools_factory = Some(factory);
    reg_cfg.codex_acp_binary = mock_acp.to_string_lossy().to_string();
    reg_cfg.codex_home = Some(codex_home);
    reg_cfg.codex_probe_timeout = Duration::from_secs(10);
    reg_cfg.agy_binary = mock_acp.to_string_lossy().to_string();
    reg_cfg.agy_probe_timeout = Duration::from_secs(10);

    let registry = RuntimeRegistry::new(reg_cfg);
    registry.probe_all().await;
    let routing = RoutingPromptRunner::new(Arc::clone(&registry));

    // 1. Acopilot on `codex` ACP dispatches a real ReviewQueue job in StateDb.
    let mut codex_payload = serde_json::Map::new();
    codex_payload.insert("agentId".to_string(), json!(CODEX_AGENT_ID));
    codex_payload.insert("text".to_string(), json!("Dispatch PR review"));
    let codex_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let codex_events_h = Arc::clone(&codex_events);
    let outcome = routing
        .run_lane_turn(
            LaneTurn {
                kind: LaneTurnKind::UserPrompt,
                key: LaneTurnKey::PromptQueue(101),
                client_message_id: "cm-codex-758".to_string(),
                auth_user_id: "user-1".to_string(),
                user_id: 1,
                session_id: project_id.clone(),
                chat_session_id: "acopilot".to_string(),
                history_key: format!("user-1::{project_id}::acopilot"),
                logical_history_key: format!("user-1::{project_id}::acopilot"),
                lane_namespace: WEB_ACOPILOT_NAMESPACE.to_string(),
                lane_generation: 1,
                workspace_root: repo.to_string_lossy().to_string(),
                payload: codex_payload,
                history_display_text: None,
                created_at: 2_000,
            },
            PromptRunContext::new(Arc::new(move |ev| {
                codex_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("codex turn");
    assert!(outcome.ok);
    assert!(
        codex_events
            .lock()
            .expect("evs")
            .iter()
            .any(|ev| ev["type"] == "review_action_handoff" && ev["ok"] == json!(true))
    );

    let jobs = {
        let conn = db.connect().expect("conn");
        list_action_jobs(&conn, &project_id, None, Some("user-1")).expect("list jobs")
    };
    assert_eq!(jobs.len(), 1, "codex ACP handoff must enqueue 1 ReviewQueue job");
    assert_eq!(jobs[0].issue_id, Some(758));
    assert_eq!(
        jobs[0].branch.as_deref(),
        Some("feat/758-acp-review-action-handoff")
    );

    // 2. Human-initiated Actions lane UserPrompt on `agy` ACP can also invoke review_action.
    let mut agy_actions_payload = serde_json::Map::new();
    agy_actions_payload.insert("agentId".to_string(), json!(AGY_DEFAULT_AGENT_ID));
    agy_actions_payload.insert("text".to_string(), json!("Trigger review from Actions lane"));
    let agy_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let agy_events_h = Arc::clone(&agy_events);
    let agy_outcome = routing
        .run_lane_turn(
            LaneTurn {
                kind: LaneTurnKind::UserPrompt,
                key: LaneTurnKey::PromptQueue(102),
                client_message_id: "cm-agy-actions-758".to_string(),
                auth_user_id: "user-1".to_string(),
                user_id: 1,
                session_id: project_id.clone(),
                chat_session_id: "main".to_string(),
                history_key: format!("user-1::{project_id}::main"),
                logical_history_key: format!("user-1::{project_id}::main"),
                lane_namespace: WEB_ACTIONS_NAMESPACE.to_string(),
                lane_generation: 1,
                workspace_root: repo.to_string_lossy().to_string(),
                payload: agy_actions_payload,
                history_display_text: None,
                created_at: 3_000,
            },
            PromptRunContext::new(Arc::new(move |ev| {
                agy_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("agy actions user turn");
    assert!(agy_outcome.ok);
    assert!(
        agy_events
            .lock()
            .expect("evs")
            .iter()
            .any(|ev| ev["type"] == "review_action_handoff" && ev["ok"] == json!(true)),
        "agy ACP user-initiated Actions lane turn must succeed"
    );

    // 3. Non-user-initiated Actions lane AgentHandoff on `agy` ACP must NOT execute review_action.
    registry
        .save_lane_agent(&format!("user-1::{project_id}::main"), AGY_DEFAULT_AGENT_ID)
        .expect("save agy lane pref");
    let mut forbidden_payload = serde_json::Map::new();
    forbidden_payload.insert("text".to_string(), json!("Automated actions handoff"));
    let forbidden_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let forbidden_events_h = Arc::clone(&forbidden_events);
    let forbidden_outcome = routing
        .run_lane_turn(
            LaneTurn {
                kind: LaneTurnKind::AgentHandoff,
                key: LaneTurnKey::AgentHandoff("758-auto".to_string()),
                client_message_id: "cm-agy-actions-auto-758".to_string(),
                auth_user_id: "user-1".to_string(),
                user_id: 1,
                session_id: project_id.clone(),
                chat_session_id: "main".to_string(),
                history_key: format!("user-1::{project_id}::main"),
                logical_history_key: format!("user-1::{project_id}::main"),
                lane_namespace: WEB_ACTIONS_NAMESPACE.to_string(),
                lane_generation: 1,
                workspace_root: repo.to_string_lossy().to_string(),
                payload: forbidden_payload,
                history_display_text: None,
                created_at: 4_000,
            },
            PromptRunContext::new(Arc::new(move |ev| {
                forbidden_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("agy actions handoff turn");
    assert!(forbidden_outcome.ok);
    assert!(
        !forbidden_events
            .lock()
            .expect("evs")
            .iter()
            .any(|ev| ev["type"] == "review_action_handoff"),
        "non-user-initiated Actions lane turn must not invoke review_action"
    );

    registry.shutdown_all().await;
}
