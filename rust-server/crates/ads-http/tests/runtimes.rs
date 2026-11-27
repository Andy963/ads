use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{
    AGY_DEFAULT_AGENT_ID, CODEX_AGENT_ID, CookieSecureMode, NATIVE_AGENT_ID, RouterConfig,
    RoutingPromptRunner, RuntimeRegistry, RuntimeRegistryConfig, WebSocketConfig, WebSocketHub,
    build_router,
};
use ads_runtime::{
    LaneTurn, PromptQueueFuture, PromptQueueRunOutcome, PromptQueueRunner, PromptRunContext,
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
}

impl RecordingNativeRunner {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls lock").clone()
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

    fn abort_lane_turn(&self, _entry: &LaneTurn) {}
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
            os.makedirs(home, exist_ok=True)
            with open(os.path.join(home, "oauth_creds.json"), "w") as fh:
                json.dump({{"access_token": "tok"}}, fh)
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
    return os.path.exists(os.path.join(home, "oauth_creds.json"))

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
    let codex_runner = Arc::new(RecordingNativeRunner::new());

    let mut reg_cfg = RuntimeRegistryConfig::new(db.clone(), state_dir.clone(), workspace.clone());
    reg_cfg.preferred_default_agent_id = NATIVE_AGENT_ID.to_string();
    reg_cfg.native_runner = Some(native_runner.clone());
    reg_cfg.codex_runner = Some(codex_runner);
    reg_cfg.codex_binary = dir
        .path()
        .join("definitely-missing-codex-bin")
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
    let settings_json_path = fixture
        .state_dir
        .join("providers")
        .join("agy")
        .join(&api_account_id)
        .join("settings.json");
    if settings_json_path.exists() {
        let settings_text = fs::read_to_string(&settings_json_path).expect("settings.json");
        assert!(!settings_text.contains(secret_key));
    }

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

    // Logout removes credentials and marks account unready.
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

    // Deleting isolated account succeeds and removes profile directory.
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
        !fixture
            .state_dir
            .join("providers")
            .join("agy")
            .join(&oauth_id)
            .exists()
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
