use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, oneshot, watch};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSession {
    session_id: String,
    cwd: String,
    turn_count: u64,
    mode: String,
    model: String,
    thought_level: String,
    driver_tag: Option<String>,
    history: Vec<(String, String)>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedStore {
    next_session_num: u64,
    sessions: HashMap<String, PersistedSession>,
}

struct ServerState {
    state_dir: Option<PathBuf>,
    store: Mutex<PersistedStore>,
    writer: Mutex<tokio::io::Stdout>,
    next_server_req_id: AtomicU64,
    pending_client_responses: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cancel_senders: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl ServerState {
    fn new(state_dir: Option<PathBuf>) -> Self {
        let store = state_dir
            .as_deref()
            .and_then(load_store)
            .unwrap_or_default();
        Self {
            state_dir,
            store: Mutex::new(store),
            writer: Mutex::new(tokio::io::stdout()),
            next_server_req_id: AtomicU64::new(1),
            pending_client_responses: Mutex::new(HashMap::new()),
            cancel_senders: Mutex::new(HashMap::new()),
        }
    }

    async fn send_json(&self, value: &Value) {
        let mut line = serde_json::to_vec(value).expect("serialize JSON-RPC");
        line.push(b'\n');
        let mut writer = self.writer.lock().await;
        let _ = writer.write_all(&line).await;
        let _ = writer.flush().await;
    }

    async fn send_raw(&self, raw: &str) {
        let mut writer = self.writer.lock().await;
        let _ = writer.write_all(raw.as_bytes()).await;
        let _ = writer.write_all(b"\n").await;
        let _ = writer.flush().await;
    }

    async fn send_update(&self, session_id: &str, update: Value) {
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": update,
            }
        }))
        .await;
    }

    async fn send_server_request(&self, method: &str, params: Value) -> Option<Value> {
        let id_num = self.next_server_req_id.fetch_add(1, Ordering::AcqRel);
        let id_str = format!("srv-{id_num}");
        let (tx, rx) = oneshot::channel();
        self.pending_client_responses
            .lock()
            .await
            .insert(id_str.clone(), tx);
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "id": id_str,
            "method": method,
            "params": params,
        }))
        .await;
        rx.await.ok()
    }

    fn log_rpc(&self, method: &str, params: &Value) {
        let Some(dir) = self.state_dir.as_ref() else {
            return;
        };
        let _ = fs::create_dir_all(dir);
        let path = dir.join("rpc_log.jsonl");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let entry = json!({ "method": method, "params": params });
            let _ = writeln!(file, "{entry}");
        }
    }

    async fn flush_store(&self) {
        let Some(dir) = self.state_dir.as_ref() else {
            return;
        };
        let store = self.store.lock().await;
        let _ = fs::create_dir_all(dir);
        let mut merged = load_store(dir).unwrap_or_default();
        merged.next_session_num = merged.next_session_num.max(store.next_session_num);
        for (id, session) in &store.sessions {
            let should_update = merged
                .sessions
                .get(id)
                .is_none_or(|existing| session.turn_count >= existing.turn_count);
            if should_update {
                merged.sessions.insert(id.clone(), session.clone());
            }
        }
        let path = dir.join("sessions.json");
        if let Ok(bytes) = serde_json::to_vec_pretty(&merged) {
            let _ = fs::write(path, bytes);
        }
    }

    fn record_shutdown_marker(&self, marker: &str) {
        let Some(dir) = self.state_dir.as_ref() else {
            return;
        };
        let _ = fs::create_dir_all(dir);
        let path = dir.join("shutdown_marker.txt");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{marker}");
        }
    }
}

fn load_store(dir: &Path) -> Option<PersistedStore> {
    let bytes = fs::read(dir.join("sessions.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn build_config_options(session: &PersistedSession) -> Value {
    // Intentionally place `thought_level` BEFORE `model` in the array to ensure
    // clients key by `configId`/`category` rather than array index.
    let mut thought_options = vec![
        json!({ "value": "low", "name": "Low" }),
        json!({ "value": "medium", "name": "Medium" }),
        json!({ "value": "high", "name": "High" }),
    ];
    if session.model == "model-beta" {
        thought_options.push(json!({ "value": "xhigh", "name": "Extra High" }));
    }
    json!([
        {
            "id": "opt_thought",
            "name": "Thought Level",
            "category": "thought_level",
            "type": "select",
            "currentValue": session.thought_level,
            "options": thought_options,
        },
        {
            "id": "opt_model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": session.model,
            "options": [
                { "value": "model-alpha", "name": "Model Alpha" },
                { "value": "model-beta", "name": "Model Beta" }
            ],
        }
    ])
}

fn build_modes(current_mode: &str) -> Value {
    json!({
        "currentModeId": current_mode,
        "availableModes": [
            { "id": "default", "name": "Default" },
            { "id": "accept-edits", "name": "Accept Edits" },
            { "id": "plan", "name": "Plan" }
        ]
    })
}

#[tokio::main]
async fn main() {
    let state_dir = std::env::var("ADS_MOCK_STATE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let ignore_eof = std::env::var("ADS_MOCK_IGNORE_STDIN_EOF").as_deref() == Ok("1");
    let ignore_sigterm = std::env::var("ADS_MOCK_IGNORE_SIGTERM").as_deref() == Ok("1");

    #[cfg(unix)]
    if ignore_sigterm {
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
    }

    if let Some(dir) = state_dir.as_ref()
        && std::env::var("ADS_MOCK_SPAWN_GRANDCHILD").as_deref() == Ok("1")
    {
        let _ = fs::create_dir_all(dir);
        if let Ok(child) = std::process::Command::new("sleep").arg("60").spawn() {
            let _ = fs::write(dir.join("grandchild_pid.txt"), child.id().to_string());
        }
    }

    let state = Arc::new(ServerState::new(state_dir));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(object) = value.as_object() else {
            continue;
        };

        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            let id = object.get("id").cloned();
            state.log_rpc(method, &params);

            if method == "session/cancel" {
                if let Some(session_id) = params.get("sessionId").and_then(Value::as_str)
                    && let Some(sender) = state.cancel_senders.lock().await.get(session_id)
                {
                    let _ = sender.send(true);
                }
                continue;
            }

            let state_clone = Arc::clone(&state);
            let method = method.to_string();
            tokio::spawn(async move {
                handle_request(state_clone, id, method, params).await;
            });
        } else if let Some(id) = object.get("id") {
            let key = match id {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            if let Some(tx) = state.pending_client_responses.lock().await.remove(&key) {
                let _ = tx.send(value);
            }
        }
    }

    state.flush_store().await;
    state.record_shutdown_marker("graceful_eof");

    if ignore_eof {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    }
}

async fn handle_request(state: Arc<ServerState>, id: Option<Value>, method: String, params: Value) {
    let Some(id) = id else {
        return;
    };

    if std::env::var("ADS_MOCK_REQUIRE_AUTH").as_deref() == Ok("1") && method == "initialize" {
        state
            .send_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32000,
                    "message": "Authentication required: run login first",
                    "data": {
                        "authMethods": [{ "id": "oauth", "name": "OAuth Login" }]
                    }
                }
            }))
            .await;
        return;
    }

    match method.as_str() {
        "initialize" => {
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": true,
                            "promptCapabilities": {
                                "image": false,
                                "audio": false,
                                "embeddedContext": true
                            },
                            "mcpCapabilities": {
                                "http": false,
                                "sse": false
                            },
                            "sessionCapabilities": {
                                "resume": {}
                            }
                        },
                        "agentInfo": {
                            "name": "mock-acp-server",
                            "title": "Deterministic Mock ACP Server",
                            "version": "1.0.0"
                        },
                        "authMethods": []
                    }
                }))
                .await;
        }
        "session/new" => {
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or(".")
                .to_string();
            let driver_tag = params
                .get("driverTag")
                .and_then(Value::as_str)
                .map(str::to_string);
            let session = {
                let mut store = state.store.lock().await;
                store.next_session_num += 1;
                let session_id = format!("sess-{}", store.next_session_num);
                let session = PersistedSession {
                    session_id: session_id.clone(),
                    cwd,
                    turn_count: 0,
                    mode: "default".to_string(),
                    model: "model-alpha".to_string(),
                    thought_level: "medium".to_string(),
                    driver_tag,
                    history: Vec::new(),
                };
                store.sessions.insert(session_id, session.clone());
                session
            };
            state.flush_store().await;
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "sessionId": session.session_id,
                        "modes": build_modes(&session.mode),
                        "configOptions": build_config_options(&session),
                    }
                }))
                .await;
        }
        "session/resume" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let existing = state.store.lock().await.sessions.get(&session_id).cloned();
            let Some(session) = existing else {
                state
                    .send_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32004,
                            "message": format!("Session not found: {session_id}")
                        }
                    }))
                    .await;
                return;
            };
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "sessionId": session.session_id,
                        "modes": build_modes(&session.mode),
                        "configOptions": build_config_options(&session),
                    }
                }))
                .await;
        }
        "session/load" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let existing = state.store.lock().await.sessions.get(&session_id).cloned();
            let Some(session) = existing else {
                state
                    .send_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32004,
                            "message": format!("Session not found: {session_id}")
                        }
                    }))
                    .await;
                return;
            };
            for (user_text, assistant_text) in &session.history {
                state
                    .send_update(
                        &session.session_id,
                        json!({
                            "sessionUpdate": "user_message_chunk",
                            "content": { "type": "text", "text": user_text }
                        }),
                    )
                    .await;
                state
                    .send_update(
                        &session.session_id,
                        json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": { "type": "text", "text": assistant_text }
                        }),
                    )
                    .await;
            }
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "sessionId": session.session_id,
                        "modes": build_modes(&session.mode),
                        "configOptions": build_config_options(&session),
                    }
                }))
                .await;
        }
        "session/set_mode" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mode_id = params
                .get("modeId")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string();
            let updated = {
                let mut store = state.store.lock().await;
                if let Some(session) = store.sessions.get_mut(&session_id) {
                    session.mode = mode_id.clone();
                    Some(session.clone())
                } else {
                    None
                }
            };
            let Some(session) = updated else {
                state
                    .send_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32004, "message": "Session not found" }
                    }))
                    .await;
                return;
            };
            state.flush_store().await;
            state
                .send_update(
                    &session_id,
                    json!({
                        "sessionUpdate": "current_mode_update",
                        "currentModeId": mode_id,
                    }),
                )
                .await;
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "modes": build_modes(&session.mode),
                    }
                }))
                .await;
        }
        "session/set_config_option" => {
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let config_id = params
                .get("configId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();

            let result = {
                let mut store = state.store.lock().await;
                if let Some(session) = store.sessions.get_mut(&session_id) {
                    match (config_id.as_str(), value.as_str()) {
                        ("opt_model", "model-alpha" | "model-beta") => {
                            session.model = value.clone();
                            if session.model == "model-alpha" && session.thought_level == "xhigh" {
                                session.thought_level = "high".to_string();
                            }
                            Ok(session.clone())
                        }
                        ("opt_thought", "low" | "medium" | "high") => {
                            session.thought_level = value.clone();
                            Ok(session.clone())
                        }
                        ("opt_thought", "xhigh") => {
                            if session.model == "model-beta" {
                                session.thought_level = value.clone();
                                Ok(session.clone())
                            } else {
                                Err((
                                    -32602,
                                    "xhigh thought_level is only available on model-beta"
                                        .to_string(),
                                ))
                            }
                        }
                        _ => Err((
                            -32602,
                            format!("Unsupported config option {config_id}={value}"),
                        )),
                    }
                } else {
                    Err((-32004, "Session not found".to_string()))
                }
            };

            match result {
                Ok(session) => {
                    state.flush_store().await;
                    let options = build_config_options(&session);
                    state
                        .send_update(
                            &session_id,
                            json!({
                                "sessionUpdate": "config_option_update",
                                "configOptions": options,
                            }),
                        )
                        .await;
                    state
                        .send_json(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "configOptions": build_config_options(&session),
                            }
                        }))
                        .await;
                }
                Err((code, message)) => {
                    state
                        .send_json(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": code, "message": message }
                        }))
                        .await;
                }
            }
        }
        "session/prompt" => {
            handle_prompt(state, id, params).await;
        }
        _ => {
            state
                .send_json(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!("Method not found: {method}")
                    }
                }))
                .await;
        }
    }
}

async fn handle_prompt(state: Arc<ServerState>, id: Value, params: Value) {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let blocks = params
        .get("prompt")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut prompt_text = String::new();
    let mut resource_uris = Vec::new();
    for block in &blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !prompt_text.is_empty() {
                        prompt_text.push('\n');
                    }
                    prompt_text.push_str(text);
                }
            }
            Some("resource") => {
                if let Some(uri) = block
                    .get("resource")
                    .and_then(|res| res.get("uri"))
                    .and_then(Value::as_str)
                {
                    resource_uris.push(uri.to_string());
                }
            }
            _ => {}
        }
    }

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    state
        .cancel_senders
        .lock()
        .await
        .insert(session_id.clone(), cancel_tx);

    if prompt_text.contains("crash_mid_turn") {
        eprintln!("mock-acp-server: simulated fatal crash");
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "before-crash" }
                }),
            )
            .await;
        std::process::exit(42);
    }

    if prompt_text.contains("malformed_frame") {
        state.send_raw("not-valid-json{{{").await;
        return;
    }

    if prompt_text.contains("hang_timeout") {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        return;
    }

    if prompt_text.contains("cancel_with_trailing") {
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "part-1 " }
                }),
            )
            .await;
        while !*cancel_rx.borrow() {
            if cancel_rx.changed().await.is_err() {
                break;
            }
        }
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "trailing-1 " }
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "trailing-2" }
                }),
            )
            .await;
        state.cancel_senders.lock().await.remove(&session_id);
        state
            .send_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "stopReason": "cancelled" }
            }))
            .await;
        return;
    }

    if prompt_text.contains("need_permission_then_crash") {
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc-perm-crash",
                    "title": "Run dangerous shell command",
                    "kind": "execute",
                    "status": "pending"
                }),
            )
            .await;
        // Fire request_permission, wait briefly so client registers pending request, then crash.
        let req_state = Arc::clone(&state);
        let req_session = session_id.clone();
        tokio::spawn(async move {
            let _ = req_state
                .send_server_request(
                    "session/request_permission",
                    json!({
                        "sessionId": req_session,
                        "toolCall": {
                            "toolCallId": "tc-perm-crash",
                            "title": "Run dangerous shell command",
                            "kind": "execute",
                            "status": "pending"
                        },
                        "options": [
                            { "optionId": "opt-allow-once", "name": "Allow once", "kind": "allow_once" },
                            { "optionId": "opt-reject-once", "name": "Deny", "kind": "reject_once" }
                        ]
                    }),
                )
                .await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        eprintln!("mock-acp-server: crashed while awaiting permission");
        std::process::exit(99);
    }

    if prompt_text.contains("need_permission") {
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc-perm",
                    "title": "Write config.toml",
                    "kind": "edit",
                    "status": "pending"
                }),
            )
            .await;
        let response = state
            .send_server_request(
                "session/request_permission",
                json!({
                    "sessionId": session_id,
                    "toolCall": {
                        "toolCallId": "tc-perm",
                        "title": "Write config.toml",
                        "kind": "edit",
                        "status": "pending"
                    },
                    "options": [
                        { "optionId": "opt-allow-once", "name": "Allow once", "kind": "allow_once" },
                        { "optionId": "opt-allow-always", "name": "Always allow", "kind": "allow_always" },
                        { "optionId": "opt-reject-once", "name": "Deny", "kind": "reject_once" },
                        { "optionId": "opt-reject-always", "name": "Always deny", "kind": "reject_always" }
                    ]
                }),
            )
            .await;
        let outcome = response
            .as_ref()
            .and_then(|value| value.get("result"))
            .and_then(|result| result.get("outcome"));
        let outcome_kind = outcome
            .and_then(|value| value.get("outcome"))
            .and_then(Value::as_str)
            .unwrap_or("cancelled");
        let option_id = outcome
            .and_then(|value| value.get("optionId"))
            .and_then(Value::as_str);

        let (tool_status, reply, stop_reason) = match (outcome_kind, option_id) {
            ("selected", Some(opt)) if opt.contains("allow") => {
                ("completed", format!("ALLOWED:{opt}"), "end_turn")
            }
            ("selected", Some(opt)) => ("failed", format!("DENIED:{opt}"), "end_turn"),
            _ => ("cancelled", "PERM_CANCELLED".to_string(), "cancelled"),
        };
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-perm",
                    "status": tool_status,
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": reply }
                }),
            )
            .await;
        state.cancel_senders.lock().await.remove(&session_id);
        state
            .send_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "stopReason": stop_reason }
            }))
            .await;
        return;
    }

    if prompt_text.contains("full_stream") {
        let session = {
            let mut store = state.store.lock().await;
            let session = store.sessions.get_mut(&session_id).expect("session exists");
            session.turn_count += 1;
            session.clone()
        };
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "plan", "description": "Switch to planning mode" },
                        { "name": "compact", "description": "Compact conversation context" }
                    ]
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "config_option_update",
                    "configOptions": build_config_options(&session)
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "Thinking step 1. " }
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": "Thinking step 2." }
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "plan",
                    "entries": [
                        { "content": "Inspect workspace", "priority": "high", "status": "completed" },
                        { "content": "Reply to user", "priority": "medium", "status": "in_progress" }
                    ]
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Intro " }
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc-1",
                    "title": "Read README.md",
                    "kind": "read",
                    "status": "pending",
                    "locations": [{ "path": "README.md", "line": 1 }]
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-1",
                    "status": "in_progress"
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-1",
                    "status": "completed",
                    "rawOutput": { "bytes": 128 }
                }),
            )
            .await;
        let suffix = if resource_uris.is_empty() {
            format!(
                "Done(tag={})",
                session.driver_tag.as_deref().unwrap_or("none")
            )
        } else {
            format!(
                "Done(resources={},tag={})",
                resource_uris.join(","),
                session.driver_tag.as_deref().unwrap_or("none")
            )
        };
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": suffix }
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "usage_update",
                    "size": 128000,
                    "used": 1024
                }),
            )
            .await;
        state
            .send_update(
                &session_id,
                json!({
                    "sessionUpdate": "compaction_update",
                    "summary": "Compacted 10 messages",
                    "tokensBefore": 2000,
                    "tokensAfter": 600
                }),
            )
            .await;
        {
            let mut store = state.store.lock().await;
            if let Some(entry) = store.sessions.get_mut(&session_id) {
                entry
                    .history
                    .push((prompt_text.clone(), format!("Intro {suffix}")));
            }
        }
        state.flush_store().await;
        state.cancel_senders.lock().await.remove(&session_id);
        state
            .send_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "stopReason": "end_turn",
                    "usage": { "totalTokens": 1024 }
                }
            }))
            .await;
        return;
    }

    // Default echo_session turn
    let reply = {
        let mut store = state.store.lock().await;
        let session = store.sessions.get_mut(&session_id).expect("session exists");
        session.turn_count += 1;
        let reply = format!(
            "turn={} model={} thought={} mode={} tag={}",
            session.turn_count,
            session.model,
            session.thought_level,
            session.mode,
            session.driver_tag.as_deref().unwrap_or("none")
        );
        session.history.push((prompt_text.clone(), reply.clone()));
        reply
    };
    state.flush_store().await;
    state
        .send_update(
            &session_id,
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": reply }
            }),
        )
        .await;
    state.cancel_senders.lock().await.remove(&session_id);
    state
        .send_json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "stopReason": "end_turn" }
        }))
        .await;
}
