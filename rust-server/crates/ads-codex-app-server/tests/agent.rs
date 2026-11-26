use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use ads_codex_app_server::{
    AgentActionTools, AgentInputPart, AgentSendOptions, ClientFactory, CodexAppServerAgent,
    CodexAppServerAgentOptions, CodexAppServerClient, CodexAppServerDaemonRegistry, SandboxMode,
    SpawnOptions,
};
use serde_json::{Value, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, split,
};
use tokio::sync::Mutex;

struct ServerSide {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl ServerSide {
    async fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line).await {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(line.trim()).ok(),
        }
    }

    async fn write(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .expect("server write");
        self.writer.flush().await.expect("server flush");
    }

    async fn respond(&mut self, id: &Value, result: Value) {
        self.write(json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await;
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.write(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await;
    }
}

fn fake_factory(
    requests: Arc<Mutex<Vec<Value>>>,
    complete_turns: bool,
    token_pressure: bool,
    compact_missing: bool,
    edge_events: bool,
) -> ClientFactory {
    Arc::new(move |_: SpawnOptions| {
        let requests = Arc::clone(&requests);
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                let turns = AtomicUsize::new(0);
                let thread_starts = AtomicUsize::new(0);
                while let Some(message) = server.read().await {
                    requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            let thread_id = if compact_missing
                                && thread_starts.fetch_add(1, Ordering::AcqRel) > 0
                            {
                                "thread-fresh"
                            } else {
                                "thread-1"
                            };
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "thread": {"id": thread_id},
                                        "sandbox": {"type": "workspaceWrite"},
                                        "approvalPolicy": "untrusted"
                                    }),
                                )
                                .await;
                        }
                        "thread/resume" => {
                            let thread_id =
                                message["params"]["threadId"].as_str().unwrap_or("thread-1");
                            server
                                .respond(&message["id"], json!({"thread": {"id": thread_id}}))
                                .await;
                        }
                        "turn/start" => {
                            let turn = turns.fetch_add(1, Ordering::AcqRel) + 1;
                            let thread_id =
                                message["params"]["threadId"].as_str().unwrap_or("thread-1");
                            let turn_id = format!("turn-{turn}");
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify("thread/started", json!({"thread": {"id": thread_id}}))
                                .await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({"threadId": thread_id, "turn": {"id": turn_id}}),
                                )
                                .await;
                            if token_pressure && turn == 1 {
                                server
                                    .notify(
                                        "thread/tokenUsage/updated",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "tokenUsage": {
                                                "last": {
                                                    "totalTokens": 800,
                                                    "inputTokens": 700,
                                                    "outputTokens": 100
                                                },
                                                "modelContextWindow": 1_000
                                            }
                                        }),
                                    )
                                    .await;
                            }
                            if edge_events {
                                server
                                    .notify(
                                        "turn/plan/updated",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "plan": [{"step": "Inspect", "status": "completed"}]
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/plan/delta",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "itemId": "plan-1",
                                            "delta": "Hidden plan"
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/reasoning/summaryTextDelta",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "itemId": "reasoning-1",
                                            "delta": "Hidden reasoning"
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/agentMessage/delta",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "itemId": "commentary-1",
                                            "delta": "Hidden commentary"
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/completed",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "item": {
                                                "type": "agentMessage",
                                                "id": "commentary-1",
                                                "text": "Hidden commentary",
                                                "phase": "commentary"
                                            }
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/started",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "item": {"type": "collabAgentToolCall", "id": "collab-1"}
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/completed",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "item": {"type": "collabAgentToolCall", "id": "collab-1"}
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/started",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "item": {"type": "contextCompaction", "id": "compact-item"}
                                        }),
                                    )
                                    .await;
                                server
                                    .notify(
                                        "item/completed",
                                        json!({
                                            "threadId": thread_id,
                                            "turnId": turn_id,
                                            "item": {"type": "contextCompaction", "id": "compact-item"}
                                        }),
                                    )
                                    .await;
                            }
                            if !complete_turns {
                                continue;
                            }
                            server
                                .notify(
                                    "item/started",
                                    json!({
                                        "threadId": thread_id,
                                        "turnId": turn_id,
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "message-1",
                                            "phase": "final_answer",
                                            "text": ""
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "item/agentMessage/delta",
                                    json!({"threadId": thread_id, "turnId": turn_id, "itemId": "message-1", "delta": if turn == 1 { "Hi " } else { "Second " }}),
                                )
                                .await;
                            server
                                .notify(
                                    "item/agentMessage/delta",
                                    json!({"threadId": thread_id, "turnId": turn_id, "itemId": "message-1", "delta": if turn == 1 { "there!" } else { "answer" }}),
                                )
                                .await;
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": thread_id,
                                        "turnId": turn_id,
                                        "item": {"type": "agentMessage", "id": "message-1", "phase": "final_answer", "text": if turn == 1 { "Hi there!" } else { "Second answer" }}
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": thread_id,
                                        "turn": {"id": turn_id},
                                        "usage": if token_pressure {
                                            Value::Null
                                        } else {
                                            json!({"input_tokens": 5, "output_tokens": 7})
                                        }
                                    }),
                                )
                                .await;
                        }
                        "thread/compact/start" => {
                            if compact_missing {
                                server
                                    .write(json!({
                                        "jsonrpc": "2.0",
                                        "id": message["id"],
                                        "error": {
                                            "code": -32600,
                                            "message": "thread not found: thread-1"
                                        }
                                    }))
                                    .await;
                                continue;
                            }
                            let thread_id =
                                message["params"]["threadId"].as_str().unwrap_or("thread-1");
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({
                                        "threadId": thread_id,
                                        "turn": {"id": "compact-1", "status": "inProgress"}
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "item/started",
                                    json!({
                                        "threadId": thread_id,
                                        "turnId": "compact-1",
                                        "item": {"type": "contextCompaction", "id": "compact-item"}
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "thread/compacted",
                                    json!({"threadId": thread_id, "turnId": "compact-1"}),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": thread_id,
                                        "turn": {"id": "compact-1", "status": "completed"}
                                    }),
                                )
                                .await;
                        }
                        "turn/interrupt" => {
                            server.respond(&message["id"], json!({})).await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

fn approval_factory(
    requests: Arc<Mutex<Vec<Value>>>,
    responses: Arc<Mutex<Vec<Value>>>,
    rework_arguments: Value,
) -> ClientFactory {
    Arc::new(move |_: SpawnOptions| {
        let requests = Arc::clone(&requests);
        let responses = Arc::clone(&responses);
        let rework_arguments = rework_arguments.clone();
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                while let Some(message) = server.read().await {
                    requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "thread": {"id": "thread-approval"},
                                        "sandbox": {"type": "workspaceWrite"},
                                        "approvalPolicy": "untrusted"
                                    }),
                                )
                                .await;
                        }
                        "turn/start" => {
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify(
                                    "thread/started",
                                    json!({"thread": {"id": "thread-approval"}}),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turn": {"id": "turn-approval"}
                                    }),
                                )
                                .await;
                            for (id, method, params) in [
                                (
                                    "approval-command",
                                    "item/commandExecution/requestApproval",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "itemId": "command-blocked",
                                        "command": "rm -f state.db"
                                    }),
                                ),
                                (
                                    "approval-reasoning",
                                    "item/commandExecution/requestApproval",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "itemId": "command-reasoning",
                                        "command": "Please run rm -f state.db"
                                    }),
                                ),
                                (
                                    "approval-file",
                                    "item/fileChange/requestApproval",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "itemId": "file-safe"
                                    }),
                                ),
                                (
                                    "builtin-review-1",
                                    "item/tool/call",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "callId": "review-1",
                                        "tool": "review_action",
                                        "arguments": rework_arguments.clone()
                                    }),
                                ),
                                (
                                    "builtin-review-replay",
                                    "item/tool/call",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "callId": "review-1",
                                        "tool": "review_action",
                                        "arguments": rework_arguments.clone()
                                    }),
                                ),
                            ] {
                                server
                                    .write(json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "method": method,
                                        "params": params
                                    }))
                                    .await;
                                if let Some(response) = server.read().await {
                                    responses.lock().await.push(response);
                                }
                            }
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "item": {
                                            "type": "commandExecution",
                                            "id": "command-blocked",
                                            "command": "rm -f state.db",
                                            "status": "declined"
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "item": {
                                            "type": "commandExecution",
                                            "id": "command-reasoning",
                                            "command": "Please run rm -f state.db",
                                            "status": "declined"
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turnId": "turn-approval",
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "message-approval",
                                            "text": "approved and queued"
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": "thread-approval",
                                        "turn": {"id": "turn-approval"}
                                    }),
                                )
                                .await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

fn recover_turn_factory(requests: Arc<Mutex<Vec<Value>>>) -> ClientFactory {
    Arc::new(move |_: SpawnOptions| {
        let requests = Arc::clone(&requests);
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                let thread_starts = AtomicUsize::new(0);
                let turn_starts = AtomicUsize::new(0);
                while let Some(message) = server.read().await {
                    requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            let thread_id = if thread_starts.fetch_add(1, Ordering::AcqRel) == 0 {
                                "thread-old"
                            } else {
                                "thread-new"
                            };
                            server
                                .respond(&message["id"], json!({"thread": {"id": thread_id}}))
                                .await;
                        }
                        "turn/start" => {
                            let attempt = turn_starts.fetch_add(1, Ordering::AcqRel) + 1;
                            if attempt == 2 {
                                server
                                    .write(json!({
                                        "jsonrpc": "2.0",
                                        "id": message["id"],
                                        "error": {
                                            "code": -32600,
                                            "message": "thread not found: thread-old"
                                        }
                                    }))
                                    .await;
                                continue;
                            }
                            let thread_id = message["params"]["threadId"]
                                .as_str()
                                .unwrap_or("thread-new");
                            let turn_id = format!("turn-{attempt}");
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify("thread/started", json!({"thread": {"id": thread_id}}))
                                .await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({"threadId": thread_id, "turn": {"id": turn_id}}),
                                )
                                .await;
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": thread_id,
                                        "turnId": turn_id,
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "message-recovered",
                                            "text": format!("response-{attempt}")
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({"threadId": thread_id, "turn": {"id": turn_id}}),
                                )
                                .await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

fn retry_factory(requests: Arc<Mutex<Vec<Value>>>, side_effect: bool) -> ClientFactory {
    Arc::new(move |_: SpawnOptions| {
        let requests = Arc::clone(&requests);
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                let turns = AtomicUsize::new(0);
                while let Some(message) = server.read().await {
                    requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            server
                                .respond(&message["id"], json!({"thread": {"id": "thread-retry"}}))
                                .await;
                        }
                        "turn/start" => {
                            let turn = turns.fetch_add(1, Ordering::AcqRel) + 1;
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({
                                        "threadId": "thread-retry",
                                        "turn": {"id": format!("turn-{turn}")}
                                    }),
                                )
                                .await;
                            if turn == 1 {
                                if side_effect {
                                    server
                                        .notify(
                                            "item/started",
                                            json!({
                                                "threadId": "thread-retry",
                                                "turnId": "turn-1",
                                                "item": {
                                                    "type": "commandExecution",
                                                    "id": "command-1",
                                                    "command": "date",
                                                    "status": "in_progress"
                                                }
                                            }),
                                        )
                                        .await;
                                }
                                server
                                    .notify(
                                        "error",
                                        json!({
                                            "threadId": "thread-retry",
                                            "turnId": "turn-1",
                                            "willRetry": false,
                                            "error": {
                                                "message": "We're currently experiencing high demand, which may cause temporary errors"
                                            }
                                        }),
                                    )
                                    .await;
                                continue;
                            }
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-retry",
                                        "turnId": format!("turn-{turn}"),
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "message-retry",
                                            "text": "retry ok"
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": "thread-retry",
                                        "turn": {"id": format!("turn-{turn}")}
                                    }),
                                )
                                .await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

#[tokio::test]
async fn starts_thread_sends_turns_and_aggregates_agent_messages() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        let factory = fake_factory(
            Arc::clone(&request_log_for_factory),
            true,
            false,
            false,
            false,
        );
        factory(options)
    });
    let registry_for_stop = Arc::clone(&registry);
    let workspace = std::env::temp_dir();
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-agent".to_string(),
        workspace_root: workspace.clone(),
        working_directory: Some(workspace.clone()),
        model: Some("gpt-test".to_string()),
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: Some("Follow the test contract.".to_string()),
        dynamic_tools: vec![json!({"type": "function", "name": "review_action"})],
        daemon_options: SpawnOptions::default(),
        registry: Some(registry),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    let first = agent
        .send(vec![AgentInputPart::text("hello")], None)
        .await
        .expect("first turn");
    assert_eq!(first.agent_id, "codex");
    assert_eq!(first.response, "Hi there!");
    assert_eq!(first.usage.expect("usage")["input_tokens"], 5);
    assert_eq!(agent.thread_id().await.as_deref(), Some("thread-1"));

    let second = agent
        .send(vec![AgentInputPart::text("again")], None)
        .await
        .expect("second turn");
    assert_eq!(second.response, "Second answer");

    registry_for_stop.stop("project-agent").await;
    let resumed = agent
        .send(vec![AgentInputPart::text("after restart")], None)
        .await
        .expect("resumed turn");
    assert_eq!(resumed.response, "Hi there!");

    let requests = request_log.lock().await;
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "thread/resume")
            .count(),
        1
    );
    let thread_start = requests
        .iter()
        .find(|request| request["method"] == "thread/start")
        .expect("thread start");
    assert_eq!(thread_start["params"]["approvalPolicy"], "untrusted");
    assert_eq!(thread_start["params"]["sandbox"], "workspace-write");
    assert_eq!(thread_start["params"]["model"], "gpt-test");
    assert_eq!(
        thread_start["params"]["developerInstructions"],
        "Follow the test contract."
    );
    assert_eq!(
        thread_start["params"]["dynamicTools"][0]["name"],
        "review_action"
    );
    let turns = requests
        .iter()
        .filter(|request| request["method"] == "turn/start")
        .collect::<Vec<_>>();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0]["params"]["threadId"], "thread-1");
    assert_eq!(turns[0]["params"]["input"][0]["type"], "text");
    assert_eq!(turns[0]["params"]["input"][0]["text"], "hello");

    let events = events.lock().expect("event log lock");
    for phase in ["boot", "analysis", "responding", "completed"] {
        assert!(
            events.iter().any(|event| event.phase == phase),
            "missing {phase} event"
        );
    }
    let first_stream = events
        .iter()
        .position(|event| event.phase == "responding" && event.delta.as_deref() == Some("Hi "))
        .expect("first streamed response delta");
    let first_completed = events
        .iter()
        .position(|event| event.phase == "completed")
        .expect("first completed turn");
    assert!(first_stream < first_completed);
    assert!(events.iter().any(|event| {
        event.phase == "responding" && event.delta.as_deref() == Some("Hi there!")
    }));
}

#[tokio::test]
async fn times_out_and_interrupts_an_active_turn() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        let factory = fake_factory(
            Arc::clone(&request_log_for_factory),
            false,
            false,
            false,
            false,
        );
        factory(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-timeout".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_millis(30)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });

    let timed_out = agent
        .send(vec![AgentInputPart::text("timeout")], None)
        .await
        .expect_err("turn timeout");
    assert!(matches!(
        timed_out,
        ads_codex_app_server::AgentError::TimedOut { .. }
    ));

    let (abort_tx, abort_rx) = tokio::sync::watch::channel(false);
    let abort_agent = agent.clone();
    let abort_task = tokio::spawn(async move {
        abort_agent
            .send(vec![AgentInputPart::text("abort")], Some(abort_rx))
            .await
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        let turn_started = request_log
            .lock()
            .await
            .iter()
            .filter(|request| request["method"] == "turn/start")
            .count();
        if turn_started >= 2 {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    abort_tx.send(true).expect("send abort");
    let aborted = abort_task
        .await
        .expect("abort task")
        .expect_err("turn abort");
    assert!(matches!(aborted, ads_codex_app_server::AgentError::Aborted));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    while !request_log
        .lock()
        .await
        .iter()
        .any(|request| request["method"] == "turn/interrupt")
    {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::task::yield_now().await;
    }
    registry.stop_all().await;
}

fn custom_error_retry_factory(
    requests: Arc<Mutex<Vec<Value>>>,
    error_payload: Value,
) -> ClientFactory {
    Arc::new(move |_: SpawnOptions| {
        let requests = Arc::clone(&requests);
        let error_payload = error_payload.clone();
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                let turns = AtomicUsize::new(0);
                while let Some(message) = server.read().await {
                    requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "thread": {"id": "thread-classify"},
                                        "sandbox": {"type": "workspaceWrite"},
                                        "approvalPolicy": "untrusted"
                                    }),
                                )
                                .await;
                        }
                        "turn/start" => {
                            let turn = turns.fetch_add(1, Ordering::AcqRel) + 1;
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({
                                        "threadId": "thread-classify",
                                        "turn": {"id": format!("turn-{turn}")}
                                    }),
                                )
                                .await;
                            if turn == 1 {
                                server
                                    .notify(
                                        "error",
                                        json!({
                                            "threadId": "thread-classify",
                                            "turnId": "turn-1",
                                            "willRetry": false,
                                            "error": error_payload
                                        }),
                                    )
                                    .await;
                                continue;
                            }
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-classify",
                                        "turnId": format!("turn-{turn}"),
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "message-ok",
                                            "text": "recovered"
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": "thread-classify",
                                        "turn": {"id": format!("turn-{turn}")}
                                    }),
                                )
                                .await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

#[tokio::test]
async fn does_not_retry_request_token_429_or_authentication_failures_but_retries_structured_429() {
    for (project_id, payload) in [
        (
            "project-trace-429",
            json!({ "message": "upstream failure request_id=trace-429" }),
        ),
        (
            "project-auth-stream-error",
            json!({ "message": "stream error: 401 unauthorized" }),
        ),
        (
            "project-structured-401",
            json!({
                "message": "stream disconnected",
                "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 401 } }
            }),
        ),
        (
            "project-codex-error-info-unauthorized",
            json!({
                "message": "stream disconnected",
                "codexErrorInfo": "unauthorized"
            }),
        ),
        (
            "project-sse-auth-envelope",
            json!({
                "type": "error",
                "error": {
                    "type": "authentication_error",
                    "message": "stream disconnected"
                }
            }),
        ),
    ] {
        let request_log = Arc::new(Mutex::new(Vec::new()));
        let factory = custom_error_retry_factory(Arc::clone(&request_log), payload);
        let registry = CodexAppServerDaemonRegistry::with_factory(move |options| factory(options));
        let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
            project_id: project_id.to_string(),
            workspace_root: std::env::temp_dir(),
            working_directory: None,
            model: None,
            resume_thread_id: None,
            reasoning_effort: "high".to_string(),
            sandbox_mode: SandboxMode::WorkspaceWrite,
            developer_instructions: None,
            dynamic_tools: Vec::new(),
            daemon_options: SpawnOptions::default(),
            registry: Some(Arc::clone(&registry)),
            turn_timeout: Some(std::time::Duration::from_secs(2)),
            auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
            retry: ads_codex_app_server::RetryConfig {
                max_attempts: 2,
                backoff_ms: Some(vec![0]),
            },
        });
        let _ = agent
            .send(vec![AgentInputPart::text("hello")], None)
            .await
            .expect_err("non-transient failure must not retry");
        assert_eq!(
            request_log
                .lock()
                .await
                .iter()
                .filter(|request| request["method"] == "turn/start")
                .count(),
            1,
            "{project_id} should not retry"
        );
        registry.stop_all().await;
    }

    // Structured HTTP 429 payload must still retry and succeed.
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let factory = custom_error_retry_factory(
        Arc::clone(&request_log),
        json!({
            "message": "upstream throttled",
            "codexErrorInfo": { "httpConnectionFailed": { "httpStatusCode": 429 } }
        }),
    );
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| factory(options));
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-structured-429".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig {
            max_attempts: 2,
            backoff_ms: Some(vec![0]),
        },
    });
    let result = agent
        .send(vec![AgentInputPart::text("hello")], None)
        .await
        .expect("structured 429 should retry and succeed");
    assert_eq!(result.response, "recovered");
    assert_eq!(
        request_log
            .lock()
            .await
            .iter()
            .filter(|request| request["method"] == "turn/start")
            .count(),
        2
    );
    registry.stop_all().await;
}

#[tokio::test]
async fn handles_approvals_and_review_action_without_replaying_side_effects() {
    let rework_arguments = json!({
        "rework": {
            "prior_job_id": "reject-job",
            "issue_id": 7,
            "pr_number": 12,
            "base_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "rejected_head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "new_head_sha": "cccccccccccccccccccccccccccccccccccccccc",
            "root_cause": "root cause",
            "invariant": "invariant",
            "audited_scope": ["source"],
            "changed_behavior": "behavior",
            "regression_cases": ["regression"],
            "verification_evidence": ["tests pass"],
            "residual_risks": []
        }
    });
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let response_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let response_log_for_factory = Arc::clone(&response_log);
    let rework_arguments_for_factory = rework_arguments.clone();
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        let factory = approval_factory(
            Arc::clone(&request_log_for_factory),
            Arc::clone(&response_log_for_factory),
            rework_arguments_for_factory.clone(),
        );
        factory(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-approval".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_tool = Arc::clone(&calls);
    let observed_arguments = Arc::new(Mutex::new(None));
    let observed_arguments_for_tool = Arc::clone(&observed_arguments);
    let native_tools = ads_native::ActionTools::new_with_arguments(move |arguments| {
        let calls = Arc::clone(&calls_for_tool);
        let observed_arguments = Arc::clone(&observed_arguments_for_tool);
        async move {
            calls.fetch_add(1, Ordering::AcqRel);
            *observed_arguments.lock().await = Some(arguments);
            Ok::<_, ads_native::NativeError>(json!({
                "ok": true,
                "jobId": "job-1",
                "status": "queued"
            }))
        }
    });
    let actions = AgentActionTools::from_native(native_tools);

    let result = agent
        .send_with_options(
            vec![AgentInputPart::text("review")],
            AgentSendOptions {
                abort: None,
                action_tools: Some(actions),
            },
        )
        .await
        .expect("approval turn");
    assert_eq!(result.response, "approved and queued");
    assert_eq!(calls.load(Ordering::Acquire), 1);
    assert_eq!(
        observed_arguments.lock().await.as_ref(),
        Some(&rework_arguments)
    );

    let responses = response_log.lock().await;
    assert_eq!(responses[0]["result"], json!({"decision": "decline"}));
    assert_eq!(responses[1]["result"], json!({"decision": "decline"}));
    assert_eq!(responses[2]["result"], json!({"decision": "accept"}));
    assert_eq!(responses[3]["result"]["success"], true);
    assert_eq!(
        responses[3]["result"]["contentItems"][0]["text"],
        "review_action completed.\nActions job: job-1.\nStatus: queued."
    );
    assert_eq!(responses[4]["result"], responses[3]["result"]);

    {
        let events = events.lock().expect("event log lock");
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.phase == "command"
                        && event.raw["item"]["aggregated_output"]
                            == "Command blocked by security rule: rm -f state.db"
                })
                .count(),
            1
        );
        assert!(!events.iter().any(|event| {
            event.phase == "command" && event.raw["item"]["command"] == "Please run rm -f state.db"
        }));
        assert!(events.iter().any(|event| {
            event.phase == "error"
                && event.detail.as_deref()
                    == Some("Command blocked by security rule: Please run rm -f state.db")
        }));
    }
    let thread_start = request_log
        .lock()
        .await
        .iter()
        .find(|request| request["method"] == "thread/start")
        .cloned()
        .expect("thread start");
    assert_eq!(
        thread_start["params"]["dynamicTools"][0]["name"],
        "review_action"
    );
    assert_eq!(
        thread_start["params"]["dynamicTools"][0]["inputSchema"]["properties"]["rework"]["properties"]
            ["prior_job_id"]["type"],
        "string"
    );
    registry.stop_all().await;
}

#[tokio::test]
async fn starts_a_tool_enabled_thread_instead_of_resuming_a_legacy_thread() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        let factory = fake_factory(
            Arc::clone(&request_log_for_factory),
            true,
            false,
            false,
            false,
        );
        factory(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-legacy-thread".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: Some("thread-without-tools".to_string()),
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });

    let result = agent
        .send(vec![AgentInputPart::text("tools")], None)
        .await
        .expect("fresh tool thread");
    assert_eq!(result.response, "Hi there!");
    assert_eq!(agent.thread_id().await.as_deref(), Some("thread-1"));
    {
        let requests = request_log.lock().await;
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "thread/resume")
                .count(),
            0
        );
        let thread_start = requests
            .iter()
            .find(|request| request["method"] == "thread/start")
            .expect("fresh thread start");
        assert_eq!(
            thread_start["params"]["dynamicTools"][0]["name"],
            "review_action"
        );
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn recreates_a_thread_when_turn_start_reports_it_missing() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        recover_turn_factory(Arc::clone(&request_log_for_factory))(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-turn-recovery".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    let first = agent
        .send(vec![AgentInputPart::text("seed")], None)
        .await
        .expect("seed turn");
    assert_eq!(first.response, "response-1");
    let second = agent
        .send(vec![AgentInputPart::text("recover")], None)
        .await
        .expect("recovered turn");
    assert_eq!(second.response, "response-3");
    assert_eq!(agent.thread_id().await.as_deref(), Some("thread-new"));

    {
        let requests = request_log.lock().await;
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "thread/start")
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "thread/resume")
                .count(),
            0
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "turn/start")
                .count(),
            3
        );
    }
    {
        let events = events.lock().expect("event log lock");
        assert!(events.iter().any(|event| {
            event.session_fallback.as_ref().is_some_and(|fallback| {
                fallback.reason == "missing_provider_session"
                    && fallback.previous_session_id == "thread-old"
            })
        }));
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn compacts_at_the_configured_context_threshold_before_the_next_turn() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        fake_factory(
            Arc::clone(&request_log_for_factory),
            true,
            true,
            false,
            false,
        )(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-auto-compact".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    let first = agent
        .send(vec![AgentInputPart::text("first")], None)
        .await
        .expect("first turn");
    assert_eq!(first.usage.expect("usage")["input_tokens"], 700);
    let second = agent
        .send(vec![AgentInputPart::text("second")], None)
        .await
        .expect("second turn");
    assert_eq!(second.response, "Second answer");

    {
        let requests = request_log.lock().await;
        let methods = requests
            .iter()
            .filter_map(|request| request["method"].as_str())
            .collect::<Vec<_>>();
        let first_turn = methods
            .iter()
            .position(|method| *method == "turn/start")
            .expect("first user turn");
        let compact = methods
            .iter()
            .position(|method| *method == "thread/compact/start")
            .expect("compact request");
        let second_turn = methods
            .iter()
            .enumerate()
            .filter(|(_, method)| **method == "turn/start")
            .nth(1)
            .map(|(index, _)| index)
            .expect("second user turn");
        assert!(first_turn < compact);
        assert!(compact < second_turn);
    }
    {
        let events = events.lock().expect("event log lock");
        assert!(
            events.iter().any(|event| {
                event.phase == "analysis" && event.title == "自动压缩上下文"
            })
        );
        assert!(
            events
                .iter()
                .any(|event| event.phase == "analysis" && event.title == "上下文压缩完成")
        );
        assert!(
            events
                .iter()
                .any(|event| event.phase == "context" && event.title == "Context ready")
        );
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn recreates_a_thread_when_compaction_reports_it_missing() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        fake_factory(
            Arc::clone(&request_log_for_factory),
            true,
            true,
            true,
            false,
        )(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-compact-missing".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    agent
        .send(vec![AgentInputPart::text("first")], None)
        .await
        .expect("first turn");
    let second = agent
        .send(vec![AgentInputPart::text("second")], None)
        .await
        .expect("recovered after compact failure");
    assert_eq!(second.response, "Second answer");
    assert_eq!(agent.thread_id().await.as_deref(), Some("thread-fresh"));
    {
        let requests = request_log.lock().await;
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "thread/compact/start")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request["method"] == "thread/start")
                .count(),
            2
        );
    }
    {
        let events = events.lock().expect("event log lock");
        assert!(events.iter().any(|event| {
            event.session_fallback.as_ref().is_some_and(|fallback| {
                fallback.reason == "missing_provider_session"
                    && fallback.previous_session_id == "thread-1"
            })
        }));
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn bridges_context_compaction_and_drops_private_or_collaboration_items() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        fake_factory(
            Arc::clone(&request_log_for_factory),
            true,
            false,
            false,
            true,
        )(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-edge-events".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig::default(),
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    agent
        .send(vec![AgentInputPart::text("edge events")], None)
        .await
        .expect("edge event turn");
    {
        let events = events.lock().expect("event log lock");
        assert!(
            events
                .iter()
                .any(|event| event.phase == "context" && event.title == "Loading context")
        );
        assert!(
            events
                .iter()
                .any(|event| event.phase == "context" && event.title == "Context ready")
        );
        assert!(!events.iter().any(|event| {
            let raw = event.raw.to_string();
            event.phase == "plan"
                || raw.contains("Hidden plan")
                || raw.contains("Hidden reasoning")
                || raw.contains("Hidden commentary")
                || raw.contains("collabAgentToolCall")
        }));
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn retries_transient_upstream_errors_with_the_same_input() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        retry_factory(Arc::clone(&request_log_for_factory), false)(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-retry".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig {
            max_attempts: 2,
            backoff_ms: Some(vec![0]),
        },
    });
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let events_for_handler = Arc::clone(&events);
    agent.on_event(move |event| {
        events_for_handler
            .lock()
            .expect("event log lock")
            .push(event);
    });

    let result = agent
        .send(vec![AgentInputPart::text("retry me")], None)
        .await
        .expect("retried turn");
    assert_eq!(result.response, "retry ok");
    {
        let requests = request_log.lock().await;
        let turns = requests
            .iter()
            .filter(|request| request["method"] == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["params"]["input"], turns[1]["params"]["input"]);
    }
    {
        let events = events.lock().expect("event log lock");
        assert!(
            events
                .iter()
                .any(|event| event.phase == "connection" && event.title == "模型请求重试")
        );
    }
    registry.stop_all().await;
}

#[tokio::test]
async fn does_not_retry_after_a_side_effect_item_starts() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_factory = Arc::clone(&request_log);
    let registry = CodexAppServerDaemonRegistry::with_factory(move |options| {
        retry_factory(Arc::clone(&request_log_for_factory), true)(options)
    });
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "project-retry-side-effect".to_string(),
        workspace_root: std::env::temp_dir(),
        working_directory: None,
        model: None,
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: None,
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions::default(),
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(2)),
        auto_compact: ads_codex_app_server::AutoCompactConfig::default(),
        retry: ads_codex_app_server::RetryConfig {
            max_attempts: 2,
            backoff_ms: Some(vec![0]),
        },
    });

    let error = agent
        .send(vec![AgentInputPart::text("do not retry")], None)
        .await
        .expect_err("side effect turn fails");
    assert!(error.to_string().contains("high demand"));
    assert_eq!(
        request_log
            .lock()
            .await
            .iter()
            .filter(|request| request["method"] == "turn/start")
            .count(),
        1
    );
    registry.stop_all().await;
}
