use std::path::{Path, PathBuf};
use std::process::Command;

use ads_state::{
    EnqueuePromptInput, PromptQueueCancelReason, PromptQueueLane, PromptQueueStatus,
    PromptQueueStore, StateDb,
};
use serde_json::{Map, Value, json};
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

fn run_fixture(mode: &str, db_path: &Path) -> Value {
    let output = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(repo_root().join("rust-server/scripts/prompt-queue-fixture.ts"))
        .arg(mode)
        .arg(db_path)
        .current_dir(repo_root())
        .output()
        .expect("run node fixture");
    assert!(
        output.status.success(),
        "fixture {mode} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or_else(|| panic!("fixture {mode} produced no JSON:\n{stdout}"));
    serde_json::from_str(line).expect("fixture json")
}

fn lane() -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: "user-1".to_string(),
        session_id: "session-1".to_string(),
        chat_session_id: "main".to_string(),
        history_key: "user-1::session-1::main".to_string(),
        logical_history_key: "user-1::session-1::main".to_string(),
        lane_namespace: "web-actions".to_string(),
        lane_generation: 1,
    }
}

fn payload(value: Value) -> Map<String, Value> {
    value.as_object().expect("object payload").clone()
}

#[test]
fn typescript_and_rust_share_prompt_queue_rows() {
    let directory = tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");

    let created = run_fixture("create", &db_path);
    let created_entries = created["entries"].as_array().expect("entries");
    assert_eq!(created_entries.len(), 2);
    assert_eq!(created_entries[0]["clientMessageId"], json!("cm-ts-1"));
    assert_eq!(created_entries[0]["status"], json!("queued"));

    let db = StateDb::open(&db_path).expect("rust opens typescript queue");
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    let ts_entries = store.list_logical_lane(&lane()).expect("list ts entries");
    assert_eq!(ts_entries.len(), 2);
    assert_eq!(ts_entries[0].payload["text"], json!("ts first"));
    assert_eq!(ts_entries[1].position, 2);

    let cancelled = store
        .cancel(
            ads_state::CancelPromptInput {
                client_message_id: "cm-ts-2".to_string(),
                lane: lane(),
                user_id: 42,
            },
            150,
        )
        .expect("rust cancels ts prompt");
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.reason, PromptQueueCancelReason::Cancelled);

    store
        .enqueue(
            EnqueuePromptInput {
                client_message_id: "cm-rust-1".to_string(),
                lane: lane(),
                user_id: 42,
                workspace_root: "/work/ads".to_string(),
                payload: payload(json!({ "text": "rust queued", "images": [] })),
                retry_failed: false,
                retry_original: false,
                created_at: Some(200),
            },
            200,
        )
        .expect("rust queued prompt");
    store
        .enqueue(
            EnqueuePromptInput {
                client_message_id: "cm-rust-2".to_string(),
                lane: lane(),
                user_id: 42,
                workspace_root: "/work/ads".to_string(),
                payload: payload(json!({ "text": "rust failed", "images": [] })),
                retry_failed: false,
                retry_original: false,
                created_at: Some(210),
            },
            210,
        )
        .expect("rust failed prompt");
    store
        .claim_ownership("rust-owner", 99, 220, 60_000, |_| true)
        .expect("claim");
    let failed = store
        .get_by_client_message_id("cm-rust-2")
        .expect("get failed prompt")
        .expect("failed prompt");
    store
        .mark_running(failed.id, "rust-owner", 230, 60_000)
        .expect("running");
    store
        .mark_failed(failed.id, "rust failure", "rust-owner", 240)
        .expect("failed");
    drop(connection);
    drop(db);

    let verified = run_fixture("verify", &db_path);
    assert_eq!(verified["cancelled"], json!("cancelled"));
    let verify_entries = verified["entries"].as_array().expect("entries");
    assert!(
        verify_entries
            .iter()
            .any(|entry| entry["clientMessageId"] == json!("cm-ts-after"))
    );

    let db = StateDb::open(&db_path).expect("reopen");
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    let after = store
        .get_by_client_message_id("cm-ts-after")
        .expect("get ts-after")
        .expect("ts-after visible to rust");
    assert_eq!(after.status, PromptQueueStatus::Queued);
    assert_eq!(after.payload["text"], json!("after rust"));
    assert_eq!(after.created_at, 300);
    assert!(
        store
            .get_by_client_message_id("cm-ts-2")
            .expect("get cancelled")
            .is_none()
    );
}
