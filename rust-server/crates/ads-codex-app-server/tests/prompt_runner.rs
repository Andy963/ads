#[cfg(unix)]
#[tokio::test]
async fn runs_a_queued_prompt_through_the_codex_app_server() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{EnqueuePromptInput, HistoryStore, PromptQueueLane, PromptQueueStore, StateDb};
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let entry = {
        let connection = db.connect().expect("connection");
        let store = PromptQueueStore::new(&connection).expect("queue store");
        store
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "prompt-1".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({
                        "text": "probe request",
                        "origin": "agent",
                        "images": [{
                            "name": "probe.png",
                            "mime": "image/png",
                            "data": "data:image/png;base64,iVBORw0KGgo="
                        }]
                    })
                    .as_object()
                    .expect("payload")
                    .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [(
                "ADS_APP_SERVER_PROBE_LOG".to_string(),
                log_path.to_string_lossy().to_string(),
            )]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_for_context = Arc::clone(&events);
    let outcome = runner
        .run_prompt(
            entry,
            PromptRunContext::new(Arc::new(move |event| {
                events_for_context.lock().expect("event lock").push(event);
            })),
        )
        .await
        .expect("prompt run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    {
        let events = events.lock().expect("event lock");
        let user_event = events
            .iter()
            .find(|event| event["type"] == "user")
            .expect("user event");
        assert!(
            user_event["kind"]
                .as_str()
                .is_some_and(|kind| kind.contains("origin=agent"))
        );
        assert!(events.iter().any(|event| event["type"] == "in_flight"));
        let result_event = events
            .iter()
            .find(|event| event["type"] == "result" && event["output"] == "conformance done")
            .expect("result event");
        assert_eq!(result_event["clientMessageId"], "prompt-1");
        if let Some(last_delta) = events.iter().rev().find(|event| event["type"] == "delta") {
            assert_eq!(last_delta["clientMessageId"], "prompt-1");
            assert_eq!(
                result_event["assistantItems"][0]["id"],
                last_delta["assistantItemId"]
            );
        }
    }
    let connection = db.connect().expect("connection");
    let history = HistoryStore::new("web-acopilot", 1_000, 100_000)
        .get(&connection, "user-1::session-1::acopilot")
        .expect("history");
    let user_history = history
        .iter()
        .find(|entry| entry.role == "user")
        .expect("user history");
    assert!(
        user_history
            .kind
            .as_deref()
            .is_some_and(|kind| kind.contains("origin=agent"))
    );
    assert!(
        history
            .iter()
            .any(|entry| entry.role == "assistant" && entry.text == "conformance done")
    );
    drop(connection);
    let rpc_log = std::fs::read_to_string(&log_path).expect("first rpc log");
    let image_path = rpc_log
        .lines()
        .find_map(|line| {
            let message = serde_json::from_str::<Value>(line).ok()?;
            if message["direction"] != "inbound" || message["method"] != "turn/start" {
                return None;
            }
            message["params"]["input"]
                .as_array()?
                .iter()
                .find(|part| part["type"] == "localImage")?["path"]
                .as_str()
                .map(str::to_string)
        })
        .expect("local image input");
    assert!(image_path.contains("/temp/web-images/"));
    assert!(!std::path::Path::new(&image_path).exists());
    drop(runner);

    let second_log = directory.path().join("rpc-second.log");
    let second_entry = {
        let connection = db.connect().expect("connection");
        let store = PromptQueueStore::new(&connection).expect("queue store");
        store
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "prompt-2".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({"text": "resume request", "images": []})
                        .as_object()
                        .expect("payload")
                        .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(2),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let second_runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [(
                "ADS_APP_SERVER_PROBE_LOG".to_string(),
                second_log.to_string_lossy().to_string(),
            )]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });
    let second_outcome = second_runner
        .run_prompt(second_entry, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("second prompt run");
    assert_eq!(
        second_outcome,
        ads_runtime::PromptQueueRunOutcome::success()
    );
    let transcript = std::fs::read_to_string(second_log).expect("second rpc log");
    assert!(transcript.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .is_some_and(|message| message["method"] == "thread/resume")
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn executes_scheduled_prompts_through_the_codex_app_server() {
    use std::os::unix::fs::PermissionsExt;

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_contract::schedule::ScheduleSpec;
    use ads_runtime::scheduler::{ScheduleExecutor, SchedulerExecutionInput, SchedulerJobPayload};
    use ads_state::{HistoryStore, StateDb, StoredSchedule};
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [(
                "ADS_APP_SERVER_PROBE_LOG".to_string(),
                log_path.to_string_lossy().to_string(),
            )]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });

    let spec: ScheduleSpec = serde_json::from_value(json!({
        "version": 1,
        "name": "scheduled conformance",
        "enabled": true,
        "schedule": {
            "type": "cron",
            "cron": "0 9 * * *",
            "timezone": "Asia/Shanghai"
        },
        "instruction": "scheduled prompt",
        "delivery": {
            "channels": ["web"],
            "web": {"audience": "owner"},
            "telegram": {"chatId": null}
        },
        "policy": {
            "workspaceWrite": true,
            "network": "allow",
            "maxDurationMs": 1_800_000,
            "maxRetries": 1,
            "concurrencyKey": "schedule:{scheduleId}",
            "idempotencyKeyTemplate": "sch:{scheduleId}:{runAtIso}"
        },
        "compiledTask": {
            "title": "Scheduled conformance",
            "prompt": "scheduled prompt",
            "expectedResultSchema": {},
            "verification": {"commands": []}
        },
        "questions": []
    }))
    .expect("schedule spec");
    let schedule = StoredSchedule {
        id: "schedule-1".to_string(),
        instruction: "scheduled prompt".to_string(),
        spec,
        enabled: true,
        next_run_at: Some(1),
        lease_owner: None,
        lease_until: None,
        created_at: 1,
        updated_at: 1,
    };
    let input = SchedulerExecutionInput {
        workspace_root: workspace.to_string_lossy().to_string(),
        owner: "scheduler".to_string(),
        schedule,
        payload: SchedulerJobPayload {
            workspace_root: workspace.to_string_lossy().to_string(),
            schedule_id: "schedule-1".to_string(),
            external_id: "external-1".to_string(),
            run_at: 1,
            prompt: Some("scheduled prompt".to_string()),
        },
        prompt: "scheduled prompt".to_string(),
        task_id: "task-1".to_string(),
        task_title: "Scheduled conformance".to_string(),
    };

    let output = runner.execute(input).await.expect("scheduled prompt");
    assert_eq!(output, "conformance done");

    let transcript = std::fs::read_to_string(log_path).expect("rpc log");
    assert!(transcript.lines().any(|line| {
        serde_json::from_str::<Value>(line).is_ok_and(|message| {
            message["direction"] == "inbound"
                && message["method"] == "turn/start"
                && message["params"].to_string().contains("scheduled prompt")
        })
    }));
    let connection = db.connect().expect("connection");
    let history = HistoryStore::new("scheduler", 1_000, 100_000)
        .get(&connection, "external-1")
        .expect("history");
    assert!(history.iter().any(|entry| entry.role == "user"));
    assert!(
        history
            .iter()
            .any(|entry| entry.role == "assistant" && entry.text == "conformance done")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn executes_skill_tool_directives_for_codex_prompts() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{
        EnqueuePromptInput, HistoryStore, PromptQueueLane, PromptQueueStore, StateDb,
        workspace_state_path_in,
    };
    use serde_json::json;
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let entry = {
        let connection = db.connect().expect("connection");
        PromptQueueStore::new(&connection)
            .expect("queue store")
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "cm-codex-directive".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({"text": "remember via codex", "images": []})
                        .as_object()
                        .expect("payload")
                        .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [
                (
                    "ADS_APP_SERVER_PROBE_LOG".to_string(),
                    log_path.to_string_lossy().to_string(),
                ),
                ("ADS_APP_SERVER_PROBE_SIMPLE".to_string(), "1".to_string()),
                (
                    "ADS_APP_SERVER_PROBE_RESPONSE".to_string(),
                    "Before directive\n<<<tool.memory.update op=\"add\">>>\ncodex memory\n>>>\nAfter directive"
                        .to_string(),
                ),
            ]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });
    let outcome = runner
        .run_prompt(entry, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("prompt run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    let connection = db.connect().expect("connection");
    let history = HistoryStore::new("web-acopilot", 1_000, 100_000)
        .get(&connection, "user-1::session-1::acopilot")
        .expect("history");
    let expected = "Before directive\n\nAfter directive\n\ntool.memory.update: ok (add)";
    assert!(
        history
            .iter()
            .any(|entry| entry.role == "assistant" && entry.text == expected)
    );
    let state_dir = db.path().parent().expect("state dir");
    let memory =
        std::fs::read_to_string(workspace_state_path_in(state_dir, &workspace, "memory.md"))
            .expect("memory");
    assert!(memory.contains("codex memory"));
    assert!(log_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn resolves_selected_model_provider_and_injects_codex_options() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_contract::models::{ModelConfig, ModelProvider};
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{
        EnqueuePromptInput, PromptQueueLane, PromptQueueStore, StateDb, UpstreamCredentialStore,
        UpstreamCredentials, upsert_model_config, upsert_model_provider,
    };
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let rpc_log = directory.path().join("rpc.log");
    let args_log = directory.path().join("args.log");
    let key_log = directory.path().join("provider-key.txt");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" > {:?}\nprintf '%s' \"$ADS_CODEX_PROVIDER_API_KEY\" > {:?}\nexec {:?} {:?} \"$@\"\n",
            args_log,
            key_log,
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture,
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    {
        let connection = db.connect().expect("connection");
        upsert_model_provider(
            &connection,
            &ModelProvider {
                id: "provider-1".to_string(),
                name: "Provider One".to_string(),
                base_url: "https://provider.example/v1".to_string(),
                credential_profile: None,
                wire_api: Some("responses".to_string()),
                is_enabled: true,
                updated_at: None,
            },
            1,
        )
        .expect("provider");
        let mut connection = connection;
        upsert_model_config(
            &mut connection,
            &ModelConfig {
                id: "model-config-1".to_string(),
                model_id: "gpt-test".to_string(),
                display_name: "GPT Test".to_string(),
                provider: "cpa".to_string(),
                provider_id: Some("provider-1".to_string()),
                is_enabled: true,
                is_default: false,
                config_json: None,
                updated_at: None,
            },
            1,
        )
        .expect("model config");
        UpstreamCredentialStore::for_state_db(db.path())
            .save(
                &connection,
                "user-1",
                &UpstreamCredentials {
                    base_url: "https://provider.example/v1".to_string(),
                    provider: "cpa".to_string(),
                    api_key: "secret-api-key".to_string(),
                },
                Some("provider-1"),
            )
            .expect("credentials");
    }

    let entry = {
        let connection = db.connect().expect("connection");
        PromptQueueStore::new(&connection)
            .expect("queue store")
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "prompt-provider".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({
                        "text": "provider probe",
                        "model": "model-config-1",
                        "images": []
                    })
                    .as_object()
                    .expect("payload")
                    .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [
                (
                    "ADS_APP_SERVER_PROBE_LOG".to_string(),
                    rpc_log.to_string_lossy().to_string(),
                ),
                ("ADS_APP_SERVER_PROBE_SIMPLE".to_string(), "1".to_string()),
            ]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });

    let outcome = runner
        .run_prompt(entry, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("prompt run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    let app_server_args = std::fs::read_to_string(args_log).expect("app-server args");
    assert!(app_server_args.contains("model_providers.ads-provider-1.name=\"Provider One\""));
    assert!(
        app_server_args
            .contains("model_providers.ads-provider-1.base_url=\"https://provider.example/v1\"")
    );
    assert!(app_server_args.contains("model_provider=\"ads-provider-1\""));
    assert_eq!(
        std::fs::read_to_string(key_log).expect("provider key"),
        "secret-api-key"
    );

    let transcript = std::fs::read_to_string(rpc_log).expect("rpc log");
    let turn_model = transcript
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|message| message["direction"] == "inbound" && message["method"] == "turn/start")
        .and_then(|message| message["params"]["model"].as_str().map(str::to_string))
        .expect("turn model");
    assert_eq!(turn_model, "gpt-test");
}

#[cfg(unix)]
#[tokio::test]
async fn forwards_only_the_new_suffix_of_cumulative_assistant_text() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{EnqueuePromptInput, PromptQueueLane, PromptQueueStore, StateDb};
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture,
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let entry = {
        let connection = db.connect().expect("connection");
        PromptQueueStore::new(&connection)
            .expect("queue store")
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "cumulative-delta".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({"text": "stream probe", "images": []})
                        .as_object()
                        .expect("payload")
                        .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [
                (
                    "ADS_APP_SERVER_PROBE_LOG".to_string(),
                    log_path.to_string_lossy().to_string(),
                ),
                ("ADS_APP_SERVER_PROBE_SIMPLE".to_string(), "1".to_string()),
                (
                    "ADS_APP_SERVER_PROBE_RESPONSE".to_string(),
                    "我先核对".to_string(),
                ),
                (
                    "ADS_APP_SERVER_PROBE_DELTA_PARTS".to_string(),
                    r#"["我","先","核对"]"#.to_string(),
                ),
            ]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_log = Arc::clone(&events);
    let outcome = runner
        .run_prompt(
            entry,
            PromptRunContext::new(Arc::new(move |event| {
                event_log.lock().expect("event log").push(event);
            })),
        )
        .await
        .expect("prompt run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    let deltas = events
        .lock()
        .expect("event log")
        .iter()
        .filter(|event| event["type"] == "delta")
        .filter_map(|event| event["delta"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    assert_eq!(deltas, ["我", "先", "核对"]);
    assert_eq!(deltas.concat(), "我先核对");
}

#[cfg(unix)]
#[tokio::test]
async fn interrupts_a_turn_that_stalls_without_output() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{EnqueuePromptInput, PromptQueueLane, PromptQueueStore, StateDb};
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture,
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let entry = {
        let connection = db.connect().expect("connection");
        PromptQueueStore::new(&connection)
            .expect("queue store")
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: "stalled-turn".to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: "acopilot".to_string(),
                        history_key: "user-1::session-1::acopilot".to_string(),
                        logical_history_key: "user-1::session-1::acopilot".to_string(),
                        lane_namespace: "web-acopilot".to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({"text": "stall probe", "images": []})
                        .as_object()
                        .expect("payload")
                        .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };
    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [
                (
                    "ADS_APP_SERVER_PROBE_LOG".to_string(),
                    log_path.to_string_lossy().to_string(),
                ),
                ("ADS_APP_SERVER_PROBE_STALL".to_string(), "1".to_string()),
            ]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: Some(std::time::Duration::from_millis(80)),
    });

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_log = Arc::clone(&events);
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        runner.run_prompt(
            entry,
            PromptRunContext::new(Arc::new(move |event| {
                event_log.lock().expect("event log").push(event);
            })),
        ),
    )
    .await
    .expect("idle timeout returned promptly")
    .expect("prompt run");
    assert!(!outcome.ok);
    assert!(
        outcome
            .error
            .as_deref()
            .is_some_and(|message| { message.contains("produced no output for 80ms") })
    );
    assert!(events.lock().expect("event log").iter().any(|event| {
        event["type"] == "error"
            && event["message"]
                .as_str()
                .is_some_and(|message| message.contains("produced no output for 80ms"))
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn injects_lane_role_instructions_sandbox_and_tools_and_refreshes_on_prompt_update() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use ads_codex_app_server::{
        CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions, SpawnOptions,
    };
    use ads_runtime::{PromptQueueRunner, PromptRunContext};
    use ads_state::{
        EnqueuePromptInput, PromptQueueLane, PromptQueueStore, StateDb, WEB_ACOPILOT_NAMESPACE,
        WEB_ACTIONS_NAMESPACE,
    };
    use serde_json::{Value, json};
    use tempfile::tempdir;

    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir(&workspace).expect("workspace");
    let log_path = directory.path().join("rpc.log");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/fake-codex-app-server.mjs");
    let wrapper = directory.path().join("fake-codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec {:?} {:?} \"$@\"\n",
            std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
            fixture
        ),
    )
    .expect("wrapper");
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    {
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "UPDATE role_profiles SET system_prompt = 'ACOPILOT_PROMPT_V1' WHERE role = 'acopilot'",
                [],
            )
            .expect("update acopilot v1");
        connection
            .execute(
                "UPDATE role_profiles SET system_prompt = 'REVIEWER_PROMPT_V1' WHERE role = 'reviewer'",
                [],
            )
            .expect("update reviewer v1");
    }

    let enqueue = |client_message_id: &str, namespace: &str, chat_session_id: &str| {
        let connection = db.connect().expect("connection");
        let store = PromptQueueStore::new(&connection).expect("queue store");
        store
            .enqueue(
                EnqueuePromptInput {
                    client_message_id: client_message_id.to_string(),
                    lane: PromptQueueLane {
                        auth_user_id: "user-1".to_string(),
                        session_id: "session-1".to_string(),
                        chat_session_id: chat_session_id.to_string(),
                        history_key: format!("user-1::session-1::{chat_session_id}"),
                        logical_history_key: format!("user-1::session-1::{chat_session_id}"),
                        lane_namespace: namespace.to_string(),
                        lane_generation: 1,
                    },
                    user_id: 42,
                    workspace_root: workspace.to_string_lossy().to_string(),
                    payload: json!({ "text": format!("turn {client_message_id}") })
                        .as_object()
                        .expect("payload")
                        .clone(),
                    retry_failed: false,
                    retry_original: false,
                    created_at: Some(1),
                },
                ads_contract::time::now_unix_millis(),
            )
            .expect("enqueue")
            .entry
    };

    let runner = CodexAppServerPromptRunner::new(CodexAppServerPromptRunnerOptions {
        db: db.clone(),
        daemon_options: SpawnOptions {
            binary: wrapper.to_string_lossy().to_string(),
            env: [(
                "ADS_APP_SERVER_PROBE_LOG".to_string(),
                log_path.to_string_lossy().to_string(),
            )]
            .into_iter()
            .collect(),
            ..SpawnOptions::default()
        },
        history_max_entries_per_session: 1_000,
        history_max_text_length: 100_000,
        action_tools_factory: None,
        turn_idle_timeout: None,
    });

    let acopilot_first = enqueue("acopilot-1", WEB_ACOPILOT_NAMESPACE, "acopilot");
    let outcome = runner
        .run_prompt(acopilot_first, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("acopilot first run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    let actions_first = enqueue("actions-1", WEB_ACTIONS_NAMESPACE, "main");
    let outcome = runner
        .run_prompt(actions_first, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("actions first run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    {
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "UPDATE role_profiles SET system_prompt = 'ACOPILOT_PROMPT_V2' WHERE role = 'acopilot'",
                [],
            )
            .expect("update acopilot v2");
    }
    let acopilot_second = enqueue("acopilot-2", WEB_ACOPILOT_NAMESPACE, "acopilot");
    let outcome = runner
        .run_prompt(acopilot_second, PromptRunContext::new(Arc::new(|_| {})))
        .await
        .expect("acopilot second run");
    assert_eq!(outcome, ads_runtime::PromptQueueRunOutcome::success());

    let rpc_log = std::fs::read_to_string(&log_path).expect("rpc log");
    let messages: Vec<Value> = rpc_log
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();

    let acopilot_start = messages
        .iter()
        .find(|msg| {
            msg["method"] == "thread/start"
                && msg["params"]["developerInstructions"] == "ACOPILOT_PROMPT_V1"
        })
        .expect("acopilot thread/start");
    assert_eq!(acopilot_start["params"]["sandbox"], "workspace-write");
    assert!(
        acopilot_start["params"]["dynamicTools"]
            .as_array()
            .expect("dynamicTools")
            .iter()
            .any(|tool| tool["name"] == "review_action"),
        "acopilot lane should expose review_action"
    );

    let actions_start = messages
        .iter()
        .find(|msg| {
            msg["method"] == "thread/start"
                && msg["params"]["developerInstructions"] == "REVIEWER_PROMPT_V1"
        })
        .expect("actions thread/start");
    assert_eq!(actions_start["params"]["sandbox"], "read-only");
    assert!(
        !actions_start["params"]["dynamicTools"]
            .as_array()
            .expect("dynamicTools")
            .iter()
            .any(|tool| tool["name"] == "review_action"),
        "actions read-only lane must not expose review_action"
    );

    assert!(
        messages.iter().any(|msg| {
            matches!(
                msg["method"].as_str(),
                Some("thread/resume") | Some("thread/start")
            ) && msg["params"]["developerInstructions"] == "ACOPILOT_PROMPT_V2"
        }),
        "updating role_profiles.system_prompt must propagate to subsequent turns: {rpc_log}"
    );
}
