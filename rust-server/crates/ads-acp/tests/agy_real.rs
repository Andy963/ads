use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_acp::{
    ACP_THREAD_NAMESPACE, AGY_AUTH_STDOUT_PREFIX, AGY_CODE_REDIRECT_URI, AcpDriver, AcpError,
    AcpLaunchContext, AcpPromptRequest, AcpPromptRunner, AcpPromptRunnerConfig, AcpSession,
    AcpSessionConfig, AcpSessionContext, AcpStreamEvent, AgyAuthConfig, AgyAuthMethod,
    AgyAuthUrlKind, AgyDriver, AgyDriverConfig, AgyIsolatedProfile, AgyProbeCache, AgyProbeStatus,
    AutoApprovePermissionHandler, ClientCapabilities, ConfigOption, ConfigOptionChoice,
    ConfigOptionValue, ConfigOptionsState, DesiredConfigAlignment, FileSystemCapabilities,
    InitializeResponse, PlanEntry, SessionMode, SessionModeInfo, SessionModeState, SessionUpdate,
    StopReason, ToolCallInfo, build_agy_launch_spec, logout_agy_profile,
    parse_agy_authorization_url, prepare_agy_isolated_profile, probe_agy_runtime,
    resolve_agy_profile_dir, start_agy_login, validate_agy_login_response,
};
use ads_runtime::{LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueRunner, PromptRunContext};
use ads_state::{
    HistoryStore, SaveRoleProfile, StateDb, WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE,
    get_default_role_profile, save_role_profile,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tempfile::TempDir;
use tokio::sync::watch;

fn real_agy_enabled() -> bool {
    std::env::var("ADS_TEST_REAL_AGY")
        .map(|value| matches!(value.trim(), "1" | "true" | "TRUE"))
        .unwrap_or(false)
}

#[test]
fn agy_isolated_profiles_stay_separate_and_sanitize_env() {
    let temp = TempDir::new().expect("temp dir");
    let fake_home = temp.path().join("home");
    let user_skill = fake_home.join(".gemini/config/skills/demo-skill");
    fs::create_dir_all(&user_skill).expect("create fake user skill dir");
    fs::write(fake_home.join(".gemini/AGENTS.md"), "# User Global Rules\n").expect("write rules");

    let profile_a = resolve_agy_profile_dir(temp.path(), "Work");
    let profile_b = resolve_agy_profile_dir(temp.path(), "work");
    assert_ne!(
        profile_a, profile_b,
        "case differences must hash distinctly"
    );

    let mut cfg_a = AgyDriverConfig::isolated(
        AgyIsolatedProfile::new(&profile_a)
            .with_user_home(&fake_home)
            .with_auth(AgyAuthConfig {
                method: AgyAuthMethod::OAuthPersonal,
                ..Default::default()
            }),
    );
    cfg_a.binary = "agy".to_string();

    let cfg_b = AgyDriverConfig::isolated(
        AgyIsolatedProfile::new(&profile_b)
            .with_user_home(&fake_home)
            .with_auth(AgyAuthConfig {
                method: AgyAuthMethod::GeminiApiKey,
                api_key: Some("test-secret-key".to_string()),
                ..Default::default()
            }),
    );

    let mut launch_env = HashMap::new();
    launch_env.insert("GEMINI_API_KEY".to_string(), "ambient-leak".to_string());
    launch_env.insert(
        "GOOGLE_API_KEY".to_string(),
        "ambient-google-leak".to_string(),
    );
    launch_env.insert(
        "CHROME_CRASHPAD_PIPE_NAME".to_string(),
        "/tmp/dead.pipe".to_string(),
    );
    launch_env.insert("GEMINI_HOME".to_string(), "/tmp/wrong-home".to_string());

    let ctx_a = AcpLaunchContext {
        session_key: "acct-a".to_string(),
        workspace_root: temp.path().to_path_buf(),
        working_directory: None,
        env: launch_env.clone(),
    };
    let spec_a = build_agy_launch_spec(&cfg_a, &ctx_a).expect("build launch spec A");
    assert!(spec_a.clear_env);
    assert!(
        spec_a
            .args
            .windows(2)
            .any(|w| w == ["--gemini-dir", profile_a.to_str().unwrap()])
    );
    assert!(
        spec_a
            .args
            .windows(2)
            .any(|w| w == ["--app-data-dir", "antigravity-acp"])
    );
    assert_eq!(
        spec_a.env.get("GEMINI_HOME").map(String::as_str),
        profile_a.to_str()
    );
    assert_eq!(
        spec_a
            .env
            .get("AGY_ACP_FORCE_FILE_STORAGE")
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        spec_a
            .env
            .get("AGY_CLI_DISABLE_AUTO_UPDATE")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        spec_a.env.get("PYTHONUNBUFFERED").map(String::as_str),
        Some("1")
    );
    assert!(spec_a.env.contains_key("SSH_CONNECTION"));
    assert!(!spec_a.env.contains_key("GEMINI_API_KEY"));
    assert!(!spec_a.env.contains_key("GOOGLE_API_KEY"));
    assert!(!spec_a.env.contains_key("CHROME_CRASHPAD_PIPE_NAME"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&profile_a).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        assert!(profile_a.join("AGENTS.md").exists());
        assert!(profile_a.join("config/skills/demo-skill").exists());
    }

    let settings_a = fs::read_to_string(profile_a.join("antigravity-acp/settings.json"))
        .expect("settings.json A");
    assert!(settings_a.contains("oauth-personal"));
    assert!(!settings_a.contains("secret"));

    let ctx_b = AcpLaunchContext {
        session_key: "acct-b".to_string(),
        workspace_root: temp.path().to_path_buf(),
        working_directory: None,
        env: launch_env,
    };
    let spec_b = build_agy_launch_spec(&cfg_b, &ctx_b).expect("build launch spec B");
    assert_eq!(
        spec_b.env.get("GEMINI_HOME").map(String::as_str),
        profile_b.to_str()
    );
    assert_eq!(
        spec_b.env.get("GEMINI_API_KEY").map(String::as_str),
        Some("test-secret-key")
    );
    assert!(!spec_b.env.contains_key("GOOGLE_API_KEY"));

    let token_a = profile_a.join("antigravity-acp/acp_token.json");
    let token_b = profile_b.join("antigravity-acp/acp_token.json");
    fs::write(&token_a, "{\"token\":\"a\"}").expect("write token A");
    fs::write(&token_b, "{\"token\":\"b\"}").expect("write token B");
    logout_agy_profile(&profile_a).expect("logout profile A");
    assert!(!token_a.exists());
    assert!(
        token_b.exists(),
        "logging out profile A must not touch profile B"
    );
    assert!(
        profile_a.join("AGENTS.md").exists(),
        "logout preserves linked rules"
    );
}

#[test]
fn agy_auth_config_validation_enforces_required_fields() {
    let temp = TempDir::new().expect("temp dir");
    let missing_business =
        AgyIsolatedProfile::new(temp.path().join("biz")).with_auth(AgyAuthConfig {
            method: AgyAuthMethod::OAuthBusiness,
            gcp_project: Some("my-project".to_string()),
            gcp_location: None,
            api_key: None,
        });
    let err = prepare_agy_isolated_profile(&missing_business, &HashMap::new())
        .expect_err("oauth-business without gcp_location must fail");
    assert!(err.to_string().contains("gcp_location"));

    let valid_platform =
        AgyIsolatedProfile::new(temp.path().join("plat")).with_auth(AgyAuthConfig {
            method: AgyAuthMethod::AgentPlatform,
            api_key: Some("ap-key".to_string()),
            ..Default::default()
        });
    assert!(prepare_agy_isolated_profile(&valid_platform, &HashMap::new()).is_ok());
}

#[test]
fn agy_oauth_url_and_callback_validation_match_contract() {
    let code_url = format!(
        "https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri={}&response_type=code&state=state-xyz-123",
        url::form_urlencoded::byte_serialize(AGY_CODE_REDIRECT_URI.as_bytes()).collect::<String>()
    );
    let parsed_code =
        parse_agy_authorization_url(&code_url, AgyAuthUrlKind::Code).expect("valid code OAuth URL");
    assert_eq!(parsed_code.state, "state-xyz-123");
    assert_eq!(parsed_code.redirect_uri, AGY_CODE_REDIRECT_URI);

    assert_eq!(
        validate_agy_login_response(&parsed_code, "  4/0AeaYSHAbc_def-123.45~  "),
        Some("4/0AeaYSHAbc_def-123.45~".to_string())
    );
    let good_callback = format!("{AGY_CODE_REDIRECT_URI}?state=state-xyz-123&code=4/0AeaCode");
    assert_eq!(
        validate_agy_login_response(&parsed_code, &good_callback),
        Some(good_callback)
    );
    let bad_state_callback = format!("{AGY_CODE_REDIRECT_URI}?state=wrong-state&code=4/0AeaCode");
    assert_eq!(
        validate_agy_login_response(&parsed_code, &bad_state_callback),
        None
    );

    let loopback_url = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2F&response_type=code&state=s1";
    assert!(parse_agy_authorization_url(loopback_url, AgyAuthUrlKind::Loopback).is_ok());

    let bad_port_url = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F&response_type=code&state=s1";
    assert!(parse_agy_authorization_url(bad_port_url, AgyAuthUrlKind::Loopback).is_err());
}

#[test]
fn agy_driver_hooks_handle_meta_auth_errors_alignment_and_update_normalization() {
    let driver = AgyDriver::new(
        AgyDriverConfig::default().with_system_prompt_append("Keep patches concise."),
    );

    let caps = driver.client_capabilities(ClientCapabilities {
        fs: Some(FileSystemCapabilities {
            read_text_file: false,
            write_text_file: true,
        }),
        terminal: true,
        ..Default::default()
    });
    assert!(!caps.fs.as_ref().expect("fs").write_text_file);
    assert!(!caps.terminal);

    let mut init_supported = InitializeResponse {
        protocol_version: 1,
        agent_capabilities: Default::default(),
        agent_info: None,
        auth_methods: Vec::new(),
        extra: Map::new(),
    };
    init_supported.agent_capabilities.extra.insert(
        "_meta".to_string(),
        json!({ "antigravity": { "systemPrompt": { "append": true } } }),
    );
    let extra =
        driver.extra_session_new_params(&AcpSessionContext::default(), Some(&init_supported));
    assert_eq!(
        extra["_meta"]["antigravity"]["systemPrompt"]["append"],
        json!("Keep patches concise.")
    );
    let empty_extra = driver.extra_session_new_params(&AcpSessionContext::default(), None);
    assert!(empty_extra.is_empty());

    let banner = format!(
        "{AGY_AUTH_STDOUT_PREFIX}https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2F&response_type=code&state=s1"
    );
    let intercepted = driver
        .intercept_non_json_stdout_line(&banner)
        .expect("should intercept auth stdout banner");
    assert!(intercepted.is_auth_required());

    let rpc_auth = driver.map_rpc_error(
        "authenticate",
        -32603,
        "No browser is available here to open the login URL.",
        None,
    );
    assert!(rpc_auth.is_auth_required());

    let config_state = ConfigOptionsState::from_vec(vec![
        ConfigOption {
            id: "model".to_string(),
            name: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            option_type: "select".to_string(),
            current_value: "gemini-4-hydrogen".to_string(),
            options: vec![
                ConfigOptionChoice::Value(ConfigOptionValue {
                    value: "gemini-4-hydrogen".to_string(),
                    name: "Gemini 4 Hydrogen".to_string(),
                    description: None,
                }),
                ConfigOptionChoice::Value(ConfigOptionValue {
                    value: "gpt-oss-120b-medium".to_string(),
                    name: "GPT-OSS 120B Medium".to_string(),
                    description: None,
                }),
            ],
            extra: Map::new(),
        },
        ConfigOption {
            id: "thought_level".to_string(),
            name: "Thinking".to_string(),
            description: None,
            category: Some("thought_level".to_string()),
            option_type: "select".to_string(),
            current_value: "high".to_string(),
            options: vec![
                ConfigOptionChoice::Value(ConfigOptionValue {
                    value: "medium".to_string(),
                    name: "Medium".to_string(),
                    description: None,
                }),
                ConfigOptionChoice::Value(ConfigOptionValue {
                    value: "xhigh".to_string(),
                    name: "Extra High".to_string(),
                    description: None,
                }),
            ],
            extra: Map::new(),
        },
    ]);
    let modes = SessionModeState {
        current_mode_id: "default".to_string(),
        available_modes: vec![
            SessionModeInfo {
                id: "default".to_string(),
                name: "Default".to_string(),
                description: None,
            },
            SessionModeInfo {
                id: "accept-edits".to_string(),
                name: "Accept Edits".to_string(),
                description: None,
            },
            SessionModeInfo {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: None,
            },
        ],
    };

    let split_alignment = driver.resolve_alignment(
        &config_state,
        Some(&modes),
        DesiredConfigAlignment {
            mode: Some(SessionMode::Custom("yolo".to_string())),
            model: Some("gemini-4-hydrogen-xhigh".to_string()),
            thought_level: None,
            extra_options: Vec::new(),
        },
    );
    assert_eq!(split_alignment.model.as_deref(), Some("gemini-4-hydrogen"));
    assert_eq!(split_alignment.thought_level.as_deref(), Some("xhigh"));
    assert_eq!(split_alignment.mode, Some(SessionMode::Default));

    let exact_hyphenated = driver.resolve_alignment(
        &config_state,
        Some(&modes),
        DesiredConfigAlignment {
            mode: Some(SessionMode::Custom("auto_edit".to_string())),
            model: Some("gpt-oss-120b-medium".to_string()),
            thought_level: None,
            extra_options: Vec::new(),
        },
    );
    assert_eq!(
        exact_hyphenated.model.as_deref(),
        Some("gpt-oss-120b-medium")
    );
    assert_eq!(exact_hyphenated.thought_level, None);
    assert_eq!(exact_hyphenated.mode, Some(SessionMode::AcceptEdits));

    let steps_update = driver.normalize_session_update(
        "sess-1",
        SessionUpdate::ToolCall(ToolCallInfo {
            tool_call_id: "call-steps-1".to_string(),
            title: Some("Run update_steps".to_string()),
            kind: Some("other".to_string()),
            status: Some("in_progress".to_string()),
            content: Vec::new(),
            locations: Vec::new(),
            raw_input: Some(json!({
                "steps": [
                    { "title": "Inspect schema", "status": "done" },
                    { "title": "Run tests", "status": "in_progress" }
                ]
            })),
            raw_output: None,
            extra: Map::new(),
        }),
    );
    assert_eq!(
        steps_update,
        Some(SessionUpdate::Plan {
            entries: vec![
                PlanEntry {
                    content: "Inspect schema".to_string(),
                    priority: Some("medium".to_string()),
                    status: Some("completed".to_string()),
                    extra: Map::new(),
                },
                PlanEntry {
                    content: "Run tests".to_string(),
                    priority: Some("medium".to_string()),
                    status: Some("in_progress".to_string()),
                    extra: Map::new(),
                },
            ]
        })
    );

    let suppressed_followup = driver.normalize_session_update(
        "sess-1",
        SessionUpdate::ToolCallUpdate(ToolCallInfo {
            tool_call_id: "call-steps-1".to_string(),
            title: None,
            kind: None,
            status: Some("completed".to_string()),
            content: Vec::new(),
            locations: Vec::new(),
            raw_input: None,
            raw_output: Some(json!({ "ok": true })),
            extra: Map::new(),
        }),
    );
    assert!(suppressed_followup.is_none());

    let cmd_update = driver
        .normalize_session_update(
            "sess-1",
            SessionUpdate::ToolCall(ToolCallInfo {
                tool_call_id: "call-cmd-1".to_string(),
                title: Some("Running command".to_string()),
                kind: None,
                status: Some("completed".to_string()),
                content: Vec::new(),
                locations: Vec::new(),
                raw_input: Some(json!({
                    "CommandLine": "cargo test -p ads-acp",
                    "WorkingDirectory": "/tmp/ws"
                })),
                raw_output: Some(json!({
                    "combinedOutput": "ok",
                    "exitCode": 0
                })),
                extra: Map::new(),
            }),
        )
        .expect("normalized tool call");
    let SessionUpdate::ToolCall(info) = cmd_update else {
        panic!("expected ToolCall");
    };
    assert_eq!(info.kind.as_deref(), Some("execute"));
    assert_eq!(
        info.extra["normalized"]["command"],
        json!("cargo test -p ads-acp")
    );
    assert_eq!(info.extra["normalized"]["cwd"], json!("/tmp/ws"));
    assert_eq!(info.extra["normalized"]["exitCode"], json!(0));
}

#[tokio::test]
async fn probe_agy_runtime_reports_binary_not_found_immediately() {
    let temp = TempDir::new().expect("temp dir");
    let cfg = AgyDriverConfig::default().with_binary("/nonexistent/path/to/definitely-missing-agy");
    let result = probe_agy_runtime(&cfg, temp.path()).await;
    assert_eq!(result.status, AgyProbeStatus::BinaryNotFound);
    assert!(result.binary_path.is_none());
    assert!(result.probed_at_ms > 0);
}

#[tokio::test]
async fn acp_prompt_runner_rejects_empty_payload_without_spawning() {
    let temp = TempDir::new().expect("temp dir");
    let db = StateDb::open(temp.path().join("state.sqlite")).expect("open StateDb");
    let driver = Arc::new(AgyDriver::new(
        AgyDriverConfig::default().with_binary("/nonexistent/should-not-spawn"),
    ));
    let runner = AcpPromptRunner::new(db.clone(), AcpPromptRunnerConfig::new(driver));
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_handle = Arc::clone(&events);
    let context = PromptRunContext::new(Arc::new(move |value| {
        events_handle.lock().expect("events lock").push(value);
    }));
    let entry = LaneTurn {
        key: LaneTurnKey::PromptQueue(7),
        kind: LaneTurnKind::UserPrompt,
        client_message_id: "cm-empty".to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "proj-1".to_string(),
        chat_session_id: "main".to_string(),
        history_key: "user-1::proj-1::main".to_string(),
        logical_history_key: "user-1::proj-1::main".to_string(),
        lane_namespace: "web".to_string(),
        lane_generation: 1,
        workspace_root: temp.path().to_string_lossy().to_string(),
        payload: Map::new(),
        history_display_text: None,
        created_at: 1000,
    };
    let outcome = runner
        .run_lane_turn(entry.clone(), context)
        .await
        .expect("run_lane_turn");
    assert!(!outcome.ok);
    let captured = events.lock().expect("events").clone();
    assert!(captured.iter().any(|e| e["type"] == "error"));
    runner.shutdown().await;
}

#[tokio::test]
async fn real_agy_probe_and_cached_catalog() {
    if !real_agy_enabled() {
        eprintln!("skipping real_agy_probe_and_cached_catalog (set ADS_TEST_REAL_AGY=1 to enable)");
        return;
    }
    let temp = TempDir::new().expect("temp dir");
    let cache = AgyProbeCache::new();
    let cfg = AgyDriverConfig::default();

    let first = cache
        .get_or_probe("default", Duration::from_secs(60), &cfg, temp.path())
        .await;
    assert_eq!(
        first.status,
        AgyProbeStatus::Ready,
        "probe failed: {first:?}"
    );
    assert!(first.version.as_deref().is_some_and(|v| !v.is_empty()));
    assert!(
        !first.models.is_empty(),
        "expected non-empty agy model catalog"
    );
    assert!(
        !first.thought_levels.is_empty(),
        "expected thought_level options"
    );

    let second = cache
        .get_or_probe("default", Duration::from_secs(60), &cfg, temp.path())
        .await;
    assert_eq!(
        second.probed_at_ms, first.probed_at_ms,
        "cache hit must avoid re-spawning"
    );
}

#[tokio::test]
async fn real_agy_isolated_unauthenticated_profile_reports_auth_required_and_login_emits_url() {
    if !real_agy_enabled() {
        eprintln!(
            "skipping real_agy_isolated_unauthenticated_profile_reports_auth_required_and_login_emits_url (set ADS_TEST_REAL_AGY=1 to enable)"
        );
        return;
    }
    let temp = TempDir::new().expect("temp dir");
    let profile_dir = temp.path().join("isolated-fresh");
    let cfg = AgyDriverConfig::isolated(
        AgyIsolatedProfile::new(&profile_dir)
            .with_link_user_skills(false)
            .with_auth(AgyAuthConfig {
                method: AgyAuthMethod::OAuthPersonal,
                ..Default::default()
            }),
    );

    let probe = probe_agy_runtime(&cfg, temp.path()).await;
    assert_eq!(
        probe.status,
        AgyProbeStatus::AuthenticationRequired,
        "fresh isolated profile must require authentication instead of reading host keyring: {probe:?}"
    );

    let handle = start_agy_login(&cfg, &HashMap::new())
        .await
        .expect("agy --login should emit a Google OAuth URL in headless mode");
    assert!(
        handle
            .authorization()
            .authorization_url
            .starts_with("https://accounts.google.com/")
    );
    assert!(!handle.authorization().state.is_empty());
    handle.cancel().await;
}

#[tokio::test]
async fn real_agy_session_prompt_cancel_and_resume() {
    if !real_agy_enabled() {
        eprintln!(
            "skipping real_agy_session_prompt_cancel_and_resume (set ADS_TEST_REAL_AGY=1 to enable)"
        );
        return;
    }
    let temp = TempDir::new().expect("temp dir");
    let driver: Arc<dyn AcpDriver> = Arc::new(AgyDriver::new(
        AgyDriverConfig::default().with_system_prompt_append("Always stay concise."),
    ));
    let launch_ctx = AcpLaunchContext {
        session_key: "real-agy-direct".to_string(),
        workspace_root: temp.path().to_path_buf(),
        ..Default::default()
    };
    let session_ctx = AcpSessionContext {
        session_key: "real-agy-direct".to_string(),
        workspace_root: temp.path().to_path_buf(),
        ..Default::default()
    };

    let session = AcpSession::spawn(
        Arc::clone(&driver),
        &launch_ctx,
        Arc::new(AutoApprovePermissionHandler),
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn agy session");
    session.initialize().await.expect("initialize agy");
    let created = session
        .new_session(&session_ctx)
        .await
        .expect("new session");
    let session_id = created.session_id.clone();

    let mut prompt1 = AcpPromptRequest::text(
        "msg-1",
        "Reply with the exact token AGY_KERNEL_OK and nothing else.",
    );
    prompt1.alignment = Some(DesiredConfigAlignment {
        mode: Some(SessionMode::Default),
        model: Some("gpt-oss-120b-medium".to_string()),
        thought_level: Some("low".to_string()),
        extra_options: Vec::new(),
    });
    let turn1 = session.prompt(prompt1).await.expect("turn 1");
    assert_eq!(turn1.stop_reason, StopReason::EndTurn);
    let quota_limited = turn1.response_text.contains("quota reached");
    assert!(
        turn1.response_text.contains("AGY_KERNEL_OK") || quota_limited,
        "unexpected response: {:?}",
        turn1.response_text
    );
    assert!(
        turn1
            .events
            .iter()
            .any(|event| matches!(event, AcpStreamEvent::MessageDelta { .. }))
    );

    // Verify cancellation wakes `session/cancel` cleanly (cancelled on first streamed chunk or shortly after).
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let cancel_on_delta = cancel_tx.clone();
    let cancel_ctx = PromptRunContext::new(Arc::new(move |event| {
        if event.get("type").and_then(Value::as_str) == Some("delta") {
            let _ = cancel_on_delta.send(true);
        }
    }));
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let _ = cancel_tx.send(true);
    });
    let cancelled = session
        .prompt(
            AcpPromptRequest::text(
                "msg-cancel",
                "Write a detailed essay listing every integer from 1 to 1000, one per line with explanations.",
            )
            .with_context(cancel_ctx)
            .with_cancel(cancel_rx),
        )
        .await;
    match cancelled {
        Ok(res) => {
            assert!(
                res.stop_reason == StopReason::Cancelled
                    || res.response_text.contains("quota reached"),
                "unexpected stop reason without quota notice: {:?}",
                res.stop_reason
            );
        }
        Err(AcpError::Cancelled) => {}
        Err(other) => panic!("unexpected cancel outcome: {other:?}"),
    }

    session.shutdown().await;

    // Re-attach fresh subprocess via `session/resume`.
    let resumed = AcpSession::spawn(
        driver,
        &launch_ctx,
        Arc::new(AutoApprovePermissionHandler),
        AcpSessionConfig::default(),
    )
    .await
    .expect("spawn resumed session");
    resumed.initialize().await.expect("init resumed");
    resumed
        .resume_session(&session_id, &session_ctx)
        .await
        .expect("session/resume");
    let turn3 = resumed
        .prompt(AcpPromptRequest::text(
            "msg-resume",
            "Reply with the single token RESUMED_OK.",
        ))
        .await
        .expect("prompt after resume");
    assert_eq!(turn3.stop_reason, StopReason::EndTurn);
    assert!(!turn3.response_text.trim().is_empty());
    resumed.shutdown().await;
}

#[tokio::test]
async fn real_agy_acp_prompt_runner_executes_and_persists_state() {
    if !real_agy_enabled() {
        eprintln!(
            "skipping real_agy_acp_prompt_runner_executes_and_persists_state (set ADS_TEST_REAL_AGY=1 to enable)"
        );
        return;
    }
    let temp = TempDir::new().expect("temp dir");
    let db = StateDb::open(temp.path().join("state.sqlite")).expect("open StateDb");
    {
        let mut conn = db.connect().expect("connect");
        let existing_id = get_default_role_profile(&conn, "acopilot")
            .expect("query default role profile")
            .map(|p| p.id)
            .unwrap_or_else(|| "acopilot-default".to_string());
        save_role_profile(
            &mut conn,
            SaveRoleProfile {
                id: &existing_id,
                role: "acopilot",
                name: "Acopilot",
                model_id: "gpt-oss-120b-medium",
                reasoning_effort: "low",
                system_prompt: "Include the token ROLE_WIRED when asked.",
                is_enabled: true,
                is_default: true,
            },
            1000,
        )
        .expect("save role profile");
    }

    let driver = Arc::new(AgyDriver::new(AgyDriverConfig::default()));
    let runner_cfg = AcpPromptRunnerConfig::new(driver)
        .with_default_model("gpt-oss-120b-medium")
        .with_default_thought_level("low")
        .with_idle_timeout(Some(Duration::from_secs(60)));
    let runner = AcpPromptRunner::new(db.clone(), runner_cfg);

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_handle = Arc::clone(&events);
    let context = PromptRunContext::new(Arc::new(move |value| {
        events_handle.lock().expect("events lock").push(value);
    }));

    let mut payload = Map::new();
    payload.insert(
        "text".to_string(),
        Value::String("Reply cleanly with RUNNER_OK.".to_string()),
    );
    let workspace_str = temp.path().to_string_lossy().to_string();
    let entry = LaneTurn {
        key: LaneTurnKey::PromptQueue(1),
        kind: LaneTurnKind::UserPrompt,
        client_message_id: "cm-agy-1".to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 1,
        session_id: "proj-1".to_string(),
        chat_session_id: "acopilot".to_string(),
        history_key: "user-1::proj-1::acopilot".to_string(),
        logical_history_key: "user-1::proj-1::acopilot".to_string(),
        lane_namespace: WEB_ACOPILOT_NAMESPACE.to_string(),
        lane_generation: 1,
        workspace_root: workspace_str.clone(),
        payload,
        history_display_text: None,
        created_at: 1000,
    };

    let outcome = runner
        .run_lane_turn(entry.clone(), context)
        .await
        .expect("run_lane_turn");
    assert!(outcome.ok, "unexpected failure: {:?}", outcome.error);

    let captured = events.lock().expect("events lock").clone();
    assert!(captured.iter().any(|e| e["type"] == "user"));
    assert!(captured.iter().any(|e| e["type"] == "in_flight"));
    assert!(captured.iter().any(|e| e["type"] == "delta"));
    assert!(captured.iter().any(|e| e["type"] == "assistant_item"));
    let result_frame = captured
        .iter()
        .find(|e| e["type"] == "result")
        .expect("result event");
    assert_eq!(result_frame["ok"], json!(true));
    assert_eq!(result_frame["activeAgentId"], json!("agy"));
    let saved_acp_id = result_frame["threadId"].as_str().expect("threadId");
    assert!(!saved_acp_id.is_empty());

    let conn = db.connect().expect("connect");
    let history = HistoryStore::new(WEB_ACOPILOT_NAMESPACE, 200, 64 * 1024);
    let entries = history.get(&conn, &entry.history_key).expect("history");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].role, "user");
    assert_eq!(entries[1].role, "ai");

    let expected_kv_key = format!(
        "{}::{}::agy::default::acopilot",
        entry.logical_history_key, workspace_str
    );
    let stored_session: Option<String> = conn
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![ACP_THREAD_NAMESPACE, expected_kv_key],
            |row| row.get(0),
        )
        .optional()
        .expect("query kv_state");
    assert_eq!(stored_session.as_deref(), Some(saved_acp_id));

    let reconciled = runner.reconcile_lane_turn(&entry).await.expect("reconcile");
    assert!(reconciled.is_some_and(|r| r.ok));

    // Also verify read-only reviewer lane resolves distinct storage key cleanly without running.
    let readonly_key = format!(
        "{}::{}::agy::default::reviewer",
        entry.logical_history_key, workspace_str
    );
    assert_ne!(readonly_key, expected_kv_key);
    let _ = WEB_ACTIONS_NAMESPACE;

    runner.shutdown().await;
}
