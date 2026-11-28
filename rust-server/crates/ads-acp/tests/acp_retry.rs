use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ads_acp::{
    AcpDriver, AcpPromptRunner, AcpPromptRunnerConfig, AcpReviewRequest, AcpSupervisorConfig,
    GenericAcpDriver, run_acp_review_with_retry,
};
use ads_native::{Cancellation, DEFAULT_RETRY_COUNT};
use ads_reviewer::{
    ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewVerdictStatus, ReviewVerificationReport,
    ReviewerError,
};
use ads_runtime::{LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueRunner, PromptRunContext};
use ads_state::{StateDb, WEB_ACOPILOT_NAMESPACE};
use serde_json::{Map, Value, json};

fn write_retry_mock_acp_script(dir: &Path) -> PathBuf {
    let script_path = dir.join("mock-retry-acp.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys

counter_path = os.environ["MOCK_COUNTER_FILE"]
mode = os.environ.get("MOCK_MODE", "ok")
fail_times = int(os.environ.get("MOCK_FAIL_TIMES", "0"))

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def bump_attempt():
    count = 0
    if os.path.exists(counter_path):
        with open(counter_path, "r") as f:
            raw = f.read().strip()
            if raw:
                count = int(raw)
    count += 1
    with open(counter_path, "w") as f:
        f.write(str(count))
    return count

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
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": False, "sessionCapabilities": {}},
                "agentInfo": {"name": "mock-retry-acp", "version": "1.0.0"},
                "authMethods": [],
            },
        })
    elif method == "session/new":
        session_num += 1
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": f"sess-{session_num}",
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}]},
                "configOptions": [],
            },
        })
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": req_id, "result": {"modes": {"currentModeId": params.get("modeId", "default"), "availableModes": []}}})
    elif method == "session/prompt":
        session_id = params.get("sessionId", "sess-1")
        attempt = bump_attempt()

        if mode == "transient_rpc" and attempt <= fail_times:
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "HTTP 503 Service Unavailable"},
            })
            continue

        if mode == "crash_before_output" and attempt <= fail_times:
            sys.exit(42)

        if mode == "delta_then_transient" and attempt <= fail_times:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "partial-output "},
                    },
                },
            })
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "HTTP 503 Service Unavailable"},
            })
            continue

        if mode == "tool_then_crash" and attempt <= fail_times:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tc-1",
                        "title": "Edit file",
                        "kind": "edit",
                        "status": "in_progress",
                    },
                },
            })
            sys.exit(42)

        if mode == "permanent_invalid_params":
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32602, "message": "Invalid params"},
            })
            continue

        if mode == "review_transient_rpc":
            if attempt <= fail_times:
                send({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32000, "message": "HTTP 502 Bad Gateway"},
                })
                continue
            reply = json.dumps({"status": "PASS", "summary": f"passed on attempt {attempt}", "defects": []})
        elif mode == "review_delta_then_transient":
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "{"},
                    },
                },
            })
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "HTTP 503 Service Unavailable"},
            })
            continue
        else:
            reply = f"ok-attempt-{attempt}"

        send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": reply},
                },
            },
        })
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"stopReason": "end_turn"},
        })
    elif req_id is not None:
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        })
"#;
    fs::write(&script_path, script).expect("write mock retry script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }
    script_path
}

fn read_attempts(counter_path: &Path) -> usize {
    fs::read_to_string(counter_path)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

fn make_driver(
    script: &Path,
    counter_path: &Path,
    mode: &str,
    fail_times: usize,
) -> Arc<dyn AcpDriver> {
    Arc::new(
        GenericAcpDriver::new("mock-retry", script.to_string_lossy().as_ref())
            .with_env(
                "MOCK_COUNTER_FILE",
                counter_path.to_string_lossy().into_owned(),
            )
            .with_env("MOCK_MODE", mode)
            .with_env("MOCK_FAIL_TIMES", fail_times.to_string()),
    )
}

fn make_turn(workspace: &Path, client_message_id: &str, text: &str) -> LaneTurn {
    let mut payload = Map::new();
    payload.insert("text".to_string(), Value::String(text.to_string()));
    LaneTurn {
        key: LaneTurnKey::PromptQueue(1),
        kind: LaneTurnKind::UserPrompt,
        client_message_id: client_message_id.to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "sess-ui".to_string(),
        chat_session_id: "chat-1".to_string(),
        history_key: "hist-1".to_string(),
        logical_history_key: "hist-1".to_string(),
        lane_namespace: WEB_ACOPILOT_NAMESPACE.to_string(),
        lane_generation: 1,
        workspace_root: workspace.to_string_lossy().into_owned(),
        payload,
        history_display_text: None,
        created_at: 1_000,
    }
}

#[tokio::test]
async fn acp_prompt_runner_retries_three_transient_rpc_failures_and_succeeds() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let script = write_retry_mock_acp_script(temp.path());
    let counter = temp.path().join("attempts.txt");
    let driver = make_driver(&script, &counter, "transient_rpc", 3);
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let runner = AcpPromptRunner::new(
        db,
        AcpPromptRunnerConfig::new(driver)
            .with_upstream_retry_count(DEFAULT_RETRY_COUNT)
            .with_retry_backoff_ms(Some(vec![0]))
            .with_supervisor_config(AcpSupervisorConfig::default()),
    );

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_sink = Arc::clone(&events);
    let context = PromptRunContext::new(Arc::new(move |event| {
        events_sink.lock().expect("events").push(event);
    }));

    let outcome = runner
        .run_lane_turn(make_turn(&workspace, "cm-retry-3", "hello"), context)
        .await
        .expect("run_lane_turn");
    runner.shutdown().await;

    assert!(outcome.ok, "expected success on 4th attempt: {outcome:?}");
    assert_eq!(read_attempts(&counter), 4);

    let recorded = events.lock().expect("events");
    let retry_events: Vec<&Value> = recorded
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("retry"))
        .collect();
    assert_eq!(retry_events.len(), 3);
    assert_eq!(retry_events[0].get("retryCount"), Some(&json!(1)));
    assert_eq!(retry_events[1].get("retryCount"), Some(&json!(2)));
    assert_eq!(retry_events[2].get("retryCount"), Some(&json!(3)));
    assert_eq!(retry_events[2].get("maxAttempts"), Some(&json!(4)));

    let result = recorded
        .iter()
        .find(|e| e.get("type").and_then(Value::as_str) == Some("result"))
        .expect("result event");
    assert_eq!(result.get("output"), Some(&json!("ok-attempt-4")));
}

#[tokio::test]
async fn acp_prompt_runner_retries_after_unexpected_subprocess_crash_before_output() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let script = write_retry_mock_acp_script(temp.path());
    let counter = temp.path().join("attempts.txt");
    let driver = make_driver(&script, &counter, "crash_before_output", 1);
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let runner = AcpPromptRunner::new(
        db,
        AcpPromptRunnerConfig::new(driver)
            .with_upstream_retry_count(3)
            .with_retry_backoff_ms(Some(vec![0])),
    );

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_sink = Arc::clone(&events);
    let context = PromptRunContext::new(Arc::new(move |event| {
        events_sink.lock().expect("events").push(event);
    }));

    let outcome = runner
        .run_lane_turn(make_turn(&workspace, "cm-crash", "hello"), context)
        .await
        .expect("run_lane_turn");
    runner.shutdown().await;

    assert!(outcome.ok, "expected recovery after pre-output crash");
    assert_eq!(read_attempts(&counter), 2);
    let retries = events
        .lock()
        .expect("events")
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("retry"))
        .count();
    assert_eq!(retries, 1);
}

#[tokio::test]
async fn acp_prompt_runner_does_not_retry_after_partial_delta_or_tool_call() {
    for mode in ["delta_then_transient", "tool_then_crash"] {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("ws");
        fs::create_dir_all(&workspace).expect("ws");
        let script = write_retry_mock_acp_script(temp.path());
        let counter = temp.path().join("attempts.txt");
        let driver = make_driver(&script, &counter, mode, 3);
        let db = StateDb::open(temp.path().join("state.db")).expect("db");

        let runner = AcpPromptRunner::new(
            db,
            AcpPromptRunnerConfig::new(driver)
                .with_upstream_retry_count(3)
                .with_retry_backoff_ms(Some(vec![0])),
        );

        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let events_sink = Arc::clone(&events);
        let context = PromptRunContext::new(Arc::new(move |event| {
            events_sink.lock().expect("events").push(event);
        }));

        let outcome = runner
            .run_lane_turn(make_turn(&workspace, "cm-fenced", "hello"), context)
            .await
            .expect("run_lane_turn");
        runner.shutdown().await;

        assert!(!outcome.ok, "mode {mode} must fail without retrying");
        assert_eq!(
            read_attempts(&counter),
            1,
            "mode {mode} must not retry after output or tool side effect"
        );
        let retries = events
            .lock()
            .expect("events")
            .iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("retry"))
            .count();
        assert_eq!(retries, 0, "mode {mode} must emit zero retry events");
    }
}

#[tokio::test]
async fn acp_prompt_runner_does_not_retry_permanent_rpc_errors() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let script = write_retry_mock_acp_script(temp.path());
    let counter = temp.path().join("attempts.txt");
    let driver = make_driver(&script, &counter, "permanent_invalid_params", 3);
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let runner = AcpPromptRunner::new(
        db,
        AcpPromptRunnerConfig::new(driver)
            .with_upstream_retry_count(3)
            .with_retry_backoff_ms(Some(vec![0])),
    );

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_sink = Arc::clone(&events);
    let context = PromptRunContext::new(Arc::new(move |event| {
        events_sink.lock().expect("events").push(event);
    }));

    let outcome = runner
        .run_lane_turn(make_turn(&workspace, "cm-perm", "hello"), context)
        .await
        .expect("run_lane_turn");
    runner.shutdown().await;

    assert!(!outcome.ok);
    assert_eq!(read_attempts(&counter), 1);
    let recorded = events.lock().expect("events");
    assert!(
        !recorded
            .iter()
            .any(|e| e.get("type").and_then(Value::as_str) == Some("retry"))
    );
    let error_event = recorded
        .iter()
        .find(|e| e.get("type").and_then(Value::as_str) == Some("error"))
        .expect("error event");
    assert_eq!(
        error_event
            .get("errorInfo")
            .and_then(|info| info.get("retryable")),
        Some(&json!(false))
    );
}

#[tokio::test]
async fn acp_prompt_runner_cancels_immediately_during_retry_backoff() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let script = write_retry_mock_acp_script(temp.path());
    let counter = temp.path().join("attempts.txt");
    let driver = make_driver(&script, &counter, "transient_rpc", 3);
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let runner = Arc::new(AcpPromptRunner::new(
        db,
        AcpPromptRunnerConfig::new(driver)
            .with_upstream_retry_count(3)
            .with_retry_backoff_ms(Some(vec![30_000])),
    ));

    let turn = make_turn(&workspace, "cm-cancel-backoff", "hello");
    let turn_for_abort = turn.clone();
    let runner_for_abort = Arc::clone(&runner);
    let cancelled_at = Arc::new(Mutex::new(None::<Instant>));
    let cancelled_at_sink = Arc::clone(&cancelled_at);
    let context = PromptRunContext::new(Arc::new(move |event| {
        if event.get("type").and_then(Value::as_str) == Some("retry") {
            *cancelled_at_sink.lock().expect("cancelled_at") = Some(Instant::now());
            runner_for_abort.abort_lane_turn(&turn_for_abort);
        }
    }));

    let outcome = runner
        .run_lane_turn(turn, context)
        .await
        .expect("run_lane_turn");
    let cancel_elapsed = cancelled_at
        .lock()
        .expect("cancelled_at")
        .expect("retry event should have fired")
        .elapsed();
    runner.shutdown().await;

    assert!(!outcome.ok);
    assert!(
        cancel_elapsed < Duration::from_secs(5),
        "cancellation during 30s backoff should return promptly, took {cancel_elapsed:?}"
    );
    assert_eq!(read_attempts(&counter), 1);
}

#[tokio::test]
async fn acp_reviewer_retries_transient_failure_and_respects_output_fence() {
    let temp = tempfile::tempdir().expect("tempdir");
    let repo_path = temp.path().join("repo");
    fs::create_dir_all(&repo_path).expect("repo");
    let script = write_retry_mock_acp_script(temp.path());
    let db = StateDb::open(temp.path().join("state.db")).expect("db");
    {
        let conn = db.connect().expect("conn");
        conn.execute(
            "UPDATE role_profiles SET model_id = ?1 WHERE id = 'profile-default-reviewer'",
            rusqlite::params!["codex:gpt-5.3-codex"],
        )
        .expect("configure reviewer profile");
    }

    let payload = ReviewPayload {
        issue: ReviewIssue {
            id: Some(755),
            title: "Unified retry".to_string(),
            ..Default::default()
        },
        diff_range: Some(ReviewDiffRange {
            base_ref: "dev".to_string(),
            head_ref: "HEAD".to_string(),
            base_commit: Some("0000000".to_string()),
            head_commit: Some("1111111".to_string()),
            range: "dev..HEAD".to_string(),
        }),
        diff: "+fn ok() {}".to_string(),
        ..Default::default()
    };

    // 1. Fails twice with transient HTTP 502 before output, succeeds on attempt 3.
    let counter_ok = temp.path().join("review_attempts_ok.txt");
    let driver_ok = make_driver(&script, &counter_ok, "review_transient_rpc", 2);
    let verdict = run_acp_review_with_retry(
        AcpReviewRequest {
            db: db.clone(),
            driver: driver_ok,
            payload: payload.clone(),
            repo_path: repo_path.clone(),
            profile_id: None,
            job_id: "job-755-ok".to_string(),
            timeout: Duration::from_secs(30),
            cancellation: Cancellation::new(),
            verification_report: Arc::new(Mutex::new(ReviewVerificationReport::default())),
        },
        3,
        Some(&[0]),
    )
    .await
    .expect("review should recover on attempt 3");
    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    assert_eq!(read_attempts(&counter_ok), 3);

    // 2. Emits partial delta then fails with 503 -> fenced, must not retry.
    let counter_fenced = temp.path().join("review_attempts_fenced.txt");
    let driver_fenced = make_driver(&script, &counter_fenced, "review_delta_then_transient", 3);
    let err = run_acp_review_with_retry(
        AcpReviewRequest {
            db,
            driver: driver_fenced,
            payload,
            repo_path,
            profile_id: None,
            job_id: "job-755-fenced".to_string(),
            timeout: Duration::from_secs(30),
            cancellation: Cancellation::new(),
            verification_report: Arc::new(Mutex::new(ReviewVerificationReport::default())),
        },
        3,
        Some(&[0]),
    )
    .await
    .expect_err("fenced review failure must not retry");
    assert!(matches!(err, ReviewerError::Execution(_)));
    assert_eq!(read_attempts(&counter_fenced), 1);
}
