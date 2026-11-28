use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ads_acp::{
    AcpDriver, AcpPromptRunner, AcpPromptRunnerConfig, ActionTools, ActionToolsFactory,
    GenericAcpDriver,
};
use ads_native::NativeError;
use ads_runtime::{LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueRunner, PromptRunContext};
use ads_state::{HistoryStore, StateDb, WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE};
use serde_json::{Map, Value, json};
use tempfile::TempDir;

fn write_handoff_mock_acp_script(dir: &Path) -> PathBuf {
    let script_path = dir.join("mock_review_handoff_acp.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys

log_path = os.environ["MOCK_LOG_FILE"]
session_num = 0
prompt_count = 0

def log_event(obj):
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

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
                "agentInfo": {"name": "mock-handoff-acp", "version": "1.0.0"},
                "authMethods": [],
            },
        })
    elif method == "session/new":
        session_num += 1
        log_event({"method": "session/new", "mcpServers": params.get("mcpServers", [])})
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": f"sess-{session_num}",
                "modes": {
                    "currentModeId": "default",
                    "availableModes": [
                        {"id": "default", "name": "Default"},
                        {"id": "acceptEdits", "name": "Accept Edits"},
                        {"id": "plan", "name": "Plan"},
                    ],
                },
                "configOptions": [],
            },
        })
    elif method == "session/set_mode":
        log_event({"method": "session/set_mode", "modeId": params.get("modeId")})
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"modes": {"currentModeId": params.get("modeId", "default"), "availableModes": []}},
        })
    elif method == "session/prompt":
        prompt_count += 1
        session_id = params.get("sessionId", "sess-1")
        blocks = params.get("prompt") or []
        prompt_text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        log_event({
            "method": "session/prompt",
            "sessionId": session_id,
            "count": prompt_count,
            "text": prompt_text,
        })

        if "[ADS Host Handoff Result: review_action FAILED]" in prompt_text:
            if "always_fail_rework" in prompt_text or os.environ.get("MOCK_ALWAYS_FAIL_REPAIR") == "1":
                reply = "Still retrying with empty payload.\n\n```ads-review-action\n{}\n```"
            else:
                rework_payload = {
                    "rework": {
                        "prior_job_id": "job-rejected-1",
                        "issue_id": 758,
                        "pr_number": 760,
                        "base_sha": "aaa111",
                        "rejected_head_sha": "bbb222",
                        "new_head_sha": "ccc333",
                        "root_cause": "Missing ACP review_action handoff",
                        "invariant": "All ACP Acopilot turns dispatch via host-owned handoff",
                        "audited_scope": ["rust-server/crates/ads-acp/src/prompt_runner.rs"],
                        "changed_behavior": "Added host-owned ads-review-action parser and repair loop",
                        "regression_cases": ["post-REJECT rework repair round"],
                        "verification_evidence": ["cargo test -p ads-acp"],
                        "residual_risks": [],
                    }
                }
                reply = (
                    "Added the required ADR 0059 rework declaration and re-dispatched.\n\n"
                    "```ads-review-action\n"
                    + json.dumps(rework_payload)
                    + "\n```"
                )
        elif "quoted_example_only" in prompt_text:
            reply = (
                "Here is the documented format:\n\n"
                "````markdown\n"
                "```ads-review-action\n"
                "{}\n"
                "```\n"
                "````\n"
            )
        elif "trigger_rework_repair" in prompt_text:
            reply = "Attempting redispatch.\n\n```ads-review-action\n{}\n```"
        elif "trigger_initial_review" in prompt_text or "trigger_actions_review" in prompt_text or "trigger_forbidden_review" in prompt_text:
            reply = "PR is ready for review.\n\n```ads-review-action\n{}\n```"
        else:
            reply = "Normal response without handoff."

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
    fs::write(&script_path, script).expect("write mock handoff script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }
    script_path
}

fn make_turn(
    workspace: &Path,
    lane_namespace: &str,
    kind: LaneTurnKind,
    client_message_id: &str,
    history_key: &str,
    text: &str,
) -> LaneTurn {
    let mut payload = Map::new();
    payload.insert("text".to_string(), Value::String(text.to_string()));
    LaneTurn {
        key: LaneTurnKey::PromptQueue(1),
        kind,
        client_message_id: client_message_id.to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "proj-758".to_string(),
        chat_session_id: "main".to_string(),
        history_key: history_key.to_string(),
        logical_history_key: history_key.to_string(),
        lane_namespace: lane_namespace.to_string(),
        lane_generation: 1,
        workspace_root: workspace.to_string_lossy().into_owned(),
        payload,
        history_display_text: None,
        created_at: 1_000,
    }
}

fn read_mock_log(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

#[tokio::test]
async fn acp_prompt_runner_dispatches_initial_and_repaired_rework_handoffs_without_mcp() {
    let temp = TempDir::new().expect("temp dir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let log_path = temp.path().join("mock_log.jsonl");
    let script = write_handoff_mock_acp_script(temp.path());
    let driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new("mock-handoff", script.to_string_lossy().as_ref())
            .with_env("MOCK_LOG_FILE", log_path.to_string_lossy().into_owned()),
    );
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    let dispatched: Arc<Mutex<Vec<(String, LaneTurnKind, Value)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let require_rework = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dispatched_cb = Arc::clone(&dispatched);
    let require_rework_cb = Arc::clone(&require_rework);
    let factory: ActionToolsFactory = Arc::new(move |entry: &LaneTurn| {
        let allowed = match entry.lane_namespace.as_str() {
            WEB_ACOPILOT_NAMESPACE => {
                matches!(
                    entry.kind,
                    LaneTurnKind::UserPrompt | LaneTurnKind::AgentHandoff
                )
            }
            WEB_ACTIONS_NAMESPACE => entry.kind == LaneTurnKind::UserPrompt,
            _ => false,
        };
        if !allowed {
            return None;
        }
        let dispatched_cb = Arc::clone(&dispatched_cb);
        let require_rework_cb = Arc::clone(&require_rework_cb);
        let lane = entry.lane_namespace.clone();
        let kind = entry.kind;
        Some(ActionTools::new_with_arguments(move |arguments| {
            let dispatched_cb = Arc::clone(&dispatched_cb);
            let require_rework_cb = Arc::clone(&require_rework_cb);
            let lane = lane.clone();
            async move {
                dispatched_cb
                    .lock()
                    .expect("dispatched")
                    .push((lane, kind, arguments.clone()));
                if require_rework_cb.load(std::sync::atomic::Ordering::Acquire)
                    && arguments.get("rework").is_none()
                {
                    return Err(NativeError::Tool(
                        "A complete rework declaration is required before redispatch after REJECT."
                            .to_string(),
                    ));
                }
                Ok(json!({
                    "ok": true,
                    "jobId": if arguments.get("rework").is_some() { "job-rework-2" } else { "job-init-1" },
                    "status": "queued",
                    "issueId": 758,
                    "branch": "feat/758-acp-review-action-handoff",
                    "note": "Review runs in the Actions lane."
                }))
            }
        }))
    });

    let runner = AcpPromptRunner::new(
        db.clone(),
        AcpPromptRunnerConfig::new(driver).with_action_tools_factory(factory),
    );

    // 1. Initial Acopilot PR review dispatch
    let events_init = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_init_h = Arc::clone(&events_init);
    let outcome = runner
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-init",
                "user-1::proj-758::acopilot",
                "trigger_initial_review",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                events_init_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("initial turn");
    assert!(outcome.ok);

    let recorded_init = events_init.lock().expect("evs").clone();
    let handoff_ev = recorded_init
        .iter()
        .find(|ev| ev["type"] == "review_action_handoff")
        .expect("review_action_handoff event");
    assert_eq!(handoff_ev["ok"], json!(true));
    assert_eq!(handoff_ev["jobId"], json!("job-init-1"));
    assert_eq!(handoff_ev["status"], json!("queued"));

    let result_ev = recorded_init
        .iter()
        .find(|ev| ev["type"] == "result")
        .expect("result event");
    let output_text = result_ev["output"].as_str().expect("output");
    assert!(
        !output_text.contains("ads-review-action"),
        "raw handoff block must be stripped from visible output: {output_text}"
    );
    assert!(output_text.contains("review_action completed."));
    assert!(output_text.contains("Actions job: job-init-1."));

    let conn = db.connect().expect("conn");
    let history = HistoryStore::new(WEB_ACOPILOT_NAMESPACE, 50, 20_000)
        .get(&conn, "user-1::proj-758::acopilot")
        .expect("history");
    let last_ai = history.iter().rev().find(|e| e.role == "ai").expect("ai");
    assert!(!last_ai.text.contains("ads-review-action"));
    assert!(last_ai.text.contains("Actions job: job-init-1."));

    // 2. Post-REJECT repair loop on the SAME live ACP session
    require_rework.store(true, std::sync::atomic::Ordering::Release);
    let events_rework = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_rework_h = Arc::clone(&events_rework);
    let rework_outcome = runner
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::AgentHandoff,
                "cm-rework",
                "user-1::proj-758::acopilot",
                "trigger_rework_repair",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                events_rework_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("rework turn");
    assert!(rework_outcome.ok);

    let recorded_rework = events_rework.lock().expect("evs").clone();
    let handoff_evs: Vec<&Value> = recorded_rework
        .iter()
        .filter(|ev| ev["type"] == "review_action_handoff")
        .collect();
    assert_eq!(
        handoff_evs.len(),
        2,
        "expected initial failure + repaired success"
    );
    assert_eq!(handoff_evs[0]["ok"], json!(false));
    assert_eq!(handoff_evs[0]["retrying"], json!(true));
    assert_eq!(handoff_evs[1]["ok"], json!(true));
    assert_eq!(handoff_evs[1]["jobId"], json!("job-rework-2"));
    assert_eq!(handoff_evs[1]["attempt"], json!(2));
    // Verify non-colliding assistantItemIds across repair rounds and stripped raw blocks.
    let rework_items: Vec<&Value> = recorded_rework
        .iter()
        .filter(|ev| ev["type"] == "assistant_item")
        .collect();
    assert_eq!(
        rework_items.len(),
        2,
        "two distinct phases across two rounds"
    );
    assert_ne!(
        rework_items[0]["assistantItemId"],
        rework_items[1]["assistantItemId"]
    );
    for item in &rework_items {
        assert!(
            !item["assistantItemText"]
                .as_str()
                .unwrap_or("")
                .contains("ads-review-action"),
            "every reconciled assistant_item must have raw ads-review-action stripped: {item}"
        );
    }

    // Verify zero MCP servers were configured and protocol instructions were injected
    let logs = read_mock_log(&log_path);
    for entry in logs.iter().filter(|e| e["method"] == "session/new") {
        assert_eq!(
            entry["mcpServers"],
            json!([]),
            "ACP must not configure MCP servers"
        );
    }
    let prompts: Vec<&Value> = logs
        .iter()
        .filter(|e| e["method"] == "session/prompt")
        .collect();
    assert_eq!(
        prompts.len(),
        3,
        "initial + failed rework + repaired rework"
    );
    assert!(
        prompts[0]["text"]
            .as_str()
            .unwrap_or("")
            .contains("[Review Action Handoff Protocol]")
    );
    assert_eq!(
        prompts[1]["sessionId"], prompts[2]["sessionId"],
        "repair prompt must stay on the same live ACP session"
    );
    assert!(
        prompts[2]["text"]
            .as_str()
            .unwrap_or("")
            .contains("[ADS Host Handoff Result: review_action FAILED]")
    );

    // 3. Human-initiated Actions lane UserPrompt IS allowed (while staying read-only Plan mode)
    require_rework.store(false, std::sync::atomic::Ordering::Release);
    let events_actions_user = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_actions_user_h = Arc::clone(&events_actions_user);
    let actions_user_outcome = runner
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACTIONS_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-actions-user",
                "user-1::proj-758::actions",
                "trigger_actions_review",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                events_actions_user_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("actions user turn");
    assert!(actions_user_outcome.ok);
    assert!(
        events_actions_user
            .lock()
            .expect("evs")
            .iter()
            .any(|ev| ev["type"] == "review_action_handoff" && ev["ok"] == json!(true)),
        "user-initiated Actions lane turn must execute review_action handoff"
    );

    // 4. Non-user-initiated Actions lane AgentHandoff MUST NOT execute review_action
    let count_before_forbidden = dispatched.lock().expect("dispatched").len();
    let events_forbidden = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_forbidden_h = Arc::clone(&events_forbidden);
    let forbidden_outcome = runner
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACTIONS_NAMESPACE,
                LaneTurnKind::AgentHandoff,
                "cm-actions-forbidden",
                "user-1::proj-758::actions-auto",
                "trigger_forbidden_review",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                events_forbidden_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("actions forbidden turn");
    assert!(forbidden_outcome.ok);
    assert_eq!(
        dispatched.lock().expect("dispatched").len(),
        count_before_forbidden,
        "forbidden Actions lane non-UserPrompt must never dispatch review_action"
    );
    let forbidden_evs = events_forbidden.lock().expect("evs").clone();
    assert!(
        !forbidden_evs
            .iter()
            .any(|ev| ev["type"] == "review_action_handoff")
    );
    let forbidden_result = forbidden_evs
        .iter()
        .find(|ev| ev["type"] == "result")
        .expect("forbidden result");
    assert!(
        !forbidden_result["output"]
            .as_str()
            .unwrap_or("")
            .contains("ads-review-action"),
        "even when denied, raw ads-review-action block should be stripped"
    );

    let all_logs = read_mock_log(&log_path);
    assert!(
        all_logs
            .iter()
            .any(|e| e["method"] == "session/set_mode" && e["modeId"] == "plan"),
        "Actions lane ACP session must stay in read-only plan mode"
    );

    // 5. Quoted ads-review-action example inside outer Markdown code fence MUST NOT dispatch or corrupt output.
    let count_before_quoted = dispatched.lock().expect("dispatched").len();
    let events_quoted = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_quoted_h = Arc::clone(&events_quoted);
    let quoted_outcome = runner
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-quoted",
                "user-1::proj-758::acopilot",
                "quoted_example_only",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                events_quoted_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("quoted turn");
    assert!(quoted_outcome.ok);
    assert_eq!(
        dispatched.lock().expect("dispatched").len(),
        count_before_quoted,
        "quoted ads-review-action block inside outer fence must not trigger live dispatch"
    );
    let quoted_result = events_quoted
        .lock()
        .expect("evs")
        .iter()
        .find(|ev| ev["type"] == "result")
        .cloned()
        .expect("quoted result");
    assert!(
        quoted_result["output"]
            .as_str()
            .unwrap_or("")
            .contains("````markdown\n```ads-review-action\n{}\n```\n````"),
        "quoted markdown example must remain uncorrupted: {quoted_result}"
    );

    runner.shutdown().await;
}

#[tokio::test]
async fn acp_review_handoff_handles_repair_exhaustion_cancellation_and_restart_protocol_rebootstrap()
 {
    let temp = TempDir::new().expect("temp dir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let log_path = temp.path().join("mock_edge_log.jsonl");
    let script = write_handoff_mock_acp_script(temp.path());
    let db = StateDb::open(temp.path().join("state.db")).expect("db");

    // 1. Repair-round exhaustion (3 attempts total -> retrying=false and explicit failure text).
    let always_fail_driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new("mock-handoff-edge", script.to_string_lossy().as_ref())
            .with_env("MOCK_LOG_FILE", log_path.to_string_lossy().into_owned())
            .with_env("MOCK_ALWAYS_FAIL_REPAIR", "1"),
    );
    let always_reject_factory: ActionToolsFactory = Arc::new(|_entry: &LaneTurn| {
        Some(ActionTools::new_with_arguments(|_args| async {
            Err(NativeError::Tool(
                "Missing required rework fields".to_string(),
            ))
        }))
    });
    let runner_exhaust = AcpPromptRunner::new(
        db.clone(),
        AcpPromptRunnerConfig::new(always_fail_driver)
            .with_action_tools_factory(always_reject_factory),
    );

    let exhaust_evs = Arc::new(Mutex::new(Vec::<Value>::new()));
    let exhaust_evs_h = Arc::clone(&exhaust_evs);
    let exhaust_out = runner_exhaust
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-exhaust",
                "user-1::proj-758::exhaust",
                "trigger_rework_repair",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                exhaust_evs_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("exhaust turn");
    assert!(exhaust_out.ok);
    let recorded_exhaust = exhaust_evs.lock().expect("evs").clone();
    let handoff_evs: Vec<&Value> = recorded_exhaust
        .iter()
        .filter(|ev| ev["type"] == "review_action_handoff")
        .collect();
    assert_eq!(handoff_evs.len(), 3, "1 initial + 2 repair rounds");
    assert_eq!(handoff_evs[0]["retrying"], json!(true));
    assert_eq!(handoff_evs[1]["retrying"], json!(true));
    assert_eq!(handoff_evs[2]["retrying"], json!(false));
    let exhaust_result = recorded_exhaust
        .iter()
        .find(|ev| ev["type"] == "result")
        .expect("exhaust result");
    assert!(
        exhaust_result["output"]
            .as_str()
            .unwrap_or("")
            .contains("review_action failed.\nReason: Missing required rework fields")
    );
    runner_exhaust.shutdown().await;

    // 2. Restarting AcpPromptRunner against the same StateDb (no live session in supervisor)
    // must re-inject [Review Action Handoff Protocol] so newly created/fallback sessions have it.
    let restart_log = temp.path().join("mock_restart_log.jsonl");
    let restart_driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new("mock-handoff-edge", script.to_string_lossy().as_ref())
            .with_env("MOCK_LOG_FILE", restart_log.to_string_lossy().into_owned()),
    );
    let ok_factory: ActionToolsFactory = Arc::new(|_entry: &LaneTurn| {
        Some(ActionTools::new_with_arguments(|_args| async {
            Ok(json!({"ok": true, "jobId": "j-restart", "status": "queued"}))
        }))
    });
    let runner_restarted = AcpPromptRunner::new(
        db.clone(),
        AcpPromptRunnerConfig::new(restart_driver).with_action_tools_factory(ok_factory),
    );
    let restart_out = runner_restarted
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-after-restart",
                "user-1::proj-758::exhaust",
                "hello after restart",
            ),
            PromptRunContext::new(Arc::new(|_| {})),
        )
        .await
        .expect("after restart turn");
    assert!(restart_out.ok);
    let restart_logs = read_mock_log(&restart_log);
    let restart_prompt = restart_logs
        .iter()
        .find(|e| e["method"] == "session/prompt")
        .expect("restart prompt");
    assert!(
        restart_prompt["text"]
            .as_str()
            .unwrap_or("")
            .contains("[Review Action Handoff Protocol]"),
        "post-restart session without live subprocess must re-inject Review Action Handoff Protocol"
    );
    runner_restarted.shutdown().await;

    // 3. Cancellation occurring during a failing review_action dispatch must return turn_cancelled (ok: false).
    let cancel_driver: Arc<dyn AcpDriver> = Arc::new(
        GenericAcpDriver::new("mock-handoff-cancel", script.to_string_lossy().as_ref()).with_env(
            "MOCK_LOG_FILE",
            temp.path()
                .join("cancel.jsonl")
                .to_string_lossy()
                .into_owned(),
        ),
    );
    let runner_holder: Arc<Mutex<Option<Arc<AcpPromptRunner>>>> = Arc::new(Mutex::new(None));
    let runner_holder_cb = Arc::clone(&runner_holder);
    let cancel_factory: ActionToolsFactory = Arc::new(move |entry: &LaneTurn| {
        let runner_holder_cb = Arc::clone(&runner_holder_cb);
        let turn_clone = entry.clone();
        Some(ActionTools::new_with_arguments(move |_args| {
            let runner_holder_cb = Arc::clone(&runner_holder_cb);
            let turn_clone = turn_clone.clone();
            async move {
                if let Some(runner) = runner_holder_cb.lock().expect("holder").as_ref() {
                    runner.abort_lane_turn(&turn_clone);
                }
                Err(NativeError::Tool("aborted mid-dispatch".to_string()))
            }
        }))
    });
    let runner_cancel = Arc::new(AcpPromptRunner::new(
        db,
        AcpPromptRunnerConfig::new(cancel_driver).with_action_tools_factory(cancel_factory),
    ));
    *runner_holder.lock().expect("holder") = Some(Arc::clone(&runner_cancel));

    let cancel_evs = Arc::new(Mutex::new(Vec::<Value>::new()));
    let cancel_evs_h = Arc::clone(&cancel_evs);
    let cancel_out = runner_cancel
        .run_lane_turn(
            make_turn(
                &workspace,
                WEB_ACOPILOT_NAMESPACE,
                LaneTurnKind::UserPrompt,
                "cm-cancel-handoff",
                "user-1::proj-758::cancel",
                "trigger_rework_repair",
            ),
            PromptRunContext::new(Arc::new(move |ev| {
                cancel_evs_h.lock().expect("evs").push(ev);
            })),
        )
        .await
        .expect("cancel turn");
    assert!(
        !cancel_out.ok,
        "cancellation during review_action dispatch must fail, not succeed"
    );
    assert!(
        cancel_evs
            .lock()
            .expect("evs")
            .iter()
            .any(|ev| ev["type"] == "error" && ev["errorInfo"]["code"] == json!("turn_cancelled")),
        "expected turn_cancelled error event when aborted during review_action handoff"
    );
    runner_cancel.shutdown().await;
}
