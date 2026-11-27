use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_acp::{
    AcpDriver, AcpLaunchContext, AcpReviewRequest, CodexDriver, CodexDriverConfig,
    CodexProbeStatus, ConfigOption, ConfigOptionChoice, ConfigOptionValue, ConfigOptionsState,
    DesiredConfigAlignment, PendingPermissionRequest, PermissionHandler, PermissionOption,
    PermissionOptionKind, PermissionOutcome, ReviewVerificationPermissionHandler, SessionMode,
    SessionModeInfo, SessionModeState, SessionUpdate, ToolCallInfo, build_codex_launch_spec,
    probe_codex_runtime, read_codex_auth_metadata, run_acp_review,
};
use ads_native::Cancellation;
use ads_reviewer::{
    ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewVerdictStatus, ReviewVerificationReport,
};
use ads_state::{
    ROLE_REVIEWER, SaveRoleProfile, StateDb, get_default_role_profile, save_role_profile,
};
use serde_json::{Map, json};

fn write_mock_codex_acp_script(dir: &Path) -> PathBuf {
    let script_path = dir.join("mock-codex-acp.py");
    let script = r#"#!/usr/bin/env python3
import json, os, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def has_auth():
    if os.environ.get("CODEX_API_KEY", "").strip() or os.environ.get("OPENAI_API_KEY", "").strip():
        return True
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    if not codex_home:
        return False
    auth_path = os.path.join(codex_home, "auth.json")
    return os.path.isfile(auth_path) and os.path.getsize(auth_path) > 2

session_counter = 0
req_counter = 0

def ask_permission(session_id, tool_call):
    global req_counter
    req_counter += 1
    rpc_id = f"perm-{req_counter}"
    send({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": tool_call,
            "options": [
                {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "reject-once", "name": "Reject once", "kind": "reject_once"}
            ]
        }
    })
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        reply = json.loads(raw)
        if str(reply.get("id")) == rpc_id:
            outcome = (reply.get("result") or {}).get("outcome") or {}
            return outcome.get("optionId") == "allow-once"
    return False

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
                "authMethods": [
                    {"id": "chatgpt", "name": "Sign in with ChatGPT"},
                    {"id": "api_key", "name": "OpenAI API Key"}
                ]
            }
        })
    elif method == "session/new":
        if not has_auth():
            send({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32000,
                    "message": "Authentication required: run codex login",
                    "data": {"authMethods": ["chatgpt", "api_key"]}
                }
            })
            continue
        session_counter += 1
        send({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "sessionId": f"codex-acp-sess-{session_counter}",
                "modes": {
                    "currentModeId": "auto",
                    "availableModes": [
                        {"id": "read-only", "name": "Read Only"},
                        {"id": "auto", "name": "Auto"}
                    ]
                },
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "gpt-5.3-codex",
                        "options": [
                            {"value": "gpt-5.3-codex", "name": "GPT-5.3 Codex"},
                            {"value": "gpt-5.1-codex-mini", "name": "GPT-5.1 Codex Mini"}
                        ]
                    },
                    {
                        "id": "reasoning_effort",
                        "name": "Reasoning Effort",
                        "category": "reasoning_effort",
                        "type": "select",
                        "currentValue": "high",
                        "options": [
                            {"value": "low", "name": "Low"},
                            {"value": "medium", "name": "Medium"},
                            {"value": "high", "name": "High"},
                            {"value": "xhigh", "name": "Extra High"}
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
        session_id = params.get("sessionId", "codex-acp-sess-1")
        blocks = params.get("prompt") or []
        prompt_text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
        if "Review runtime protocol:" in prompt_text:
            edit_allowed = ask_permission(session_id, {
                "toolCallId": "tc-edit",
                "title": "Edit file",
                "kind": "edit",
                "rawInput": {"path": "README.md"}
            })
            push_allowed = ask_permission(session_id, {
                "toolCallId": "tc-push",
                "title": "Run command",
                "kind": "execute",
                "rawInput": {"command": "git push origin dev"}
            })
            test_allowed = ask_permission(session_id, {
                "toolCallId": "tc-test",
                "title": "Run command",
                "kind": "execute",
                "rawInput": {"command": "cargo test -p ads-acp"}
            })
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tc-test",
                        "title": "Run command",
                        "kind": "execute",
                        "status": "in_progress",
                        "rawInput": {"command": "cargo test -p ads-acp"}
                    }
                }
            })
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "tc-test",
                        "title": "Run command",
                        "kind": "execute",
                        "status": "completed",
                        "rawInput": {"command": "cargo test -p ads-acp"},
                        "rawOutput": {"aggregatedOutput": "test result: ok. 12 passed", "exitCode": 0}
                    }
                }
            })
            verdict = {
                "status": "PASS" if (not edit_allowed and not push_allowed and test_allowed) else "REJECT",
                "summary": f"edit={edit_allowed} push={push_allowed} test={test_allowed}",
                "defects": []
            }
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": json.dumps(verdict)}
                    }
                }
            })
        else:
            send({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": f"{prompt_text} [via-mock-codex-acp]"}
                    }
                }
            })
        send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": "end_turn"}})
    elif req_id is not None:
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})
"#;
    fs::write(&script_path, script).expect("write mock codex-acp");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path).expect("meta").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).expect("chmod");
    }
    script_path
}

#[test]
fn codex_driver_hooks_handle_prefix_alignment_modes_auth_errors_and_tool_plan_normalization() {
    let temp = tempfile::tempdir().expect("tempdir");
    let codex_home = temp.path().join("codex-home");
    let cfg = CodexDriverConfig::default()
        .with_binary("/usr/local/bin/codex-acp")
        .with_codex_home(&codex_home)
        .with_env("BROWSER", "/usr/bin/firefox");
    let driver = CodexDriver::new(cfg.clone());

    let spec = build_codex_launch_spec(
        &cfg,
        &AcpLaunchContext {
            session_key: "s1".to_string(),
            workspace_root: temp.path().to_path_buf(),
            working_directory: None,
            env: HashMap::new(),
        },
    )
    .expect("launch spec");
    assert!(codex_home.is_dir(), "explicit CODEX_HOME must be created");
    assert_eq!(
        spec.env.get("CODEX_HOME").map(String::as_str),
        Some(codex_home.to_string_lossy().as_ref())
    );
    assert!(!spec.env.contains_key("BROWSER"));

    // Model prefix stripping & reasoning effort normalization + mode coercion.
    let modes = SessionModeState {
        current_mode_id: "auto".to_string(),
        available_modes: vec![
            SessionModeInfo {
                id: "read-only".to_string(),
                name: "Read Only".to_string(),
                description: None,
            },
            SessionModeInfo {
                id: "auto".to_string(),
                name: "Auto".to_string(),
                description: None,
            },
        ],
    };
    let options = ConfigOptionsState::from_vec(vec![ConfigOption {
        id: "reasoning_effort".to_string(),
        name: "Reasoning Effort".to_string(),
        description: None,
        category: Some("reasoning_effort".to_string()),
        option_type: "select".to_string(),
        current_value: "medium".to_string(),
        options: vec![ConfigOptionChoice::Value(ConfigOptionValue {
            value: "high".to_string(),
            name: "High".to_string(),
            description: None,
        })],
        extra: Map::new(),
    }]);
    assert!(options.resolve_thought_level().is_some());

    let aligned_plan = driver.resolve_alignment(
        &options,
        Some(&modes),
        DesiredConfigAlignment {
            model: Some("codex:gpt-5.3-codex".to_string()),
            thought_level: Some(" HIGH ".to_string()),
            mode: Some(SessionMode::Plan),
            extra_options: Vec::new(),
        },
    );
    assert_eq!(aligned_plan.model.as_deref(), Some("gpt-5.3-codex"));
    assert_eq!(aligned_plan.thought_level.as_deref(), Some("high"));
    assert_eq!(
        aligned_plan.mode,
        Some(SessionMode::Custom("read-only".to_string()))
    );

    let aligned_edits = driver.resolve_alignment(
        &options,
        Some(&modes),
        DesiredConfigAlignment {
            mode: Some(SessionMode::AcceptEdits),
            ..DesiredConfigAlignment::default()
        },
    );
    assert_eq!(
        aligned_edits.mode,
        Some(SessionMode::Custom("auto".to_string()))
    );

    // Auth RPC error classification.
    let err = driver.map_rpc_error("session/new", -32603, "Not logged in; run codex login", None);
    assert!(err.is_auth_required());

    // Tool call normalization (`cmd` array -> normalized command, cwd, output, exitCode).
    let normalized_tool = driver
        .normalize_session_update(
            "sess-1",
            SessionUpdate::ToolCallUpdate(ToolCallInfo {
                tool_call_id: "tc-1".to_string(),
                title: Some("shell".to_string()),
                kind: None,
                status: Some("completed".to_string()),
                content: Vec::new(),
                locations: Vec::new(),
                raw_input: Some(json!({
                    "cmd": ["cargo", "test", "-p", "ads-acp"],
                    "workdir": "/tmp/ws"
                })),
                raw_output: Some(json!({
                    "stdout": "ok 6 passed",
                    "exit_code": 0
                })),
                extra: Map::new(),
            }),
        )
        .expect("normalized tool");
    match normalized_tool {
        SessionUpdate::ToolCallUpdate(info) => {
            assert_eq!(info.kind.as_deref(), Some("execute"));
            assert_eq!(info.title.as_deref(), Some("cargo test -p ads-acp"));
            assert_eq!(
                info.extra["normalized"]["command"],
                json!("cargo test -p ads-acp")
            );
            assert_eq!(info.extra["normalized"]["cwd"], json!("/tmp/ws"));
            assert_eq!(info.extra["normalized"]["exitCode"], json!(0));
        }
        other => panic!("expected ToolCallUpdate, got {other:?}"),
    }

    // `update_plan` tool call -> `SessionUpdate::Plan`.
    let plan_update = driver
        .normalize_session_update(
            "sess-1",
            SessionUpdate::ToolCall(ToolCallInfo {
                tool_call_id: "plan-1".to_string(),
                title: Some("update_plan".to_string()),
                kind: Some("other".to_string()),
                status: Some("in_progress".to_string()),
                content: Vec::new(),
                locations: Vec::new(),
                raw_input: Some(json!({
                    "plan": [
                        {"step": "Inspect diff", "status": "completed"},
                        {"step": "Run cargo test", "status": "in_progress"}
                    ]
                })),
                raw_output: None,
                extra: Map::new(),
            }),
        )
        .expect("plan update");
    match plan_update {
        SessionUpdate::Plan { entries } => {
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].content, "Inspect diff");
            assert_eq!(entries[0].status.as_deref(), Some("completed"));
            assert_eq!(entries[1].content, "Run cargo test");
            assert_eq!(entries[1].status.as_deref(), Some("in_progress"));
        }
        other => panic!("expected Plan, got {other:?}"),
    }
}

#[tokio::test]
async fn probe_codex_runtime_discovers_models_and_reuses_persisted_auth_without_relogin() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("ws");
    fs::create_dir_all(&workspace).expect("ws");
    let codex_home = temp.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("codex home");
    let mock_bin = write_mock_codex_acp_script(temp.path());

    // 1. Missing binary -> BinaryNotFound.
    let missing_cfg = CodexDriverConfig::default()
        .with_binary(temp.path().join("no-such-codex-acp").to_string_lossy().as_ref());
    let missing = probe_codex_runtime(&missing_cfg, &workspace).await;
    assert_eq!(missing.status, CodexProbeStatus::BinaryNotFound);

    // 2. Unauthenticated CODEX_HOME (no auth.json) -> AuthenticationRequired.
    let cfg = CodexDriverConfig::default()
        .with_binary(mock_bin.to_string_lossy().as_ref())
        .with_codex_home(&codex_home)
        .with_env("OPENAI_API_KEY", "")
        .with_env("CODEX_API_KEY", "");
    let unauth = probe_codex_runtime(&cfg, &workspace).await;
    assert_eq!(unauth.status, CodexProbeStatus::AuthenticationRequired);
    assert!(unauth.models.is_empty());

    // 3. Persist auth.json once in CODEX_HOME -> probe succeeds, discovers models & efforts,
    // reads non-secret auth metadata, and never leaks tokens.
    fs::write(
        codex_home.join("auth.json"),
        r#"{"auth_mode":"chatgpt","account_email":"coder@example.com","tokens":{"access_token":"super-secret-codex-token"}}"#,
    )
    .expect("write auth.json");
    let (auth_mode, email) = read_codex_auth_metadata(&cfg);
    assert_eq!(auth_mode.as_deref(), Some("chatgpt"));
    assert_eq!(email.as_deref(), Some("coder@example.com"));

    let ready1 = probe_codex_runtime(&cfg, &workspace).await;
    assert_eq!(ready1.status, CodexProbeStatus::Ready);
    assert_eq!(ready1.version.as_deref(), Some("0.10.2"));
    assert_eq!(ready1.auth_method.as_deref(), Some("chatgpt"));
    assert_eq!(ready1.account_email.as_deref(), Some("coder@example.com"));
    assert_eq!(ready1.models.len(), 2);
    assert_eq!(ready1.models[0].value, "gpt-5.3-codex");
    assert_eq!(ready1.thought_levels.len(), 4);
    let serialized = serde_json::to_string(&ready1).expect("serialize probe");
    assert!(!serialized.contains("super-secret-codex-token"));

    // 4. Subsequent probe with fresh config pointing at same CODEX_HOME reuses persisted auth.
    let ready2 = probe_codex_runtime(&cfg, &workspace).await;
    assert_eq!(ready2.status, CodexProbeStatus::Ready);
    assert_eq!(ready2.models.len(), 2);
}

#[tokio::test]
async fn acp_reviewer_enforces_read_only_boundaries_and_captures_verification_commands() {
    let temp = tempfile::tempdir().expect("tempdir");
    let repo_path = temp.path().join("repo");
    fs::create_dir_all(&repo_path).expect("repo");
    let codex_home = temp.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("codex home");
    fs::write(
        codex_home.join("auth.json"),
        r#"{"auth_mode":"chatgpt","tokens":{"access_token":"tok"}}"#,
    )
    .expect("auth.json");
    let mock_bin = write_mock_codex_acp_script(temp.path());

    // Direct unit check on ReviewVerificationPermissionHandler.
    let handler = ReviewVerificationPermissionHandler;
    let options = vec![
        PermissionOption {
            option_id: "allow".to_string(),
            name: "Allow".to_string(),
            kind: PermissionOptionKind::AllowOnce,
            extra: Map::new(),
        },
        PermissionOption {
            option_id: "deny".to_string(),
            name: "Deny".to_string(),
            kind: PermissionOptionKind::RejectOnce,
            extra: Map::new(),
        },
    ];
    let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let denied_edit = handler
        .request_permission(
            PendingPermissionRequest {
                request_id: "perm-1".to_string(),
                session_id: "s".to_string(),
                tool_call: ToolCallInfo {
                    tool_call_id: "1".to_string(),
                    title: Some("Edit".to_string()),
                    kind: Some("edit".to_string()),
                    status: None,
                    content: Vec::new(),
                    locations: Vec::new(),
                    raw_input: None,
                    raw_output: None,
                    extra: Map::new(),
                },
                options: options.clone(),
            },
            cancel_rx,
        )
        .await;
    assert_eq!(
        denied_edit,
        PermissionOutcome::Selected {
            option_id: "deny".to_string()
        }
    );

    // End-to-end run_acp_review through CodexDriver + mock-codex-acp.
    let db = StateDb::open(temp.path().join("state.db")).expect("db");
    {
        let mut conn = db.connect().expect("conn");
        let existing_id = get_default_role_profile(&conn, ROLE_REVIEWER)
            .expect("query reviewer role profile")
            .map(|profile| profile.id)
            .unwrap_or_else(|| "reviewer-default".to_string());
        save_role_profile(
            &mut conn,
            SaveRoleProfile {
                id: &existing_id,
                role: ROLE_REVIEWER,
                name: "Reviewer",
                model_id: "gpt-5.3-codex",
                reasoning_effort: "high",
                system_prompt: "Audit changes thoroughly.",
                is_enabled: true,
                is_default: true,
            },
            1_000,
        )
        .expect("role profile");
    }

    let driver: Arc<dyn AcpDriver> = Arc::new(CodexDriver::new(
        CodexDriverConfig::default()
            .with_binary(mock_bin.to_string_lossy().as_ref())
            .with_codex_home(&codex_home),
    ));
    let verification_report = Arc::new(Mutex::new(ReviewVerificationReport::default()));
    let payload = ReviewPayload {
        issue: ReviewIssue {
            id: Some(730),
            title: "Unify Codex on ACP".to_string(),
            description: None,
            acceptance_criteria: None,
        },
        rework_declaration: None,
        diff_range: Some(ReviewDiffRange {
            base_ref: "dev".to_string(),
            head_ref: "feat/730".to_string(),
            base_commit: Some("def456".to_string()),
            head_commit: Some("abc123".to_string()),
            range: "def456..abc123".to_string(),
        }),
        adrs: Some(Vec::new()),
        diff: "diff --git a/a.rs b/a.rs\n+fn ok() {}\n".to_string(),
        diff_stat: Some("a.rs | 1 +".to_string()),
        diff_capture_error: None,
        related_contexts: Some(Vec::new()),
        related_context_omissions: Some(Vec::new()),
        verification_report: None,
    };

    let verdict = run_acp_review(AcpReviewRequest {
        db,
        driver,
        payload,
        repo_path,
        profile_id: None,
        job_id: "job-730".to_string(),
        timeout: Duration::from_secs(30),
        cancellation: Cancellation::new(),
        verification_report: Arc::clone(&verification_report),
    })
    .await
    .expect("acp review verdict");

    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    assert!(verdict.summary.contains("edit=False"));
    assert!(verdict.summary.contains("push=False"));
    assert!(verdict.summary.contains("test=True"));
    let report = verification_report.lock().expect("report lock");
    assert_eq!(report.commands.len(), 1);
    assert_eq!(report.commands[0].command, "cargo test -p ads-acp");
    assert_eq!(report.commands[0].exit_code, 0);
    assert!(report.commands[0].started);
}
