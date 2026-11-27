use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_acp::{
    AcpDriver, AcpError, AcpLaunchContext, AcpPromptRequest, AcpSession, AcpSessionConfig,
    AcpSessionContext, AcpSessionLifecycle, AcpSessionSupervisor, AcpStreamEvent,
    AcpSupervisorConfig, AcpTransportConfig, AutoApprovePermissionHandler, ContentBlock,
    DesiredConfigAlignment, GenericAcpDriver, InteractivePermissionBroker, PermissionDecision,
    SessionAttachMode, SessionMode, StopReason, SupervisedSessionRequest,
};
use ads_runtime::PromptRunContext;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::watch;

fn mock_server_bin() -> &'static str {
    env!("CARGO_BIN_EXE_ads-acp-mock-server")
}

fn build_mock_driver(state_dir: &Path) -> Arc<dyn AcpDriver> {
    Arc::new(
        GenericAcpDriver::new("mock-acp", mock_server_bin())
            .with_env(
                "ADS_MOCK_STATE_DIR",
                state_dir.to_string_lossy().to_string(),
            )
            .with_extra_session_new_param("driverTag", json!("phase1-test"))
            .with_model_alias("beta-alias", "model-beta")
            .with_thought_level_alias("extra-high", "xhigh"),
    )
}

fn read_rpc_log(state_dir: &Path) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(state_dir.join("rpc_log.jsonl")) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).expect("valid rpc log entry"))
        .collect()
}

async fn wait_for_pending_permission(
    broker: &InteractivePermissionBroker,
    timeout: Duration,
) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(req) = broker.pending_requests().into_iter().next() {
            return req.request_id;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for pending permission request"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn end_to_end_initialize_new_prompt_and_ordered_streaming_updates() {
    let temp = TempDir::new().expect("temp dir");
    let driver = build_mock_driver(temp.path());
    let permission = Arc::new(AutoApprovePermissionHandler);
    let session = AcpSession::spawn(
        driver,
        &AcpLaunchContext {
            session_key: "thread-1".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        },
        permission,
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn session");

    let init = session.initialize().await.expect("initialize");
    assert_eq!(init.protocol_version, 1);
    assert!(init.agent_capabilities.supports_load_session());
    assert!(init.agent_capabilities.supports_resume());
    assert!(init.agent_capabilities.prompt_capabilities.embedded_context);
    assert_eq!(session.lifecycle(), AcpSessionLifecycle::Initialized);

    let new_resp = session
        .new_session(&AcpSessionContext {
            session_key: "thread-1".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        })
        .await
        .expect("session/new");
    assert_eq!(new_resp.session_id, "sess-1");
    assert_eq!(session.lifecycle(), AcpSessionLifecycle::Ready);
    assert_eq!(
        session.config_option_by_category("model").unwrap().id,
        "opt_model"
    );
    assert_eq!(
        session
            .config_option_by_category("thought_level")
            .unwrap()
            .id,
        "opt_thought"
    );

    let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
    let emitted_handle = Arc::clone(&emitted);
    let context = PromptRunContext::new(Arc::new(move |frame| {
        emitted_handle.lock().expect("emitted lock").push(frame);
    }));

    let result = session
        .prompt(
            AcpPromptRequest::with_blocks(
                "msg-1",
                vec![
                    ContentBlock::text("full_stream"),
                    ContentBlock::text_resource(
                        "file:///workspace/README.md",
                        Some("text/markdown".to_string()),
                        "# Hello",
                    ),
                ],
            )
            .with_context(context),
        )
        .await
        .expect("session/prompt");

    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert_eq!(
        result.response_text,
        "Intro Done(resources=file:///workspace/README.md,tag=phase1-test)"
    );
    assert_eq!(result.thought_text, "Thinking step 1. Thinking step 2.");
    assert_eq!(result.available_commands.len(), 2);
    assert_eq!(result.available_commands[0].name, "plan");
    assert_eq!(result.usage.as_ref().and_then(|u| u.used), Some(1024));
    assert_eq!(session.lifecycle(), AcpSessionLifecycle::Ready);

    // Verify strict ordered event sequence without drops or duplicates.
    let event_tags: Vec<&str> = result
        .events
        .iter()
        .map(|event| match event {
            AcpStreamEvent::AvailableCommands { .. } => "available_commands",
            AcpStreamEvent::ConfigOptionsUpdated { .. } => "config_options",
            AcpStreamEvent::ThoughtDelta { .. } => "thought",
            AcpStreamEvent::Plan { .. } => "plan",
            AcpStreamEvent::MessageDelta { .. } => "delta",
            AcpStreamEvent::ToolCall {
                is_update: false, ..
            } => "tool_call",
            AcpStreamEvent::ToolCall {
                is_update: true, ..
            } => "tool_call_update",
            AcpStreamEvent::UsageUpdated { .. } => "usage",
            AcpStreamEvent::CompactionUpdated { .. } => "compaction",
            AcpStreamEvent::ModeChanged { .. } => "mode",
            AcpStreamEvent::RawUpdate { .. } => "raw",
        })
        .collect();
    assert_eq!(
        event_tags,
        vec![
            "available_commands",
            "config_options",
            "thought",
            "thought",
            "plan",
            "delta",
            "tool_call",
            "tool_call_update",
            "tool_call_update",
            "delta",
            "usage",
            "compaction",
        ]
    );

    // Verify ADS streaming frames preserve order and rotate assistantItemId across tool calls.
    let frames = emitted.lock().expect("emitted lock").clone();
    let deltas: Vec<&Value> = frames.iter().filter(|f| f["type"] == "delta").collect();
    assert_eq!(deltas.len(), 2);
    assert_eq!(deltas[0]["delta"], "Intro ");
    assert_eq!(deltas[0]["assistantItemId"], "msg-1-assistant-1");
    assert_eq!(
        deltas[1]["delta"],
        "Done(resources=file:///workspace/README.md,tag=phase1-test)"
    );
    assert_eq!(deltas[1]["assistantItemId"], "msg-1-assistant-2");

    let commands: Vec<&Value> = frames.iter().filter(|f| f["type"] == "command").collect();
    assert_eq!(commands.len(), 3);
    assert_eq!(commands[0]["command"]["status"], "pending");
    assert_eq!(commands[1]["command"]["status"], "in_progress");
    assert_eq!(commands[1]["command"]["command"], "Read README.md");
    assert_eq!(commands[2]["command"]["status"], "completed");
    assert_eq!(commands[2]["command"]["rawOutput"]["bytes"], 128);

    session.shutdown().await;
}

#[tokio::test]
async fn config_option_alignment_is_idempotent_and_applies_model_before_thought_level() {
    let temp = TempDir::new().expect("temp dir");
    let driver = build_mock_driver(temp.path());
    let session = AcpSession::spawn(
        driver,
        &AcpLaunchContext {
            session_key: "thread-config".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        },
        Arc::new(AutoApprovePermissionHandler),
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn session");

    session.initialize().await.expect("initialize");
    session
        .new_session(&AcpSessionContext {
            session_key: "thread-config".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        })
        .await
        .expect("new_session");

    // `xhigh` (mapped from `extra-high`) is rejected by the mock server unless `model-beta`
    // (mapped from `beta-alias`) is applied strictly FIRST.
    let desired = DesiredConfigAlignment {
        mode: Some(SessionMode::Plan),
        model: Some("beta-alias".to_string()),
        thought_level: Some("extra-high".to_string()),
        extra_options: Vec::new(),
    };

    let turn1 = session
        .prompt(AcpPromptRequest::text("m1", "echo_session").with_alignment(desired.clone()))
        .await
        .expect("turn 1");
    assert!(turn1.alignment.mode_changed);
    assert_eq!(
        turn1.alignment.applied_config_ids,
        vec!["opt_model".to_string(), "opt_thought".to_string()]
    );
    assert!(turn1.alignment.skipped_config_ids.is_empty());
    assert_eq!(
        turn1.response_text,
        "turn=1 model=model-beta thought=xhigh mode=plan tag=phase1-test"
    );

    let rpc_log_after_turn1 = read_rpc_log(temp.path());
    let config_calls_1: Vec<(&str, &str)> = rpc_log_after_turn1
        .iter()
        .filter(|entry| entry["method"] == "session/set_config_option")
        .map(|entry| {
            (
                entry["params"]["configId"].as_str().unwrap(),
                entry["params"]["value"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        config_calls_1,
        vec![("opt_model", "model-beta"), ("opt_thought", "xhigh")]
    );

    // Second turn with identical alignment MUST be idempotent (0 set_mode / set_config_option RPCs).
    let turn2 = session
        .prompt(AcpPromptRequest::text("m2", "echo_session").with_alignment(desired))
        .await
        .expect("turn 2");
    assert!(!turn2.alignment.mode_changed);
    assert!(turn2.alignment.applied_config_ids.is_empty());
    assert_eq!(
        turn2.alignment.skipped_config_ids,
        vec!["opt_model".to_string(), "opt_thought".to_string()]
    );

    let rpc_log_after_turn2 = read_rpc_log(temp.path());
    let set_config_count = rpc_log_after_turn2
        .iter()
        .filter(|entry| entry["method"] == "session/set_config_option")
        .count();
    let set_mode_count = rpc_log_after_turn2
        .iter()
        .filter(|entry| entry["method"] == "session/set_mode")
        .count();
    assert_eq!(
        set_config_count, 2,
        "expected no redundant set_config_option RPCs"
    );
    assert_eq!(set_mode_count, 1, "expected no redundant set_mode RPCs");

    session.shutdown().await;
}

#[tokio::test]
async fn permission_requests_suspend_until_allow_deny_and_cleanup_on_cancel_or_crash() {
    let temp = TempDir::new().expect("temp dir");
    let driver = build_mock_driver(temp.path());
    let perm_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let perm_events_handle = Arc::clone(&perm_events);
    let broker = InteractivePermissionBroker::with_emitter(Arc::new(move |frame| {
        perm_events_handle.lock().expect("perm events").push(frame);
    }));

    let session = AcpSession::spawn(
        Arc::clone(&driver),
        &AcpLaunchContext {
            session_key: "thread-perm".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        },
        broker.clone(),
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn session");
    session.initialize().await.expect("initialize");
    session
        .new_session(&AcpSessionContext {
            session_key: "thread-perm".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        })
        .await
        .expect("new_session");

    // 1) Allow path
    let allow_session = Arc::clone(&session);
    let allow_task = tokio::spawn(async move {
        allow_session
            .prompt(AcpPromptRequest::text("p1", "need_permission"))
            .await
    });
    let req_id = wait_for_pending_permission(&broker, Duration::from_secs(3)).await;
    assert_eq!(broker.pending_count(), 1);
    assert!(broker.respond(&req_id, PermissionDecision::AllowOnce));
    let allow_result = allow_task.await.expect("join").expect("allow turn");
    assert_eq!(allow_result.response_text, "ALLOWED:opt-allow-once");
    assert_eq!(broker.pending_count(), 0);

    // 2) Deny path
    let deny_session = Arc::clone(&session);
    let deny_task = tokio::spawn(async move {
        deny_session
            .prompt(AcpPromptRequest::text("p2", "need_permission"))
            .await
    });
    let req_id = wait_for_pending_permission(&broker, Duration::from_secs(3)).await;
    assert!(broker.respond(&req_id, PermissionDecision::DenyOnce));
    let deny_result = deny_task.await.expect("join").expect("deny turn");
    assert_eq!(deny_result.response_text, "DENIED:opt-reject-once");
    assert_eq!(broker.pending_count(), 0);

    // 3) Turn cancellation cleans up pending permission automatically
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let cancel_session = Arc::clone(&session);
    let cancel_task = tokio::spawn(async move {
        cancel_session
            .prompt(AcpPromptRequest::text("p3", "need_permission").with_cancel(cancel_rx))
            .await
    });
    let _req_id = wait_for_pending_permission(&broker, Duration::from_secs(3)).await;
    assert_eq!(broker.pending_count(), 1);
    cancel_tx.send(true).expect("send cancel");
    let cancel_result = cancel_task.await.expect("join").expect("cancelled turn");
    assert_eq!(cancel_result.stop_reason, StopReason::Cancelled);
    assert_eq!(cancel_result.response_text, "PERM_CANCELLED");
    assert_eq!(broker.pending_count(), 0);
    assert_eq!(session.lifecycle(), AcpSessionLifecycle::Ready);

    // 4) Subprocess exit while permission is pending cleans up without hanging
    let crash_result = session
        .prompt(AcpPromptRequest::text("p4", "need_permission_then_crash"))
        .await;
    assert!(matches!(
        crash_result,
        Err(AcpError::Closed {
            exit_code: Some(99),
            graceful: false,
            ..
        })
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(broker.pending_count(), 0);

    let recorded = perm_events.lock().expect("perm events");
    let resolved_cancelled = recorded
        .iter()
        .filter(|e| e["type"] == "permission_resolved" && e["status"] == "cancelled")
        .count();
    assert!(
        resolved_cancelled >= 2,
        "expected cancelled permission_resolved events for cancel and crash"
    );
}

#[tokio::test]
async fn cancel_drains_trailing_updates_and_returns_session_to_idle() {
    let temp = TempDir::new().expect("temp dir");
    let driver = build_mock_driver(temp.path());
    let session = AcpSession::spawn(
        driver,
        &AcpLaunchContext {
            session_key: "thread-cancel".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        },
        Arc::new(AutoApprovePermissionHandler),
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn session");
    session.initialize().await.expect("initialize");
    session
        .new_session(&AcpSessionContext {
            session_key: "thread-cancel".to_string(),
            workspace_root: temp.path().to_path_buf(),
            ..Default::default()
        })
        .await
        .expect("new_session");

    let (first_chunk_tx, first_chunk_rx) = tokio::sync::oneshot::channel::<()>();
    let first_chunk_tx = Arc::new(Mutex::new(Some(first_chunk_tx)));
    let context = PromptRunContext::new(Arc::new(move |frame| {
        if frame["type"] == "delta"
            && frame["delta"] == "part-1 "
            && let Some(tx) = first_chunk_tx.lock().expect("tx").take()
        {
            let _ = tx.send(());
        }
    }));
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let session_for_turn = Arc::clone(&session);
    let turn_task = tokio::spawn(async move {
        session_for_turn
            .prompt(
                AcpPromptRequest::text("c1", "cancel_with_trailing")
                    .with_context(context)
                    .with_cancel(cancel_rx),
            )
            .await
    });

    tokio::time::timeout(Duration::from_secs(3), first_chunk_rx)
        .await
        .expect("first chunk arrived")
        .expect("channel ok");
    cancel_tx.send(true).expect("trigger cancel");

    let cancelled = turn_task.await.expect("join").expect("cancel result");
    assert_eq!(cancelled.stop_reason, StopReason::Cancelled);
    assert_eq!(cancelled.response_text, "part-1 trailing-1 trailing-2");
    assert_eq!(session.lifecycle(), AcpSessionLifecycle::Ready);

    // Session is back to idle and handles subsequent turns cleanly.
    let followup = session
        .prompt(AcpPromptRequest::text("c2", "echo_session"))
        .await
        .expect("followup turn after cancel");
    assert_eq!(followup.stop_reason, StopReason::EndTurn);
    assert!(followup.response_text.contains("turn=1"));

    session.shutdown().await;
}

#[tokio::test]
async fn supervisor_isolates_sessions_reclaims_idle_gracefully_and_resumes_on_next_turn() {
    let temp = TempDir::new().expect("temp dir");
    let driver = build_mock_driver(temp.path());
    let supervisor = AcpSessionSupervisor::new(
        driver,
        Arc::new(AutoApprovePermissionHandler),
        AcpSupervisorConfig {
            idle_ttl: Duration::from_millis(250),
            reap_interval: Duration::from_millis(30),
            session: AcpSessionConfig::default(),
            fallback_to_new_on_resume_error: true,
        },
    );

    let req_a = SupervisedSessionRequest::new("thread-a", temp.path());
    let req_b = SupervisedSessionRequest::new("thread-b", temp.path());

    let turn_a1 = supervisor
        .run_turn(req_a.clone(), AcpPromptRequest::text("a1", "echo_session"))
        .await
        .expect("turn a1");
    let pid_a1 = supervisor.active_pid("thread-a").expect("pid a1");
    let turn_b1 = supervisor
        .run_turn(req_b.clone(), AcpPromptRequest::text("b1", "echo_session"))
        .await
        .expect("turn b1");

    assert_eq!(turn_a1.attach_mode, SessionAttachMode::CreatedNew);
    assert_eq!(turn_b1.attach_mode, SessionAttachMode::CreatedNew);
    assert_eq!(supervisor.active_process_count(), 2);

    let pid_b1 = supervisor.active_pid("thread-b").expect("pid b1");
    assert_ne!(pid_a1, pid_b1, "sessions must run in isolated subprocesses");

    let saved_id_a = supervisor
        .known_session_id("thread-a")
        .expect("saved session id");
    assert_eq!(saved_id_a, turn_a1.turn.session_id);

    // Wait for background idle TTL reaper to reclaim idle processes gracefully.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while supervisor.active_process_count() > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for idle TTL reclamation"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Verify graceful stdin-EOF shutdown marker was flushed by both subprocesses.
    let markers =
        fs::read_to_string(temp.path().join("shutdown_marker.txt")).expect("shutdown marker");
    let eof_count = markers
        .lines()
        .filter(|line| line.trim() == "graceful_eof")
        .count();
    assert_eq!(
        eof_count, 2,
        "expected graceful stdin-EOF shutdown for both idle sessions"
    );

    // Next turn on thread-a spawns a fresh subprocess and re-attaches via `session/resume`.
    let turn_a2 = supervisor
        .run_turn(req_a.clone(), AcpPromptRequest::text("a2", "echo_session"))
        .await
        .expect("turn a2");
    assert_eq!(turn_a2.attach_mode, SessionAttachMode::Resumed);
    assert_eq!(turn_a2.turn.session_id, saved_id_a);
    assert!(
        turn_a2.turn.response_text.contains("turn=2"),
        "expected resumed turn count=2, got {}",
        turn_a2.turn.response_text
    );
    let pid_a2 = supervisor.active_pid("thread-a").expect("pid a2");
    assert_ne!(pid_a2, pid_a1);

    // Verify `session/load` replays prior history when explicitly requested.
    supervisor.shutdown_session("thread-a").await;
    let turn_a3 = supervisor
        .run_turn(
            req_a.with_prefer_load(true),
            AcpPromptRequest::text("a3", "echo_session"),
        )
        .await
        .expect("turn a3 via load");
    assert_eq!(turn_a3.attach_mode, SessionAttachMode::Loaded);
    assert!(
        turn_a3.replayed_events.len() >= 2,
        "expected replayed assistant chunks from session/load"
    );
    assert!(turn_a3.turn.response_text.contains("turn=3"));

    supervisor.shutdown_all().await;
    assert_eq!(supervisor.active_process_count(), 0);
}

#[tokio::test]
async fn failure_modes_crash_malformed_frame_timeout_auth_and_process_group_cleanup() {
    // 1) Subprocess crash mid-turn
    {
        let temp = TempDir::new().expect("temp dir");
        let session = AcpSession::spawn(
            build_mock_driver(temp.path()),
            &AcpLaunchContext {
                session_key: "crash".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            AcpSessionConfig::default(),
        )
        .await
        .expect("spawn");
        session.initialize().await.expect("init");
        session
            .new_session(&AcpSessionContext {
                session_key: "crash".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            })
            .await
            .expect("new");
        let err = session
            .prompt(AcpPromptRequest::text("m1", "crash_mid_turn"))
            .await
            .expect_err("expected crash error");
        match err {
            AcpError::Closed {
                exit_code,
                graceful,
                stderr_tail,
            } => {
                assert_eq!(exit_code, Some(42));
                assert!(!graceful);
                assert!(
                    stderr_tail
                        .as_deref()
                        .is_some_and(|s| s.contains("simulated fatal crash"))
                );
            }
            other => panic!("expected AcpError::Closed, got {other:?}"),
        }
    }

    // 2) Malformed JSON-RPC frame surfaces structured error without hanging
    {
        let temp = TempDir::new().expect("temp dir");
        let session = AcpSession::spawn(
            build_mock_driver(temp.path()),
            &AcpLaunchContext {
                session_key: "malformed".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            AcpSessionConfig::default(),
        )
        .await
        .expect("spawn");
        session.initialize().await.expect("init");
        session
            .new_session(&AcpSessionContext {
                session_key: "malformed".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            })
            .await
            .expect("new");
        let err = session
            .prompt(AcpPromptRequest::text("m1", "malformed_frame"))
            .await
            .expect_err("expected malformed frame error");
        assert!(
            err.is_malformed_frame(),
            "expected MalformedFrame, got {err:?}"
        );
        assert!(session.is_closed());
    }

    // 3) RPC timeout surfaces structured error without hanging
    {
        let temp = TempDir::new().expect("temp dir");
        let config = AcpSessionConfig {
            prompt_timeout: Duration::from_millis(120),
            ..Default::default()
        };
        let session = AcpSession::spawn(
            build_mock_driver(temp.path()),
            &AcpLaunchContext {
                session_key: "timeout".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            config,
        )
        .await
        .expect("spawn");
        session.initialize().await.expect("init");
        session
            .new_session(&AcpSessionContext {
                session_key: "timeout".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            })
            .await
            .expect("new");
        let err = session
            .prompt(AcpPromptRequest::text("m1", "hang_timeout"))
            .await
            .expect_err("expected timeout error");
        assert!(err.is_timeout(), "expected Timeout, got {err:?}");
        assert!(
            session.is_closed(),
            "timed-out prompt must close transport so desynchronized process is never reused"
        );
    }

    // 3b) Dropping AcpSession without explicit shutdown() still terminates subprocess cleanly
    #[cfg(unix)]
    {
        let temp = TempDir::new().expect("temp dir");
        let session = AcpSession::spawn(
            build_mock_driver(temp.path()),
            &AcpLaunchContext {
                session_key: "drop-cleanup".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            AcpSessionConfig::default(),
        )
        .await
        .expect("spawn");
        session.initialize().await.expect("init");
        let pid = session.transport().pid().expect("pid") as i32;
        drop(session);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "subprocess leaked when AcpSession was dropped without explicit shutdown()"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    // 4) Driver RPC error mapping (-32000 -> AuthenticationRequired)
    {
        let temp = TempDir::new().expect("temp dir");
        let driver = Arc::new(
            GenericAcpDriver::new("mock-auth", mock_server_bin())
                .with_env(
                    "ADS_MOCK_STATE_DIR",
                    temp.path().to_string_lossy().to_string(),
                )
                .with_env("ADS_MOCK_REQUIRE_AUTH", "1"),
        );
        let session = AcpSession::spawn(
            driver,
            &AcpLaunchContext {
                session_key: "auth".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            AcpSessionConfig::default(),
        )
        .await
        .expect("spawn");
        let err = session
            .initialize()
            .await
            .expect_err("expected auth required error");
        assert!(
            err.is_auth_required(),
            "expected AuthenticationRequired, got {err:?}"
        );
        session.shutdown().await;
    }

    // 5) Stubborn process + grandchild process-group cleanup leaves no leaked child processes
    #[cfg(unix)]
    {
        let temp = TempDir::new().expect("temp dir");
        let driver = Arc::new(
            GenericAcpDriver::new("mock-stubborn", mock_server_bin())
                .with_env(
                    "ADS_MOCK_STATE_DIR",
                    temp.path().to_string_lossy().to_string(),
                )
                .with_env("ADS_MOCK_IGNORE_STDIN_EOF", "1")
                .with_env("ADS_MOCK_IGNORE_SIGTERM", "1")
                .with_env("ADS_MOCK_SPAWN_GRANDCHILD", "1"),
        );
        let config = AcpSessionConfig {
            transport: AcpTransportConfig {
                rpc_timeout: Duration::from_secs(5),
                graceful_exit_timeout: Duration::from_millis(80),
                term_exit_timeout: Duration::from_millis(80),
            },
            ..Default::default()
        };
        let session = AcpSession::spawn(
            driver,
            &AcpLaunchContext {
                session_key: "stubborn".to_string(),
                workspace_root: temp.path().to_path_buf(),
                ..Default::default()
            },
            Arc::new(AutoApprovePermissionHandler),
            config,
        )
        .await
        .expect("spawn");
        session.initialize().await.expect("init");
        let leader_pid = session.transport().pid().expect("leader pid") as i32;
        let grandchild_pid: i32 = fs::read_to_string(temp.path().join("grandchild_pid.txt"))
            .expect("grandchild pid file")
            .trim()
            .parse()
            .expect("valid grandchild pid");

        session.shutdown().await;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let leader_dead = unsafe { libc::kill(leader_pid, 0) } != 0;
            let grandchild_dead = unsafe { libc::kill(grandchild_pid, 0) } != 0;
            if leader_dead && grandchild_dead {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "leaked process after shutdown: leader_dead={leader_dead}, grandchild_dead={grandchild_dead}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
