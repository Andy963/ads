use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_contract::models::{ModelConfig, ModelProvider};
use ads_contract::native_transcript::NativeTranscriptTurnStatus;
use ads_native::{
    ActionTools, ActionToolsFactory, AdsMiddleware, CfMemClient, CfMemMiddleware, MiddlewareFuture,
    MiddlewarePipeline, ModelResolver, NativePromptRunner, NativePromptRunnerOptions, TurnContext,
};
use ads_runtime::{PromptQueueRunOutcome, PromptQueueRunner, PromptRunContext};
use ads_state::{
    BeginNativeTurn, CONVERSATION_SERVICE, EnqueuePromptInput, HistoryStore, NativeTranscriptStore,
    PromptQueueLane, PromptQueueStore, StateDb, UpstreamCredentialStore, UpstreamCredentials,
    save_model_service, upsert_model_config, upsert_model_provider, workspace_state_path_in,
};
use axum::Router;
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::post;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const OWNER: &str = "user-1";
const HISTORY_KEY: &str = "user-1::session-1::main";
const LOGICAL_HISTORY_KEY: &str = "user-1::session-1::main";
const NAMESPACE: &str = "web-acopilot";
const CHAT_SESSION_ID: &str = "main";
const SESSION_ID: &str = "session-1";
const PEPPER: &str = "native-runner-test-pepper";

struct Harness {
    db: StateDb,
    runner: Arc<NativePromptRunner>,
    events: Arc<Mutex<Vec<Value>>>,
    requests: Arc<Mutex<Vec<Value>>>,
    workspace: PathBuf,
    base_url: String,
    upstream: JoinHandle<()>,
}

impl Harness {
    async fn start(router: Router) -> Self {
        Self::start_with_wire(router, "chat", Arc::new(Mutex::new(Vec::new()))).await
    }

    async fn start_with_wire(
        router: Router,
        wire_api: &str,
        requests: Arc<Mutex<Vec<Value>>>,
    ) -> Self {
        Self::start_inner(router, wire_api, requests, None, None, None, None).await
    }

    async fn start_with_retry(
        router: Router,
        requests: Arc<Mutex<Vec<Value>>>,
        retry_count: usize,
        backoff_ms: Vec<u64>,
    ) -> Self {
        Self::start_inner(
            router,
            "chat",
            requests,
            None,
            None,
            None,
            Some((retry_count, Some(backoff_ms))),
        )
        .await
    }

    async fn start_with_action_tools(
        router: Router,
        requests: Arc<Mutex<Vec<Value>>>,
        action_tools: ActionTools,
    ) -> Self {
        Self::start_inner(
            router,
            "chat",
            requests,
            Some(action_tools),
            None,
            None,
            None,
        )
        .await
    }

    async fn start_with_action_tools_factory(
        router: Router,
        requests: Arc<Mutex<Vec<Value>>>,
        factory: ActionToolsFactory,
    ) -> Self {
        Self::start_inner(router, "chat", requests, None, Some(factory), None, None).await
    }

    async fn start_with_middleware(
        router: Router,
        requests: Arc<Mutex<Vec<Value>>>,
        middleware: MiddlewarePipeline,
    ) -> Self {
        Self::start_inner(router, "chat", requests, None, None, Some(middleware), None).await
    }

    async fn start_inner(
        router: Router,
        wire_api: &str,
        requests: Arc<Mutex<Vec<Value>>>,
        action_tools: Option<ActionTools>,
        action_tools_factory: Option<ActionToolsFactory>,
        middleware: Option<MiddlewarePipeline>,
        retry: Option<(usize, Option<Vec<u64>>)>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream");
        let address = listener.local_addr().expect("upstream address");
        let base_url = format!("http://{address}/v1");
        let upstream = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let directory = tempdir().expect("temp dir");
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        configure_model(&db, &base_url, wire_api);

        let credentials = UpstreamCredentialStore::with_pepper(PEPPER);
        let resolver = ModelResolver::new(db.clone()).with_credential_store(credentials);
        let mut options = NativePromptRunnerOptions::new(db.clone(), resolver);
        options.turn_timeout = None;
        options.action_tools = action_tools;
        options.action_tools_factory = action_tools_factory;
        options.middleware = middleware;
        if let Some((retry_count, backoff_ms)) = retry {
            options.upstream_retry_count = retry_count;
            options.retry_backoff_ms = backoff_ms;
        }
        let runner = Arc::new(NativePromptRunner::new(options));
        let events = Arc::new(Mutex::new(Vec::new()));
        // Keep the temp directory alive for the lifetime of the database.
        std::mem::forget(directory);
        Self {
            db,
            runner,
            events,
            requests,
            workspace,
            base_url,
            upstream,
        }
    }

    fn context(&self) -> PromptRunContext {
        let events = Arc::clone(&self.events);
        PromptRunContext::new(Arc::new(move |payload| {
            events.lock().expect("events").push(payload);
        }))
    }

    fn enqueue(&self, client_message_id: &str, text: &str) -> ads_state::PromptQueueEntry {
        self.enqueue_payload(client_message_id, payload(text))
    }

    fn enqueue_payload(
        &self,
        client_message_id: &str,
        payload: Map<String, Value>,
    ) -> ads_state::PromptQueueEntry {
        let connection = self.db.connect().expect("connection");
        let store = PromptQueueStore::new(&connection).expect("prompt queue store");
        let now = now_ms();
        store
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: client_message_id.to_string(),
                    lane: lane(),
                    user_id: 42,
                    workspace_root: self.workspace.to_string_lossy().to_string(),
                    payload,
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(now),
                },
                now,
            )
            .expect("enqueue")
            .entry
    }

    fn request_bodies(&self) -> Vec<Value> {
        self.requests.lock().expect("requests").clone()
    }

    fn event_types(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("events")
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }

    fn all_events(&self) -> Vec<Value> {
        self.events.lock().expect("events").clone()
    }

    fn events_of(&self, kind: &str) -> Vec<Value> {
        self.events
            .lock()
            .expect("events")
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some(kind))
            .cloned()
            .collect()
    }

    fn history(&self) -> Vec<ads_contract::ws::HistoryEntry> {
        let connection = self.db.connect().expect("connection");
        HistoryStore::new(NAMESPACE, 1000, 100_000)
            .get(&connection, HISTORY_KEY)
            .expect("history")
    }

    fn transcript_status(&self) -> NativeTranscriptTurnStatus {
        let connection = self.db.connect().expect("connection");
        let transcript_id: String = connection
            .query_row(
                "SELECT transcript_id FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("transcript id");
        let store = NativeTranscriptStore::new(&connection, &[]);
        let turns = store
            .list_turns(&transcript_id, None, false)
            .expect("transcript turns");
        turns.last().expect("a transcript turn").status
    }

    fn transcript_messages(&self) -> Vec<Value> {
        let connection = self.db.connect().expect("connection");
        let messages_json: String = connection
            .query_row(
                "SELECT messages_json FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("transcript messages");
        serde_json::from_str(&messages_json).expect("transcript messages json")
    }

    fn transcript_projection_messages(&self) -> Vec<Value> {
        let connection = self.db.connect().expect("connection");
        let transcript_id: String = connection
            .query_row(
                "SELECT transcript_id FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("transcript id");
        let store = NativeTranscriptStore::new(&connection, &[]);
        let turns = store
            .list_turns(&transcript_id, None, true)
            .expect("transcript turns");
        turns
            .last()
            .expect("a transcript turn")
            .messages
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn transcript_entries(&self) -> Vec<Value> {
        let connection = self.db.connect().expect("connection");
        let entries_json: String = connection
            .query_row(
                "SELECT entries_json FROM native_transcript_turns ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("transcript entries");
        serde_json::from_str(&entries_json).expect("transcript entries json")
    }

    fn set_model_config_json(&self, config: Value) {
        let connection = self.db.connect().expect("connection");
        connection
            .execute(
                "UPDATE model_configs SET config_json = ?1 WHERE id = 'model-1'",
                [config.to_string()],
            )
            .expect("update model config");
    }

    async fn drain(&self) {
        self.upstream.abort();
    }
}

fn configure_model(db: &StateDb, base_url: &str, wire_api: &str) {
    let now = now_ms();
    let mut connection = db.connect().expect("connection");
    upsert_model_provider(
        &connection,
        &ModelProvider {
            id: "prov-1".to_string(),
            name: "Test".to_string(),
            base_url: base_url.to_string(),
            credential_profile: Some("prov-1".to_string()),
            wire_api: Some(wire_api.to_string()),
            is_enabled: true,
            updated_at: None,
        },
        now,
    )
    .expect("provider");
    UpstreamCredentialStore::with_pepper(PEPPER)
        .save(
            &connection,
            OWNER,
            &UpstreamCredentials {
                base_url: base_url.to_string(),
                provider: "test".to_string(),
                api_key: "test-key".to_string(),
            },
            Some("prov-1"),
        )
        .expect("credentials");
    upsert_model_config(
        &mut connection,
        &ModelConfig {
            id: "model-1".to_string(),
            model_id: "fake-model".to_string(),
            display_name: "Fake".to_string(),
            provider: "test".to_string(),
            provider_id: Some("prov-1".to_string()),
            is_enabled: true,
            is_default: true,
            config_json: Some(json!({ "max_output_tokens": 1024 })),
            updated_at: None,
        },
        now,
    )
    .expect("model config");
    save_model_service(
        &mut connection,
        CONVERSATION_SERVICE,
        &["model-1".to_string()],
        Some("model-1"),
    )
    .expect("model service");
}

fn lane() -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: OWNER.to_string(),
        session_id: SESSION_ID.to_string(),
        chat_session_id: CHAT_SESSION_ID.to_string(),
        history_key: HISTORY_KEY.to_string(),
        logical_history_key: LOGICAL_HISTORY_KEY.to_string(),
        lane_namespace: NAMESPACE.to_string(),
        lane_generation: 1,
    }
}

fn payload(text: &str) -> Map<String, Value> {
    json!({ "text": text, "images": [] })
        .as_object()
        .expect("payload object")
        .clone()
}

fn transcript_id_for(entry: &ads_state::PromptQueueEntry) -> String {
    let value = json!({
        "version": 2,
        "owner": entry.auth_user_id,
        "sessionKey": entry.user_id.to_string(),
        "projectId": ads_state::derive_project_session_id(&entry.workspace_root),
        "domain": "default",
        "lane": "acopilot",
        "lifecycle": "durable",
    });
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn chat_stream_router() -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
                "data: [DONE]\n\n"
            );
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                body.to_string(),
            )
                .into_response()
        }),
    )
}

fn chat_directive_router() -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let content = "Before directive\n<<<tool.memory.update op=\"add\">>>\nremember directive\n>>>\nAfter directive";
            let event = json!({
                "choices": [{"delta": {"content": content}, "finish_reason": "stop"}]
            });
            let body = format!("data: {event}\n\ndata: [DONE]\n\n");
            ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
        }),
    )
}

fn chat_stream_router_captured(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                requests.lock().expect("requests").push(payload);
                let body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"},\"finish_reason\":null}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\n",
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
                    "data: [DONE]\n\n"
                );
                ([(header::CONTENT_TYPE, "text/event-stream")], body.to_string()).into_response()
            }
        }),
    )
}

fn chat_error_router() -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(|| async { (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "boom").into_response() }),
    )
}

fn chat_retry_once_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                let attempt = {
                    let mut requests = requests.lock().expect("requests");
                    requests.push(payload);
                    requests.len()
                };
                if attempt == 1 {
                    return (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "temporary upstream failure",
                    )
                        .into_response();
                }
                let body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"},\"finish_reason\":\"stop\"}]}\n\n",
                    "data: [DONE]\n\n"
                );
                ([(header::CONTENT_TYPE, "text/event-stream")], body.to_string()).into_response()
            }
        }),
    )
}

fn chat_tool_then_error_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                let attempt = {
                    let mut requests = requests.lock().expect("requests");
                    requests.push(payload);
                    requests.len()
                };
                if attempt > 1 {
                    return (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "temporary upstream failure",
                    )
                        .into_response();
                }
                let responses = [
                    json!({"choices": [{"delta": {"tool_calls": [
                        {"index": 0, "type": "function", "id": "read-1", "function": {"name": "read_file", "arguments": json!({"file": "notes.txt"}).to_string()}}
                    ]}, "finish_reason": null}]}),
                    json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                ];
                let body = responses
                    .into_iter()
                    .map(|value| format!("data: {value}\n\n"))
                    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                    .collect::<String>();
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_compaction_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                let is_summary = payload.get("tools").is_none();
                let round = {
                    let mut requests = requests.lock().expect("requests");
                    requests.push(payload);
                    requests.len()
                };
                if is_summary {
                    let body = json!({
                        "choices": [{
                            "message": {"role": "assistant", "content": "Read the first evidence batch."},
                            "finish_reason": "stop"
                        }],
                        "usage": {"prompt_tokens": 50, "completion_tokens": 8, "total_tokens": 58}
                    })
                    .to_string();
                    return ([(header::CONTENT_TYPE, "application/json")], body).into_response();
                }
                let responses = if round <= 3 {
                    vec![
                        json!({"choices": [{"delta": {"tool_calls": [
                            {"index": 0, "type": "function", "id": format!("read-{round}"), "function": {"name": "read_file", "arguments": json!({"file": "large.txt"}).to_string()}}
                        ]}, "finish_reason": null}]}),
                        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                    ]
                } else {
                    vec![
                        json!({"choices": [{"delta": {"content": "done after compaction"}, "finish_reason": "stop"}]}),
                        json!({"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23}}),
                    ]
                };
                let body = responses
                    .into_iter()
                    .map(|value| format!("data: {value}\n\n"))
                    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                    .collect::<String>();
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_hanging_router() -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            (axum::http::StatusCode::OK, "late").into_response()
        }),
    )
}

fn chat_tool_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                requests.lock().expect("requests").push(payload);
                let round = requests.lock().expect("requests").len();
                let patch = [
                    "*** Begin Patch",
                    "*** Add File: created.txt",
                    "+created by the tool loop",
                    "*** End Patch",
                ]
                .join("\n");
                let responses = if round == 1 {
                    vec![
                        json!({"choices": [{"delta": {"tool_calls": [
                            {"index": 0, "type": "function", "id": "read-1", "function": {"name": "read_file", "arguments": json!({"file": "notes.txt"}).to_string()}},
                            {"index": 1, "type": "function", "id": "patch-1", "function": {"name": "apply_patch", "arguments": json!({"patch": patch}).to_string()}}
                        ]}, "finish_reason": null}]}),
                        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                        json!({"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}),
                    ]
                } else {
                    vec![
                        json!({"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]}),
                        json!({"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 1, "total_tokens": 21}}),
                    ]
                };
                let body = responses
                    .into_iter()
                    .map(|value| format!("data: {value}\n\n"))
                    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                    .collect::<String>();
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_pending_command_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                requests.lock().expect("requests").push(payload);
                let round = requests.lock().expect("requests").len();
                let response = match round {
                    1 => json!({"choices": [{"delta": {
                        "content": "I need to inspect the process before waiting.",
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "id": "exec-1",
                            "function": {
                                "name": "exec_command",
                                "arguments": json!({
                                    "cmd": "/bin/sh",
                                    "args": ["-c", "sleep 1; printf 'finished\\n'"],
                                    "yield_time_ms": 1
                                }).to_string()
                            }
                        }]
                    }, "finish_reason": null}]}),
                    2 => json!({"choices": [{"delta": {"content": "too early"}, "finish_reason": "stop"}]}),
                    _ => json!({"choices": [{"delta": {"content": "command complete"}, "finish_reason": "stop"}]}),
                };
                let mut body = format!("data: {response}\n\n");
                if round == 1 {
                    body.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n");
                }
                body.push_str("data: [DONE]\n\n");
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_natural_language_command_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                let round = {
                    let mut requests = requests.lock().expect("requests");
                    requests.push(payload);
                    requests.len()
                };
                let response = if round == 1 {
                    json!({"choices": [{"delta": {
                        "content": "I should inspect the logs before acting.",
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "id": "invalid-command",
                            "function": {
                                "name": "exec_command",
                                "arguments": json!({
                                    "cmd": "I should inspect the logs before acting."
                                }).to_string()
                            }
                        }]
                    }, "finish_reason": null}]})
                } else {
                    json!({"choices": [{"delta": {"content": "invalid command rejected"}, "finish_reason": "stop"}]})
                };
                let mut body = format!("data: {response}\n\n");
                if round == 1 {
                    body.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n");
                }
                body.push_str("data: [DONE]\n\n");
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_parallel_tool_router_captured(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                requests.lock().expect("requests").push(payload);
                let responses = [
                    json!({"choices": [{"delta": {"tool_calls": [
                        {"index": 0, "type": "function", "id": "first-1", "function": {"name": "read_file", "arguments": "{\"file\":\"notes.txt\"}"}},
                        {"index": 1, "type": "function", "id": "second-1", "function": {"name": "read_file", "arguments": "{\"file\":\"notes.txt\"}"}}
                    ]}, "finish_reason": null}]}),
                    json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                    json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}}),
                ];
                let body = responses
                    .into_iter()
                    .map(|value| format!("data: {value}\n\n"))
                    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                    .collect::<String>();
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn chat_review_action_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/chat/completions",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value = serde_json::from_str(&body).expect("chat request body");
                requests.lock().expect("requests").push(payload);
                let round = requests.lock().expect("requests").len();
                let responses = if round == 1 {
                    vec![
                        json!({"choices": [{"delta": {"tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "id": "review-1",
                            "function": {"name": "review_action", "arguments": "{}"}
                        }]}, "finish_reason": null}]}),
                        json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
                    ]
                } else {
                    vec![
                        json!({"choices": [{"delta": {"content": "review queued"}, "finish_reason": "stop"}]}),
                    ]
                };
                let body = responses
                    .into_iter()
                    .map(|value| format!("data: {value}\n\n"))
                    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
                    .collect::<String>();
                ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
            }
        }),
    )
}

fn responses_stream_router(requests: Arc<Mutex<Vec<Value>>>) -> Router {
    Router::new().route(
        "/v1/responses",
        post(move |body: String| {
            let requests = Arc::clone(&requests);
            async move {
                let payload: Value =
                    serde_json::from_str(&body).expect("responses request body");
                requests.lock().expect("requests").push(payload);
                let body = concat!(
                    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-1\",\"status\":\"in_progress\"}}\n\n",
                    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg-1\",\"role\":\"assistant\",\"status\":\"in_progress\",\"content\":[]}}\n\n",
                    "data: {\"type\":\"response.content_part.added\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\",\"annotations\":[]}}\n\n",
                    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"delta\":\"Hello \"}\n\n",
                    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"delta\":\"world\"}\n\n",
                    "data: {\"type\":\"response.content_part.done\",\"item_id\":\"msg-1\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"Hello world\",\"annotations\":[]}}\n\n",
                    "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"msg-1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello world\",\"annotations\":[]}]}}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"id\":\"msg-1\",\"role\":\"assistant\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello world\",\"annotations\":[]}]}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
                );
                ([(header::CONTENT_TYPE, "text/event-stream")], body.to_string()).into_response()
            }
        }),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streams_chat_completion_into_events_history_and_transcript() {
    let harness = Harness::start(chat_stream_router()).await;
    let entry = harness.enqueue("cm-success", "hi there");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let types = harness.event_types();
    assert_eq!(types.first().map(String::as_str), Some("user"));
    assert!(types.iter().any(|kind| kind == "delta"));
    assert!(types.iter().any(|kind| kind == "assistant_item"));
    assert!(types.iter().any(|kind| kind == "phase_complete"));
    assert_eq!(types.last().map(String::as_str), Some("result"));

    let user_events = harness.events_of("user");
    assert_eq!(user_events.len(), 1);
    assert_eq!(
        user_events[0].get("eventId").and_then(Value::as_str),
        Some("user:cm-success")
    );
    let deltas = harness
        .events_of("delta")
        .iter()
        .filter_map(|event| event.get("delta").and_then(Value::as_str))
        .collect::<String>();
    assert_eq!(deltas, "Hello world");
    let assistant = harness.events_of("assistant_item");
    assert_eq!(
        assistant[0]
            .get("assistantItemText")
            .and_then(Value::as_str),
        Some("Hello world")
    );
    let result = harness.events_of("result");
    assert_eq!(result[0].get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        result[0].get("output").and_then(Value::as_str),
        Some("Hello world")
    );
    assert_eq!(
        result[0].get("effectiveModel").and_then(Value::as_str),
        Some("fake-model")
    );

    let history = harness.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].role, "user");
    let kind = history[0].kind.clone().expect("user kind");
    assert!(kind.starts_with("client_message_id:cm-success"));
    assert!(kind.contains("eff_model=fake-model"));
    assert_eq!(history[1].role, "ai");
    assert_eq!(history[1].text, "Hello world");
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Completed
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preserves_agent_origin_in_live_and_persisted_turn_metadata() {
    let harness = Harness::start(chat_stream_router()).await;
    let mut prompt = payload("Reviewer handoff");
    prompt.insert("origin".to_string(), json!("agent"));
    let entry = harness.enqueue_payload("cm-agent-origin", prompt);
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let user_event = harness
        .events_of("user")
        .into_iter()
        .next()
        .expect("user event");
    let live_kind = user_event
        .get("kind")
        .and_then(Value::as_str)
        .expect("live kind");
    assert!(live_kind.contains("origin=agent"), "kind={live_kind}");
    let history_kind = harness
        .history()
        .into_iter()
        .find(|entry| entry.role == "user")
        .and_then(|entry| entry.kind)
        .expect("history kind");
    assert!(history_kind.contains("origin=agent"), "kind={history_kind}");
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_scheduler_prompts_with_scheduler_owner_credentials() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_stream_router_captured(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    {
        let connection = harness.db.connect().expect("connection");
        UpstreamCredentialStore::with_pepper(PEPPER)
            .save(
                &connection,
                "scheduler",
                &UpstreamCredentials {
                    base_url: harness.base_url.clone(),
                    provider: "test".to_string(),
                    api_key: "scheduler-key".to_string(),
                },
                Some("prov-1"),
            )
            .expect("scheduler credentials");
    }

    let workspace_root = harness.workspace.to_string_lossy().to_string();
    let output = harness
        .runner
        .run_schedule_prompt(
            &workspace_root,
            "scheduler",
            "external-1",
            "scheduled hello",
        )
        .await
        .expect("scheduled prompt");
    assert_eq!(output, "Hello world");

    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 1);
    assert!(
        bodies[0]["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .any(|message| message["content"]
                .as_str()
                .is_some_and(|content| content.contains("scheduled hello")))
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn records_upstream_http_failure_in_history_and_transcript() {
    let harness = Harness::start(chat_error_router()).await;
    let entry = harness.enqueue("cm-error", "fail please");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|message| message.contains("status 500"))
    );

    let errors = harness.events_of("error");
    assert_eq!(errors.len(), 1);
    assert!(
        errors[0]
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("status 500"))
    );
    let history = harness.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].role, "status");
    assert_eq!(history[1].kind.as_deref(), Some("error"));
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Failed
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_records_interrupted_turn_and_error_history() {
    let harness = Harness::start(chat_hanging_router()).await;
    let entry = harness.enqueue("cm-cancel", "hang");
    let runner = Arc::clone(&harness.runner);
    let abort_entry = entry.clone();
    let context = harness.context();
    let task = tokio::spawn(async move { runner.run_prompt(entry, context).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    harness.runner.abort_run(&abort_entry);
    let outcome = task.await.expect("runner task").expect("run prompt");
    assert!(!outcome.ok);

    let errors = harness.events_of("error");
    assert_eq!(errors.len(), 1);
    assert_eq!(
        errors[0].get("message").and_then(Value::as_str),
        Some("已中断，输出可能不完整")
    );
    let history = harness.history();
    assert_eq!(history.last().expect("history entry").role, "status");
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Cancelled
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restores_interrupted_continuation_and_closes_unknown_tool_calls() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_stream_router_captured(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    let entry = harness.enqueue("cm-continuation", "continue");
    let transcript_id = transcript_id_for(&entry);
    {
        let connection = harness.db.connect().expect("connection");
        let store = NativeTranscriptStore::new(&connection, &[]);
        store
            .claim_transcript(&transcript_id, "old-writer")
            .expect("claim old transcript");
        store
            .begin_turn(BeginNativeTurn {
                transcript_id: transcript_id.clone(),
                turn_id: "old-turn".to_string(),
                messages: json!([
                    {"role": "user", "content": "edit it"},
                    {
                        "role": "assistant",
                        "tool_calls": [{
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "apply_patch", "arguments": "{}"}
                        }]
                    }
                ]),
                entries: json!([]),
                provider: json!({"provider": "test", "model": "fake-model"}),
                writer_id: Some("old-writer".to_string()),
                incremental: false,
            })
            .expect("begin old turn");
    }

    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run continuation prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let body = requests.lock().expect("requests")[0].clone();
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages");
    assert!(messages.iter().any(|message| {
        message.get("role").and_then(Value::as_str) == Some("tool")
            && message.get("tool_call_id").and_then(Value::as_str) == Some("call-1")
            && message.get("nativeToolOutcome").is_none()
            && message
                .get("content")
                .and_then(Value::as_str)
                .and_then(|content| serde_json::from_str::<Value>(content).ok())
                .is_some_and(|content| {
                    content.get("status") == Some(&json!("unknown"))
                        && content.get("turn_status") == Some(&json!("interrupted"))
                })
    }));
    assert!(messages.iter().any(|message| {
        message.get("role").and_then(Value::as_str) == Some("assistant")
            && message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains("not completed"))
    }));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executes_skill_tool_directives_after_the_model_turn() {
    let harness = Harness::start(chat_directive_router()).await;
    let entry = harness.enqueue("cm-directive", "remember this");
    let workspace = entry.workspace_root.clone();
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let expected = "Before directive\n\nAfter directive\n\ntool.memory.update: ok (add)";
    let result = &harness.events_of("result")[0];
    assert_eq!(result.get("output").and_then(Value::as_str), Some(expected));
    let history = harness.history();
    assert_eq!(
        history.last().map(|entry| entry.text.as_str()),
        Some(expected)
    );
    assert!(history.last().is_some_and(|entry| {
        !entry.text.contains("<<<tool.memory.update")
            && !entry.text.contains("remember directive\n>>>")
    }));

    let state_dir = harness.db.path().parent().expect("state dir");
    let memory_path = workspace_state_path_in(state_dir, &workspace, "memory.md");
    let memory = fs::read_to_string(memory_path).expect("memory file");
    assert!(memory.contains("remember directive"));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streams_responses_completion_and_replays_scoped_output() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        responses_stream_router(Arc::clone(&requests)),
        "responses",
        Arc::clone(&requests),
    )
    .await;

    let entry = harness.enqueue("cm-responses-1", "hi there");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run first prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let deltas = harness
        .events_of("delta")
        .iter()
        .filter_map(|event| event.get("delta").and_then(Value::as_str))
        .collect::<String>();
    assert_eq!(deltas, "Hello world");
    let result = harness.events_of("result");
    assert_eq!(
        result[0].get("output").and_then(Value::as_str),
        Some("Hello world")
    );
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Completed
    );

    let history = harness.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].text, "Hello world");

    let messages = harness.transcript_messages();
    assert_eq!(messages.len(), 2);
    let sidecar = messages[1]
        .get("nativeResponses")
        .expect("native responses sidecar");
    assert!(
        sidecar
            .get("scope")
            .and_then(Value::as_str)
            .is_some_and(|scope| scope.len() == 64)
    );
    assert_eq!(
        sidecar
            .get("output")
            .and_then(Value::as_array)
            .and_then(|output| output.first())
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str),
        Some("msg-1")
    );

    let second = harness.enqueue("cm-responses-2", "continue");
    let outcome = harness
        .runner
        .run_prompt(second, harness.context())
        .await
        .expect("run second prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[1].get("stream").and_then(Value::as_bool), Some(true));
    assert_eq!(bodies[1].get("store").and_then(Value::as_bool), Some(false));
    let replay = bodies[1]
        .get("input")
        .and_then(Value::as_array)
        .and_then(|input| {
            input
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some("msg-1"))
        })
        .expect("scoped Responses replay item");
    assert_eq!(replay.get("type").and_then(Value::as_str), Some("message"));
    assert_eq!(
        replay
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str),
        Some("Hello world")
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executes_multi_round_tool_calls_and_persists_evidence() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_tool_router(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    fs::write(harness.workspace.join("notes.txt"), "alpha\nbeta\n").expect("notes");

    let entry = harness.enqueue("cm-tools", "read and patch");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    assert_eq!(
        fs::read_to_string(harness.workspace.join("created.txt")).expect("created file"),
        "created by the tool loop\n"
    );
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Completed
    );
    let messages = harness.transcript_messages();
    assert_eq!(
        messages
            .iter()
            .filter_map(|message| message.get("role").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "tool", "tool", "assistant"]
    );
    let entries = harness.transcript_entries();
    let kinds = entries
        .iter()
        .filter_map(|entry| entry.get("kind").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        kinds,
        vec![
            "message",
            "message",
            "message",
            "file_change",
            "message",
            "message"
        ]
    );
    assert!(entries.iter().any(|entry| {
        entry.get("kind").and_then(Value::as_str) == Some("file_change")
            && entry
                .get("changes")
                .and_then(Value::as_array)
                .is_some_and(|changes| {
                    changes.iter().any(|change| {
                        change.get("kind").and_then(Value::as_str) == Some("add")
                            && change.get("path").and_then(Value::as_str) == Some("created.txt")
                    })
                })
    }));
    assert_eq!(harness.history().last().expect("history").text, "done");
    assert_eq!(
        harness.events_of("result")[0]
            .get("output")
            .and_then(Value::as_str),
        Some("done")
    );

    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 2);
    let tool_names = bodies[0]
        .get("tools")
        .and_then(Value::as_array)
        .expect("tools")
        .iter()
        .filter_map(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    assert!(tool_names.contains(&"read_file"));
    assert!(tool_names.contains(&"exec_command"));
    assert!(tool_names.contains(&"review_action"));
    let second_roles = bodies[1]
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .filter_map(|message| message.get("role").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(
        second_roles,
        vec!["system", "user", "assistant", "tool", "tool"]
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replaces_a_premature_final_answer_with_a_synthetic_wait() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_pending_command_router(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    let entry = harness.enqueue("cm-pending-command", "run and wait");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    let result = &harness.events_of("result")[0];
    assert_eq!(
        result.get("output").and_then(Value::as_str),
        Some("command complete")
    );
    assert!(
        !serde_json::to_string(&harness.events_of("result"))
            .expect("events")
            .contains("too early")
    );
    let serialized_events = serde_json::to_string(&harness.all_events()).expect("events");
    assert!(!serialized_events.contains("I need to inspect the process before waiting."));
    assert!(!serialized_events.contains("too early"));
    let command_events = harness.events_of("command");
    assert!(command_events.iter().any(|event| {
        event
            .get("command")
            .and_then(|command| command.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| {
                command.starts_with("/bin/sh -c ") && command.contains("printf 'finished")
            })
    }));
    let history_text = serde_json::to_string(&harness.history()).expect("history");
    assert!(!history_text.contains("I need to inspect the process before waiting."));

    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 3);
    let wait_call = bodies[2]
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
        .flatten()
        .find(|call| {
            call.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                == Some("wait_command")
        })
        .expect("synthetic wait command");
    assert!(
        wait_call
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("wait-"))
    );
    let entries = harness.transcript_entries();
    assert!(entries.iter().any(|entry| {
        entry.get("kind").and_then(Value::as_str) == Some("command")
            && entry.get("status").and_then(Value::as_str) == Some("completed")
            && entry.get("exitCode").and_then(Value::as_i64) == Some(0)
            && entry
                .get("output")
                .and_then(Value::as_str)
                .is_some_and(|output| output.contains("finished"))
    }));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_frames_natural_language_as_a_shell_command() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_natural_language_command_router(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    let entry = harness.enqueue("cm-invalid-command", "show the logs");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    let serialized_events = serde_json::to_string(&harness.all_events()).expect("events");
    assert!(
        !serialized_events.contains("I should inspect the logs before acting."),
        "{serialized_events}"
    );
    assert!(harness.events_of("command").is_empty());
    assert_eq!(
        harness.events_of("result")[0]
            .get("output")
            .and_then(Value::as_str),
        Some("invalid command rejected")
    );
    harness.drain().await;
}

struct PromptMiddleware {
    prompts: Arc<Mutex<Vec<String>>>,
    replies: Arc<Mutex<Vec<String>>>,
    errors: Arc<Mutex<Vec<String>>>,
}

impl AdsMiddleware for PromptMiddleware {
    fn name(&self) -> &str {
        "promptMiddleware"
    }

    fn on_before_input<'a>(
        &'a self,
        ctx: &'a mut TurnContext,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async move {
            self.prompts
                .lock()
                .expect("prompts")
                .push(ctx.prompt.clone());
            Some(format!("[middleware] {}", ctx.prompt))
        })
    }

    fn on_after_output<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        assistant_reply: &'a str,
    ) -> MiddlewareFuture<'a, ()> {
        Box::pin(async move {
            self.replies
                .lock()
                .expect("replies")
                .push(assistant_reply.to_string());
        })
    }

    fn on_turn_error<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        error: &'a str,
    ) -> MiddlewareFuture<'a, ()> {
        Box::pin(async move {
            self.errors.lock().expect("errors").push(error.to_string());
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applies_middleware_to_the_prompt_and_final_reply() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let replies = Arc::new(Mutex::new(Vec::new()));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let middleware = MiddlewarePipeline::new().with(Arc::new(PromptMiddleware {
        prompts: Arc::clone(&prompts),
        replies: Arc::clone(&replies),
        errors: Arc::clone(&errors),
    }));
    let harness = Harness::start_with_middleware(
        chat_stream_router_captured(Arc::clone(&requests)),
        requests,
        middleware,
    )
    .await;
    let entry = harness.enqueue("cm-middleware", "hi");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    assert_eq!(
        prompts.lock().expect("prompts").as_slice(),
        ["hi".to_string()]
    );
    assert_eq!(
        replies.lock().expect("replies").as_slice(),
        ["Hello world".to_string()]
    );
    assert!(errors.lock().expect("errors").is_empty());
    let body = &harness.request_bodies()[0];
    let user_message = body
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .expect("user message");
    assert_eq!(
        user_message.get("content").and_then(Value::as_str),
        Some("[middleware] hi")
    );
    harness.drain().await;
}

type CfMemCaptures = Arc<Mutex<Vec<(String, Value)>>>;

fn cfmem_router(requests: CfMemCaptures) -> Router {
    async fn context(State(requests): State<CfMemCaptures>, body: String) -> impl IntoResponse {
        requests.lock().expect("cfmem requests").push((
            "context".to_string(),
            serde_json::from_str(&body).expect("context json"),
        ));
        axum::Json(json!({"claims": [{"canonical_text": "remember the tests"}]}))
    }
    async fn ingest(State(requests): State<CfMemCaptures>, body: String) -> impl IntoResponse {
        requests.lock().expect("cfmem requests").push((
            "ingest".to_string(),
            serde_json::from_str(&body).expect("ingest json"),
        ));
        axum::Json(json!({"ok": true}))
    }
    Router::new()
        .route("/memory/context", post(context))
        .route("/memory/profile/ingest", post(ingest))
        .with_state(requests)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recalls_and_ingests_cfmem_through_the_middleware_pipeline() {
    let cfmem_requests = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind cfmem");
    let address = listener.local_addr().expect("cfmem address");
    let cfmem_requests_for_server = Arc::clone(&cfmem_requests);
    let cfmem = tokio::spawn(async move {
        let _ = axum::serve(listener, cfmem_router(cfmem_requests_for_server)).await;
    });
    let client = CfMemClient::new(
        &format!("http://{address}"),
        "secret-key",
        Some(2),
        Some(1_000),
    )
    .expect("cfmem client");
    let middleware =
        MiddlewarePipeline::new().with(Arc::new(CfMemMiddleware::new(Arc::new(client))));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_middleware(
        chat_stream_router_captured(Arc::clone(&requests)),
        Arc::clone(&requests),
        middleware,
    )
    .await;
    fs::create_dir_all(harness.workspace.join(".git")).expect("git marker");
    let entry = harness.enqueue("cm-cfmem", "hi there");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());

    let body = requests.lock().expect("requests")[0].clone();
    let user = body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .expect("user content");
    assert!(user.contains("<recalled_memory>\n- remember the tests\n</recalled_memory>"));
    assert!(user.ends_with("hi there"));

    tokio::time::sleep(Duration::from_millis(100)).await;
    let captured = cfmem_requests.lock().expect("cfmem requests").clone();
    assert_eq!(captured[0].0, "context");
    assert_eq!(captured[0].1["query"], "hi there");
    assert_eq!(captured[0].1["limit"], 2);
    assert!(captured.iter().any(|(kind, body)| {
        kind == "ingest" && body["role"] == "user" && body["text"] == "hi there"
    }));
    assert!(
        captured
            .iter()
            .any(|(kind, body)| { kind == "ingest" && body["role"] == "assistant" })
    );
    cfmem.abort();
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executes_review_action_through_the_prompt_runner() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_action_tools(
        chat_review_action_router(Arc::clone(&requests)),
        requests,
        ActionTools::new(|| async {
            Ok(json!({
                "ok": true,
                "jobId": "job-42",
                "status": "queued",
                "issueId": 7,
                "note": "Verdict is pending."
            }))
        }),
    )
    .await;
    let entry = harness.enqueue("cm-review-action", "review this");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    let result = &harness.events_of("result")[0];
    assert_eq!(
        result.get("output").and_then(Value::as_str),
        Some("review queued")
    );
    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 2);
    let tool_messages = bodies[1]
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .collect::<Vec<_>>();
    assert_eq!(tool_messages.len(), 1);
    let tool_output = tool_messages[0]
        .get("content")
        .and_then(Value::as_str)
        .expect("tool output");
    assert!(tool_output.contains("review_action completed."));
    assert!(tool_output.contains("Actions job: job-42."));
    assert!(tool_output.contains("Issue: #7."));
    let entries = harness.transcript_entries();
    assert!(entries.iter().any(|entry| {
        entry
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .is_some_and(|content| content.contains("review_action completed."))
    }));
    harness.drain().await;
}

#[tokio::test]
async fn executes_review_action_through_action_tools_factory() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen_workspace = Arc::new(Mutex::new(String::new()));
    let seen_ws = Arc::clone(&seen_workspace);
    let harness = Harness::start_with_action_tools_factory(
        chat_review_action_router(Arc::clone(&requests)),
        requests,
        Arc::new(move |entry| {
            *seen_ws.lock().expect("lock") = entry.workspace_root.clone();
            Some(ActionTools::new(|| async {
                Ok(json!({
                    "ok": true,
                    "jobId": "factory-job-99",
                    "status": "queued",
                    "issueId": 42,
                    "note": "Dispatched via factory."
                }))
            }))
        }),
    )
    .await;
    let entry = harness.enqueue("cm-factory-action", "run review");
    let expected_root = entry.workspace_root.clone();
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    assert_eq!(*seen_workspace.lock().expect("lock"), expected_root);
    let bodies = harness.request_bodies();
    let tool_messages = bodies[1]
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
        .collect::<Vec<_>>();
    assert_eq!(tool_messages.len(), 1);
    let tool_output = tool_messages[0]
        .get("content")
        .and_then(Value::as_str)
        .expect("tool output");
    assert!(tool_output.contains("Actions job: factory-job-99."));
    assert!(tool_output.contains("Issue: #42."));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_unsupported_tool_calls_before_contacting_the_provider() {
    let harness = Harness::start(chat_stream_router()).await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"toolCalls": "unsupported"}
    }));
    let entry = harness.enqueue("cm-tool-capability", "hello");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("toolCalls")),
        "unexpected error: {:?}",
        outcome.error
    );
    assert!(harness.request_bodies().is_empty());
    assert!(harness.events_of("error").iter().any(|event| {
        event
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("toolCalls"))
    }));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_unsupported_streaming_before_contacting_the_provider() {
    let harness = Harness::start(chat_stream_router()).await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"streaming": "unsupported"}
    }));
    let entry = harness.enqueue("cm-stream-capability", "hello");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("streaming")),
        "unexpected error: {:?}",
        outcome.error
    );
    assert!(harness.request_bodies().is_empty());
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_images_when_the_provider_marks_image_input_unsupported() {
    let harness = Harness::start(chat_stream_router()).await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"imageInput": "unsupported"}
    }));
    let mut image_payload = payload("look at this");
    image_payload.insert(
        "images".to_string(),
        json!([{"data": "data:image/png;base64,iVBORw0KGgo="}]),
    );
    let entry = harness.enqueue_payload("cm-image-capability", image_payload);
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("imageInput")),
        "unexpected error: {:?}",
        outcome.error
    );
    assert!(harness.request_bodies().is_empty());
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn omits_usage_options_when_the_provider_marks_usage_unsupported() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_stream_router_captured(Arc::clone(&requests)),
        "chat",
        requests,
    )
    .await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"usage": "unsupported"}
    }));
    let entry = harness.enqueue("cm-usage-capability", "hello");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert_eq!(outcome, PromptQueueRunOutcome::success());
    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 1);
    assert!(bodies[0].get("stream_options").is_none());
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_parallel_tool_calls_when_capability_is_unknown() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_parallel_tool_router_captured(Arc::clone(&requests)),
        "chat",
        requests,
    )
    .await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"parallelToolCalls": "unknown"}
    }));
    let entry = harness.enqueue("cm-parallel-unknown", "read twice");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("parallel tool calls")),
        "unexpected error: {:?}",
        outcome.error
    );
    assert!(
        harness.request_bodies()[0]
            .get("parallel_tool_calls")
            .is_none()
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_parallel_tool_calls_when_the_model_config_marks_them_unsupported() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_parallel_tool_router_captured(Arc::clone(&requests)),
        "chat",
        requests,
    )
    .await;
    harness.set_model_config_json(json!({
        "max_output_tokens": 1024,
        "capabilities": {"parallelToolCalls": false}
    }));
    let entry = harness.enqueue("cm-parallel-tools", "read twice");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok, "parallel tool calls must fail the turn");
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("parallel tool calls")),
        "unexpected error: {:?}",
        outcome.error
    );
    assert_eq!(
        harness.request_bodies()[0]
            .get("parallel_tool_calls")
            .and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Failed
    );
    assert!(harness.events_of("error").iter().any(|event| {
        event
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("parallel tool calls"))
    }));
    harness.drain().await;
}

fn tool_batch_count(messages: &[Value]) -> usize {
    messages
        .iter()
        .filter(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty())
        })
        .count()
}

fn has_message_text(messages: &[Value], needle: &str) -> bool {
    messages.iter().any(|message| {
        message
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|content| content.contains(needle))
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_transient_upstream_failures_before_any_side_effect() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_retry(
        chat_retry_once_router(Arc::clone(&requests)),
        Arc::clone(&requests),
        1,
        vec![0],
    )
    .await;

    let entry = harness.enqueue("cm-retry", "retry please");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(outcome.ok, "unexpected error: {:?}", outcome.error);
    assert_eq!(harness.request_bodies().len(), 2);

    let retries = harness.events_of("retry");
    assert_eq!(retries.len(), 1);
    assert_eq!(retries[0].get("retryCount"), Some(&json!(1)));
    assert_eq!(retries[0].get("nextAttempt"), Some(&json!(2)));
    assert_eq!(retries[0].get("maxAttempts"), Some(&json!(2)));
    assert_eq!(retries[0].get("delayMs"), Some(&json!(0)));
    assert_eq!(harness.history().last().expect("history").text, "recovered");
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn does_not_retry_after_a_tool_side_effect() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_retry(
        chat_tool_then_error_router(Arc::clone(&requests)),
        Arc::clone(&requests),
        2,
        vec![0, 0, 0],
    )
    .await;
    fs::write(harness.workspace.join("notes.txt"), "alpha\nbeta\n").expect("notes");

    let entry = harness.enqueue("cm-tool-retry", "read then fail");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(!outcome.ok);
    assert_eq!(harness.request_bodies().len(), 2);
    assert!(harness.events_of("retry").is_empty());
    assert_eq!(
        harness.transcript_status(),
        NativeTranscriptTurnStatus::Failed
    );
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compacts_closed_tool_batches_and_persists_the_projection() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_compaction_router(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    fs::write(harness.workspace.join("large.txt"), "x".repeat(10_000)).expect("large file");
    harness.set_model_config_json(json!({
        "max_input_tokens": 12_000,
        "max_output_tokens": 1_000
    }));

    let entry = harness.enqueue("cm-compact", "read repeatedly");
    let outcome = harness
        .runner
        .run_prompt(entry, harness.context())
        .await
        .expect("run prompt");
    assert!(outcome.ok, "unexpected error: {:?}", outcome.error);

    let bodies = harness.request_bodies();
    assert_eq!(bodies.len(), 5);
    let summary_index = bodies
        .iter()
        .position(|body| body.get("tools").is_none())
        .expect("summary request");
    let summary_messages = bodies[summary_index]
        .get("messages")
        .and_then(Value::as_array)
        .expect("summary messages");
    assert!(has_message_text(
        summary_messages,
        "Summarize execution evidence"
    ));

    let final_messages = bodies
        .last()
        .and_then(|body| body.get("messages"))
        .and_then(Value::as_array)
        .expect("final messages");
    assert_eq!(tool_batch_count(final_messages), 2);
    assert!(has_message_text(
        final_messages,
        "[Execution summary; not completion]"
    ));

    let stored = harness.transcript_messages();
    assert_eq!(tool_batch_count(&stored), 2);
    assert!(has_message_text(
        &stored,
        "[Execution summary; not completion]"
    ));
    let projection = harness.transcript_projection_messages();
    assert_eq!(tool_batch_count(&projection), 2);
    assert_eq!(
        projection
            .iter()
            .filter(|message| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.contains("[Execution summary; not completion]"))
            })
            .count(),
        1
    );
    assert!(harness.events_of("context").iter().any(|event| {
        event
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.contains("-compact-"))
    }));
    harness.drain().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn carries_a_persisted_execution_summary_into_the_next_turn() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let harness = Harness::start_with_wire(
        chat_compaction_router(Arc::clone(&requests)),
        "chat",
        Arc::clone(&requests),
    )
    .await;
    fs::write(harness.workspace.join("large.txt"), "x".repeat(10_000)).expect("large file");
    harness.set_model_config_json(json!({
        "max_input_tokens": 12_000,
        "max_output_tokens": 1_000
    }));

    let first = harness.enqueue("cm-compact-first", "first task");
    let first_outcome = harness
        .runner
        .run_prompt(first, harness.context())
        .await
        .expect("run first prompt");
    assert!(
        first_outcome.ok,
        "unexpected error: {:?}",
        first_outcome.error
    );
    let first_request_count = harness.request_bodies().len();

    let second = harness.enqueue("cm-compact-second", "follow up task");
    let second_outcome = harness
        .runner
        .run_prompt(second, harness.context())
        .await
        .expect("run second prompt");
    assert!(
        second_outcome.ok,
        "unexpected error: {:?}",
        second_outcome.error
    );

    let bodies = harness.request_bodies();
    assert!(bodies.len() > first_request_count);
    let second_turn_messages = bodies
        .last()
        .and_then(|body| body.get("messages"))
        .and_then(Value::as_array)
        .expect("second turn messages");
    assert!(has_message_text(second_turn_messages, "first task"));
    assert!(has_message_text(second_turn_messages, "follow up task"));
    assert_eq!(
        second_turn_messages
            .iter()
            .filter(|message| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.contains("[Execution summary; not completion]"))
            })
            .count(),
        1
    );
    assert!(has_message_text(
        second_turn_messages,
        "Read the first evidence batch."
    ));
    harness.drain().await;
}
