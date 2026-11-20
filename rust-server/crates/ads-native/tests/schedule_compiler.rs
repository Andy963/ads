use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_contract::models::{ModelConfig, ModelProvider};
use ads_native::{ModelResolver, NativeScheduleCompiler, NativeScheduleCompilerOptions};
use ads_runtime::scheduler::{ScheduleCompileRequest, ScheduleCompiler};
use ads_state::{
    CONVERSATION_SERVICE, StateDb, UpstreamCredentialStore, UpstreamCredentials,
    save_model_service, upsert_model_config, upsert_model_provider,
};
use axum::Json;
use axum::Router;
use axum::routing::post;
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::net::TcpListener;

const OWNER: &str = "user-1";
const PEPPER: &str = "schedule-compiler-test-pepper";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn configure_model(db: &StateDb, base_url: &str) {
    let mut connection = db.connect().expect("connection");
    upsert_model_provider(
        &connection,
        &ModelProvider {
            id: "prov-1".to_string(),
            name: "Test".to_string(),
            base_url: base_url.to_string(),
            credential_profile: Some("prov-1".to_string()),
            wire_api: Some("chat".to_string()),
            is_enabled: true,
            updated_at: None,
        },
        now_ms(),
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
        now_ms(),
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

async fn upstream() -> (String, Arc<Mutex<Vec<Value>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<Value>| {
            let captured = Arc::clone(&captured);
            async move {
                captured.lock().expect("requests").push(body);
                Json(json!({
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "content": "```json\n{\"version\":1,\"name\":\"daily-water\",\"enabled\":true,\"schedule\":{\"type\":\"cron\",\"cron\":\"0 9 * * *\",\"timezone\":\"Asia/Shanghai\"},\"instruction\":\"original\",\"delivery\":{\"channels\":[\"web\"],\"web\":{\"audience\":\"owner\"},\"telegram\":{\"chatId\":null}},\"policy\":{\"workspaceWrite\":false,\"network\":\"deny\",\"maxDurationMs\":600000,\"maxRetries\":0,\"concurrencyKey\":\"schedule:{scheduleId}\",\"idempotencyKeyTemplate\":\"sch:{scheduleId}:{runAtIso}\"},\"compiledTask\":{\"title\":\"Remind to drink water\",\"prompt\":\"Return a reminder message.\",\"expectedResultSchema\":{\"type\":\"object\"},\"verification\":{\"commands\":[]}},\"questions\":[]}\n```"
                        },
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind upstream");
    let address = listener.local_addr().expect("upstream address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("http://{address}/v1"), requests)
}

#[tokio::test]
async fn compiles_and_normalizes_a_schedule_spec_with_a_real_upstream() {
    let (base_url, requests) = upstream().await;
    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    configure_model(&db, &base_url);

    let resolver =
        ModelResolver::new(db).with_credential_store(UpstreamCredentialStore::with_pepper(PEPPER));
    let compiler =
        NativeScheduleCompiler::new(resolver).with_options(NativeScheduleCompilerOptions {
            timeout: Duration::from_secs(5),
            max_attempts: 1,
            model: None,
        });
    let workspace_root = workspace.to_string_lossy().to_string();
    let spec = compiler
        .compile(ScheduleCompileRequest {
            owner: OWNER,
            workspace_root: &workspace_root,
            instruction: " 每天 09:00 提醒我喝水 ",
        })
        .await
        .expect("compile");

    assert_eq!(spec.instruction, "每天 09:00 提醒我喝水");
    assert_eq!(spec.schedule.cron, "0 9 * * *");
    assert_eq!(spec.schedule.timezone, "Asia/Shanghai");
    assert!(spec.enabled);
    let captured = requests.lock().expect("requests");
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0]["model"], "fake-model");
    assert_eq!(captured[0]["stream"], false);
    assert!(
        captured[0]["messages"][0]["content"]
            .as_str()
            .expect("prompt")
            .contains("每天 09:00 提醒我喝水")
    );
}
