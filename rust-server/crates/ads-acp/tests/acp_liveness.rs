use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ads_acp::{
    ACP_THREAD_NAMESPACE, AcpDriver, AcpPromptRequest, AcpPromptRunner, AcpPromptRunnerConfig,
    AcpReviewRequest, AcpSessionConfig, AcpSessionSupervisor, AcpSupervisorConfig,
    AcpTransportConfig, AgyDriver, AgyDriverConfig, AutoApprovePermissionHandler, CodexDriver,
    CodexDriverConfig, GenericAcpDriver, SessionAttachMode, SupervisedSessionRequest,
    run_acp_review,
};
use ads_native::Cancellation;
use ads_reviewer::{
    ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewVerdictStatus, ReviewVerificationReport,
    ReviewerError,
};
use ads_runtime::{LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueRunner, PromptRunContext};
use ads_state::{StateDb, WEB_ACOPILOT_NAMESPACE};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tempfile::TempDir;

const MOCK_LIVENESS_SCRIPT: &str = r#"#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

session_counter = 0
state_file = os.environ.get("MOCK_STATE_FILE")
hang_resume = os.environ.get("MOCK_HANG_RESUME") == "1"

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def record(event):
    if not state_file:
        return
    with open(state_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")

def send_update(session_id, update):
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": update,
        },
    })

def handle_prompt(req_id, session_id, prompt_text):
    lines = [line.strip() for line in prompt_text.splitlines() if line.strip()]
    active_line = lines[-1] if lines else ""
    if "tool_pause_pass" in prompt_text:
        send_update(session_id, {
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-long-1",
            "title": "cargo test -p ads-acp",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": {"command": "cargo test -p ads-acp"},
        })
        time.sleep(0.35)
        send_update(session_id, {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-long-1",
            "title": "cargo test -p ads-acp",
            "kind": "execute",
            "status": "completed",
            "rawInput": {"command": "cargo test -p ads-acp"},
            "rawOutput": {"exitCode": 0, "stdout": "test result: ok"},
        })
        if "review_mode" in prompt_text:
            body = json.dumps({
                "status": "PASS",
                "summary": "Verified after silent tool run",
                "defects": [],
            })
        else:
            body = "Tool finished cleanly"
        send_update(session_id, {
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": body},
        })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        return

    if active_line == "unknown_keepalive":
        for idx in range(5):
            time.sleep(0.07)
            send_update(session_id, {
                "sessionUpdate": "vendor_progress_heartbeat",
                "seq": idx,
            })
        send_update(session_id, {
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "Alive through unknown frames"},
        })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
        return

    if active_line == "hang_after_tool":
        send_update(session_id, {
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-done-1",
            "title": "echo ok",
            "kind": "execute",
            "status": "in_progress",
        })
        time.sleep(0.05)
        send_update(session_id, {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-done-1",
            "title": "echo ok",
            "kind": "execute",
            "status": "completed",
        })
        # Now genuinely stall with no active tools; ignore cancel to exercise recycle.
        time.sleep(10)
        return

    if "hang_silent" in prompt_text:
        time.sleep(10)
        return

    send_update(session_id, {
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": "OK:" + session_id},
    })
    send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}
    if method:
        record({"method": method, "pid": os.getpid()})

    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentInfo": {"name": "mock-liveness", "version": "1.0.0"},
                "agentCapabilities": {
                    "loadSession": True,
                    "sessionCapabilities": {"resume": {}},
                },
                "authMethods": [],
            },
        })
    elif method == "session/new":
        session_counter += 1
        sid = f"sess-{os.getpid()}-{session_counter}"
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": sid,
                "modes": {
                    "currentModeId": "default",
                    "availableModes": [
                        {"id": "default", "name": "Default"},
                        {"id": "accept-edits", "name": "Accept Edits"},
                        {"id": "plan", "name": "Plan"},
                    ],
                },
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "mock-model",
                        "options": [{"value": "mock-model", "name": "Mock Model"}],
                    }
                ],
            },
        })
    elif method == "session/resume":
        if hang_resume:
            # Stall forever so supervisor hits lifecycle_rpc_timeout and recycles.
            continue
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"sessionId": params.get("sessionId", "sess-resumed")},
        })
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/set_config_option":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/prompt":
        sid = params.get("sessionId", "")
        blocks = params.get("prompt") or []
        text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        threading.Thread(target=handle_prompt, args=(req_id, sid, text), daemon=True).start()
    elif method == "session/cancel":
        record({"cancelled": params.get("sessionId")})
"#;

fn write_mock_script(dir: &TempDir, name: &str) -> PathBuf {
    let path = dir.path().join(name);
    fs::write(&path, MOCK_LIVENESS_SCRIPT).expect("write mock script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("chmod");
    }
    path
}

fn lane_turn(
    id: i64,
    client_msg_id: &str,
    history_key: &str,
    workspace: &str,
    text: &str,
) -> LaneTurn {
    let mut payload = Map::new();
    payload.insert("text".to_string(), json!(text));
    LaneTurn {
        key: LaneTurnKey::PromptQueue(id),
        kind: LaneTurnKind::UserPrompt,
        client_message_id: client_msg_id.to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "proj-1".to_string(),
        chat_session_id: "acopilot".to_string(),
        history_key: history_key.to_string(),
        logical_history_key: history_key.to_string(),
        lane_namespace: WEB_ACOPILOT_NAMESPACE.to_string(),
        lane_generation: 1,
        workspace_root: workspace.to_string(),
        payload,
        history_display_text: None,
        created_at: 1_700_000_000_000 + id,
    }
}

fn read_saved_acp_session_id(db: &StateDb, history_key: &str) -> Option<String> {
    let conn = db.connect().expect("conn");
    conn.query_row(
        "SELECT value FROM kv_state WHERE namespace = ?1 AND key LIKE ?2",
        params![ACP_THREAD_NAMESPACE, format!("{history_key}::%")],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .expect("query kv_state")
}

#[tokio::test]
async fn acp_inactivity_watchdog_pauses_for_tools_tracks_unknown_frames_and_recycles_on_stall() {
    let temp = TempDir::new().expect("temp dir");
    let script = write_mock_script(&temp, "mock_liveness.py");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let workspace_str = workspace.to_string_lossy().to_string();
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let driver: Arc<dyn AcpDriver> = Arc::new(GenericAcpDriver::new(
        "mock-liveness",
        script.to_string_lossy().to_string(),
    ));
    let mut sup_cfg = AcpSupervisorConfig::default();
    sup_cfg.session.cancel_drain_timeout = Duration::from_millis(150);
    let runner = AcpPromptRunner::new(
        db.clone(),
        AcpPromptRunnerConfig::new(driver)
            .with_agent_id("mock-liveness")
            .with_supervisor_config(sup_cfg)
            .with_idle_timeout(Some(Duration::from_millis(150))),
    );

    // 1. Silent 350ms tool execution (> 150ms idle timeout) must NOT time out.
    let tool_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let tool_events_h = Arc::clone(&tool_events);
    let tool_out = runner
        .run_lane_turn(
            lane_turn(
                1,
                "cm-tool-pause",
                "user-1::proj-1::tool-pause",
                &workspace_str,
                "tool_pause_pass",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                tool_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("run tool turn");
    assert!(
        tool_out.ok,
        "expected tool pause to prevent timeout: {:?}",
        tool_out.error
    );
    let result_ev = tool_events
        .lock()
        .expect("evs")
        .iter()
        .find(|ev| ev["type"] == "result")
        .cloned()
        .expect("result event");
    assert_eq!(result_ev["output"], json!("Tool finished cleanly"));

    // 2. Repeated unknown session/update frames (emitting zero ADS UI events) must keep turn alive.
    let unknown_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let unknown_events_h = Arc::clone(&unknown_events);
    let unknown_out = runner
        .run_lane_turn(
            lane_turn(
                2,
                "cm-unknown",
                "user-1::proj-1::unknown",
                &workspace_str,
                "unknown_keepalive",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                unknown_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("run unknown keepalive turn");
    assert!(
        unknown_out.ok,
        "expected unknown wire frames to refresh liveness: {:?}",
        unknown_out.error
    );

    // 3. Genuine silence AFTER a tool completes MUST fire watchdog, omit persisting session_id,
    //    and recycle the wedged subprocess.
    let stall_key = "user-1::proj-1::stall";
    let stall_events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let stall_events_h = Arc::clone(&stall_events);
    let stall_out = runner
        .run_lane_turn(
            lane_turn(3, "cm-stall", stall_key, &workspace_str, "hang_after_tool"),
            PromptRunContext::new(Arc::new(move |ev| {
                stall_events_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("run stalled turn");
    assert!(
        !stall_out.ok,
        "stalled turn after tool completion must time out"
    );
    let err_ev = stall_events
        .lock()
        .expect("evs")
        .iter()
        .find(|ev| ev["type"] == "error")
        .cloned()
        .expect("error event");
    assert_eq!(err_ev["errorInfo"]["code"], json!("acp_timeout"));
    assert!(
        read_saved_acp_session_id(&db, stall_key).is_none(),
        "timed-out turn must not persist a stale ACP session_id"
    );

    // Subsequent turn on the same lane must start cleanly on a fresh process (not resuming stalled session).
    let recovery_evs = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recovery_evs_h = Arc::clone(&recovery_evs);
    let recovery_out = runner
        .run_lane_turn(
            lane_turn(
                4,
                "cm-recover",
                stall_key,
                &workspace_str,
                "hello after stall",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                recovery_evs_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("run recovery turn");
    assert!(
        recovery_out.ok,
        "lane must recover cleanly after watchdog recycles stalled process: {:?}",
        recovery_out.error
    );
    let recovery_result = recovery_evs
        .lock()
        .expect("evs")
        .iter()
        .find(|ev| ev["type"] == "result")
        .cloned()
        .expect("recovery result event");
    assert_eq!(recovery_result["contextMode"], json!("fresh"));
    runner.shutdown().await;
}

#[tokio::test]
async fn acp_supervisor_recycles_and_falls_back_to_new_session_on_resume_timeout() {
    let temp = TempDir::new().expect("temp dir");
    let script = write_mock_script(&temp, "mock_resume_timeout.py");
    let state_file = temp.path().join("events.jsonl");

    let driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new("mock-resume-timeout", script.to_string_lossy().to_string())
            .with_env("MOCK_HANG_RESUME", "1")
            .with_env("MOCK_STATE_FILE", state_file.to_string_lossy().to_string()),
    );
    let sup_cfg = AcpSupervisorConfig {
        session: AcpSessionConfig {
            transport: AcpTransportConfig {
                rpc_timeout: Duration::from_secs(3),
                lifecycle_rpc_timeout: Duration::from_secs(3),
                graceful_exit_timeout: Duration::from_millis(150),
                term_exit_timeout: Duration::from_millis(150),
            },
            ..AcpSessionConfig::default()
        },
        fallback_to_new_on_resume_error: true,
        ..AcpSupervisorConfig::default()
    };
    let supervisor =
        AcpSessionSupervisor::new(driver, Arc::new(AutoApprovePermissionHandler), sup_cfg);

    let req = SupervisedSessionRequest::new("lane-resume-timeout", temp.path())
        .with_preferred_session_id("stale-wedged-session");
    let result = supervisor
        .run_turn(req, AcpPromptRequest::text("m1", "hello"))
        .await
        .expect("resume timeout should recycle subprocess and fall back to session/new");

    assert_eq!(
        result.attach_mode,
        SessionAttachMode::CreatedAfterResumeFallback
    );
    assert!(result.turn.response_text.starts_with("OK:sess-"));

    let logged = fs::read_to_string(&state_file).expect("read state file");
    let pids: Vec<u64> = logged
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|ev| ev["method"] == "initialize")
        .filter_map(|ev| ev["pid"].as_u64())
        .collect();
    assert_eq!(
        pids.len(),
        2,
        "expected timed-out resume subprocess to be recycled into a fresh subprocess, got pids={pids:?}"
    );
    assert_ne!(pids[0], pids[1]);
    supervisor.shutdown_all().await;
}

#[tokio::test]
async fn acp_reviewer_pauses_inactivity_for_verification_and_reports_incomplete_on_stall_or_cap() {
    let temp = TempDir::new().expect("temp dir");
    let script = write_mock_script(&temp, "mock_reviewer_liveness.py");
    let repo_path = temp.path().join("repo");
    fs::create_dir_all(&repo_path).expect("repo dir");
    let db = StateDb::open(temp.path().join("state.db")).expect("db");
    {
        let conn = db.connect().expect("conn");
        conn.execute(
            "UPDATE role_profiles SET model_id = 'mock-model', reasoning_effort = 'high' WHERE id = 'profile-default-reviewer'",
            [],
        )
        .expect("update reviewer profile");
    }

    let driver: Arc<dyn AcpDriver> = Arc::new(GenericAcpDriver::new(
        "mock-liveness",
        script.to_string_lossy().to_string(),
    ));
    let make_payload = |marker: &str| ReviewPayload {
        issue: ReviewIssue {
            id: Some(757),
            title: format!("Liveness test {marker}"),
            description: Some(marker.to_string()),
            acceptance_criteria: Some(vec!["Reviewer survives active tools".to_string()]),
        },
        adrs: Some(Vec::new()),
        rework_declaration: None,
        diff_range: Some(ReviewDiffRange {
            base_ref: "dev".to_string(),
            head_ref: "fix/757".to_string(),
            base_commit: Some("1111111".to_string()),
            head_commit: Some("2222222".to_string()),
            range: "1111111..2222222".to_string(),
        }),
        diff: "diff --git a/a.rs b/a.rs\n+fn ok() {}\n".to_string(),
        diff_stat: Some("a.rs | 1 +".to_string()),
        diff_capture_error: None,
        related_contexts: Some(Vec::new()),
        related_context_omissions: Some(Vec::new()),
        verification_report: None,
    };

    // 1. Active tool running 350ms with 150ms idle_timeout and no hard max_duration -> PASS.
    let report = Arc::new(Mutex::new(ReviewVerificationReport::default()));
    let verdict = run_acp_review(AcpReviewRequest {
        db: db.clone(),
        driver: Arc::clone(&driver),
        payload: make_payload("tool_pause_pass review_mode"),
        repo_path: repo_path.clone(),
        profile_id: None,
        job_id: "job-757-pass".to_string(),
        idle_timeout: Some(Duration::from_millis(150)),
        max_duration: None,
        cancellation: Cancellation::new(),
        verification_report: Arc::clone(&report),
    })
    .await
    .expect("active tool execution must pause reviewer inactivity watchdog");
    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    assert_eq!(report.lock().expect("report").commands.len(), 1);

    // 2. Opt-in max_duration hard cap bounds even a completely silent hung review as Incomplete.
    let started = Instant::now();
    let cap_err = run_acp_review(AcpReviewRequest {
        db: db.clone(),
        driver: Arc::clone(&driver),
        payload: make_payload("hang_silent"),
        repo_path: repo_path.clone(),
        profile_id: None,
        job_id: "job-757-cap".to_string(),
        idle_timeout: Some(Duration::from_secs(60)),
        max_duration: Some(Duration::from_millis(250)),
        cancellation: Cancellation::new(),
        verification_report: Arc::new(Mutex::new(ReviewVerificationReport::default())),
    })
    .await
    .expect_err("opt-in max_duration should terminate wedged review");
    assert!(
        matches!(cap_err, ReviewerError::Incomplete(_)),
        "expected Incomplete on max_duration cap, got {cap_err:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "max_duration shutdown should not block for full cancel drain; elapsed={:?}",
        started.elapsed()
    );
}

#[test]
fn drivers_do_not_misclassify_transient_32000_rpc_errors_as_auth_required() {
    let agy = AgyDriver::new(AgyDriverConfig::default());
    let codex = CodexDriver::new(CodexDriverConfig::default());

    for driver in [&agy as &dyn AcpDriver, &codex as &dyn AcpDriver] {
        let auth_err = driver.map_rpc_error(
            "initialize",
            -32000,
            "Authentication required",
            Some(json!({ "authMethods": [] })),
        );
        assert!(auth_err.is_auth_required());

        let transient_msg_err = driver.map_rpc_error(
            "session/prompt",
            -32000,
            "HTTP 503 Service Unavailable",
            None,
        );
        assert!(
            !transient_msg_err.is_auth_required(),
            "transient 503 -32000 must not be misclassified as auth required: {transient_msg_err:?}"
        );

        let transient_payload_err = driver.map_rpc_error(
            "session/prompt",
            -32000,
            "upstream error",
            Some(json!({ "status": 429 })),
        );
        assert!(
            !transient_payload_err.is_auth_required(),
            "transient 429 payload -32000 must not be misclassified as auth required: {transient_payload_err:?}"
        );
    }
}

#[tokio::test]
async fn first_turn_timeout_or_cancellation_does_not_persist_session_id_and_preserves_bootstrap() {
    let temp = TempDir::new().expect("temp dir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let workspace_str = workspace.to_string_lossy().to_string();

    let script_path = temp.path().join("mock_cancel_persist.py");
    let prompt_log = temp.path().join("prompts.jsonl");
    let script = r#"#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

log_path = os.environ["MOCK_PROMPT_LOG"]
session_num = 0
cancel_events = {}

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def log_prompt(session_id, text):
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"sessionId": session_id, "text": text}) + "\n")

def handle_prompt(req_id, session_id, prompt_text):
    log_prompt(session_id, prompt_text)
    lines = [line.strip() for line in prompt_text.splitlines() if line.strip()]
    active_line = lines[-1] if lines else ""
    if active_line in ("wait_cancel", "wait_timeout"):
        cancel_ev = cancel_events.setdefault(session_id, threading.Event())
        cancel_ev.clear()
        if active_line == "wait_cancel":
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "waiting-for-cancel"},
                    },
                },
            })
        cancel_ev.wait(timeout=10.0)
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "cancelled"}})
        return

    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "OK:" + session_id},
            },
        },
    })
    send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    msg = json.loads(raw)
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": 1,
                "agentInfo": {"name": "mock-cancel-persist", "version": "1.0.0"},
                "agentCapabilities": {"loadSession": True, "sessionCapabilities": {"resume": {}}},
                "authMethods": [],
            },
        })
    elif method == "session/new":
        session_num += 1
        sid = f"sess-{os.getpid()}-{session_num}"
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": sid,
                "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}, {"id": "acceptEdits", "name": "Accept Edits"}]},
                "configOptions": [],
            },
        })
    elif method in ("session/resume", "session/load"):
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": params.get("sessionId"),
                "modes": {"currentModeId": "default", "availableModes": []},
                "configOptions": [],
            },
        })
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
    elif method == "session/cancel":
        sid = params.get("sessionId")
        ev = cancel_events.get(sid)
        if ev is not None:
            ev.set()
    elif method == "session/prompt":
        sid = params.get("sessionId")
        blocks = params.get("prompt") or []
        text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        threading.Thread(target=handle_prompt, args=(req_id, sid, text), daemon=True).start()
"#;
    fs::write(&script_path, script).expect("write mock script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }

    let db = StateDb::open(temp.path().join("state.db")).expect("state db");
    {
        let conn = db.connect().expect("conn");
        conn.execute(
            "UPDATE role_profiles SET system_prompt = 'ISSUE_754_ROLE_INSTRUCTIONS' WHERE role = 'acopilot'",
            [],
        )
        .expect("set acopilot system prompt");
    }

    let driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new(
            "mock-cancel-persist",
            script_path.to_string_lossy().to_string(),
        )
        .with_env("MOCK_PROMPT_LOG", prompt_log.to_string_lossy().to_string()),
    );
    let runner = Arc::new(AcpPromptRunner::new(
        db.clone(),
        AcpPromptRunnerConfig::new(driver)
            .with_idle_timeout(Some(Duration::from_millis(250)))
            .with_supervisor_config(AcpSupervisorConfig {
                session: AcpSessionConfig {
                    cancel_drain_timeout: Duration::from_secs(2),
                    ..AcpSessionConfig::default()
                },
                ..AcpSupervisorConfig::default()
            }),
    ));

    let load_saved_session = |history_key: &str| -> Option<String> {
        let conn = db.connect().expect("conn");
        let storage_key =
            format!("{history_key}::{workspace_str}::mock-cancel-persist::default::acopilot");
        conn.query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![ACP_THREAD_NAMESPACE, storage_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .expect("query kv_state")
    };

    let read_prompts = || -> Vec<Value> {
        fs::read_to_string(&prompt_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    };

    // 1. First turn cancelled via abort_lane_turn (agent returns Ok(StopReason::Cancelled)):
    // must NOT persist session_id in kv_state; next turn must still inject bootstrap role + history.
    let cancel_key = "user-1::proj-754::cancel-first";
    let cancel_turn = lane_turn(1, "cm-cancel-1", cancel_key, &workspace_str, "wait_cancel");
    let cancel_turn_for_abort = cancel_turn.clone();
    let runner_for_abort = Arc::clone(&runner);
    let aborted_once = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_out = runner
        .run_lane_turn(
            cancel_turn,
            PromptRunContext::new(Arc::new(move |ev| {
                if ev["type"] == "delta"
                    && !aborted_once.swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    runner_for_abort.abort_lane_turn(&cancel_turn_for_abort);
                }
            })),
        )
        .await
        .expect("run cancelled first turn");
    assert!(!cancel_out.ok, "cancelled first turn must fail");
    assert_eq!(
        load_saved_session(cancel_key),
        None,
        "cancelled first turn must not persist session_id under ACP_THREAD_NAMESPACE"
    );

    let after_cancel_out = runner
        .run_lane_turn(
            lane_turn(
                2,
                "cm-cancel-2",
                cancel_key,
                &workspace_str,
                "hello after cancel",
            ),
            PromptRunContext::new(Arc::new(|_| {})),
        )
        .await
        .expect("run second turn after cancel");
    assert!(after_cancel_out.ok);
    let persisted_after_cancel =
        load_saved_session(cancel_key).expect("completed turn must persist session_id in kv_state");
    let prompts_after_cancel = read_prompts();
    let second_prompt_text = prompts_after_cancel
        .last()
        .and_then(|v| v["text"].as_str())
        .unwrap_or("");
    assert!(
        second_prompt_text.contains("[Role Instructions]\nISSUE_754_ROLE_INSTRUCTIONS"),
        "turn following cancelled first turn must still inject [Role Instructions]: {second_prompt_text}"
    );
    assert!(
        second_prompt_text.contains("[Recent Conversation History]")
            && second_prompt_text.contains("User: wait_cancel"),
        "turn following cancelled first turn must still inject [Recent Conversation History]: {second_prompt_text}"
    );

    // 2. Subsequent turn cancelled on an established session must preserve existing kv_state value.
    let cancel_turn_3 = lane_turn(3, "cm-cancel-3", cancel_key, &workspace_str, "wait_cancel");
    let cancel_turn_3_abort = cancel_turn_3.clone();
    let runner_for_abort_3 = Arc::clone(&runner);
    let aborted_3 = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_out_3 = runner
        .run_lane_turn(
            cancel_turn_3,
            PromptRunContext::new(Arc::new(move |ev| {
                if ev["type"] == "delta"
                    && !aborted_3.swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    runner_for_abort_3.abort_lane_turn(&cancel_turn_3_abort);
                }
            })),
        )
        .await
        .expect("run cancelled third turn");
    assert!(!cancel_out_3.ok);
    assert_eq!(
        load_saved_session(cancel_key).as_deref(),
        Some(persisted_after_cancel.as_str()),
        "cancelled turn on established session must not overwrite existing persisted session_id"
    );

    // 3. First turn timed out by inactivity watchdog (agent responds cleanly with StopReason::Cancelled):
    // must NOT persist session_id in kv_state; next turn must still inject bootstrap role + history.
    let timeout_key = "user-1::proj-754::timeout-first";
    let timeout_out = runner
        .run_lane_turn(
            lane_turn(
                4,
                "cm-timeout-1",
                timeout_key,
                &workspace_str,
                "wait_timeout",
            ),
            PromptRunContext::new(Arc::new(|_| {})),
        )
        .await
        .expect("run timed-out first turn");
    assert!(!timeout_out.ok, "timed-out first turn must fail");
    assert_eq!(
        load_saved_session(timeout_key),
        None,
        "timed-out first turn must not persist session_id under ACP_THREAD_NAMESPACE"
    );

    let after_timeout_out = runner
        .run_lane_turn(
            lane_turn(
                5,
                "cm-timeout-2",
                timeout_key,
                &workspace_str,
                "hello after timeout",
            ),
            PromptRunContext::new(Arc::new(|_| {})),
        )
        .await
        .expect("run second turn after timeout");
    assert!(after_timeout_out.ok);
    assert!(
        load_saved_session(timeout_key).is_some(),
        "completed turn after timeout must persist session_id"
    );
    let prompts_after_timeout = read_prompts();
    let recovery_prompt_text = prompts_after_timeout
        .last()
        .and_then(|v| v["text"].as_str())
        .unwrap_or("");
    assert!(
        recovery_prompt_text.contains("[Role Instructions]\nISSUE_754_ROLE_INSTRUCTIONS"),
        "turn following timed-out first turn must still inject [Role Instructions]: {recovery_prompt_text}"
    );
    assert!(
        recovery_prompt_text.contains("[Recent Conversation History]")
            && recovery_prompt_text.contains("User: wait_timeout"),
        "turn following timed-out first turn must still inject [Recent Conversation History]: {recovery_prompt_text}"
    );

    runner.shutdown().await;
}
