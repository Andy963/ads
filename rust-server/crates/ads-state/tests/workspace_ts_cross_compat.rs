use std::path::{Path, PathBuf};
use std::process::Command;

use ads_contract::native_transcript::NativeTranscriptTurnStatus;
use ads_contract::schedule::ScheduleSpec;
use ads_state::{
    AttachmentStore, BeginNativeTurn, CreateImageAttachment, CreateSchedule, InsertScheduleRun,
    NativeTranscriptStore, ScheduleRunStatus, ScheduleStore, StateDb, WorkspaceDb,
    derive_workspace_state_id,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

fn run_fixture(script: &str, mode: &str, db_path: &Path, workspace_root: &Path) -> Value {
    let output = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(repo_root().join(script))
        .arg(mode)
        .arg(db_path)
        .arg(workspace_root)
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

fn rust_spec(name: &str) -> ScheduleSpec {
    let spec: ScheduleSpec = serde_json::from_value(json!({
        "version": 1,
        "name": name,
        "enabled": true,
        "schedule": { "type": "cron", "cron": "0 9 * * *", "timezone": "Asia/Shanghai" },
        "instruction": "summarize the inbox",
        "delivery": {
            "channels": ["web"],
            "web": { "audience": "owner" },
            "telegram": { "chatId": null }
        },
        "policy": {
            "workspaceWrite": false,
            "network": "deny",
            "maxDurationMs": 60000,
            "maxRetries": 1,
            "concurrencyKey": "inbox",
            "idempotencyKeyTemplate": "inbox-{runAt}"
        },
        "compiledTask": {
            "title": "Inbox summary",
            "prompt": "Summarize the inbox",
            "expectedResultSchema": { "type": "object" },
            "verification": { "commands": ["true"] }
        },
        "questions": []
    }))
    .expect("spec");
    spec.validate().expect("valid spec");
    spec
}

#[test]
fn typescript_and_rust_share_schedule_and_run_rows() {
    let directory = tempdir().expect("temp dir");
    let workspace_root = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace root");
    let db_path = directory.path().join("ads.db");
    let workspace_id = derive_workspace_state_id(&workspace_root);

    let db = WorkspaceDb::open(&db_path).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = ScheduleStore::new(&connection, &workspace_id);
    let schedule = store
        .create_schedule(
            CreateSchedule {
                instruction: "rust instruction".to_string(),
                spec: Some(rust_spec("Rust schedule")),
                enabled: true,
                next_run_at: Some(100),
            },
            50,
        )
        .expect("rust schedule");
    store
        .insert_run(
            InsertScheduleRun {
                schedule_id: schedule.id.clone(),
                external_id: "rust-external-1".to_string(),
                run_at: 100,
                task_id: None,
                status: ScheduleRunStatus::Queued,
            },
            60,
        )
        .expect("rust run");
    drop(connection);
    drop(db);

    let verified = run_fixture(
        "rust-server/scripts/workspace-schedule-fixture.ts",
        "verify",
        &db_path,
        &workspace_root,
    );
    let schedules = verified["schedules"].as_array().expect("schedules");
    let rust_schedule = schedules
        .iter()
        .find(|row| row["spec"]["name"] == json!("Rust schedule"))
        .expect("rust schedule visible to typescript");
    assert_eq!(rust_schedule["instruction"], json!("rust instruction"));
    assert_eq!(rust_schedule["nextRunAt"], json!(100));
    let runs = verified["runsByScheduleId"][rust_schedule["id"].as_str().expect("id")]
        .as_array()
        .expect("runs");
    assert_eq!(runs[0]["externalId"], json!("rust-external-1"));

    let written = run_fixture(
        "rust-server/scripts/workspace-schedule-fixture.ts",
        "write",
        &db_path,
        &workspace_root,
    );
    assert_eq!(written["run"]["inserted"], json!(true));
    assert_eq!(written["updated"]["status"], json!("completed"));
    assert_eq!(written["updated"]["result"], json!("ts result"));

    let db = WorkspaceDb::open(&db_path).expect("reopen workspace db");
    let connection = db.connect().expect("connection");
    let store = ScheduleStore::new(&connection, &workspace_id);
    let schedules = store.list_schedules(None).expect("list schedules");
    let ts_schedule = schedules
        .iter()
        .find(|row| row.spec.name == "TypeScript schedule")
        .expect("typescript schedule visible to rust");
    assert_eq!(ts_schedule.instruction, "typescript instruction");
    assert_eq!(ts_schedule.next_run_at, Some(500));
    let run = store
        .get_run_by_external_id("ts-external-1")
        .expect("get run")
        .expect("run visible to rust");
    assert_eq!(run.schedule_id, ts_schedule.id);
    assert_eq!(run.status, ScheduleRunStatus::Completed);
    assert_eq!(run.result.as_deref(), Some("ts result"));
    assert_eq!(run.completed_at, Some(420));
}

#[test]
fn typescript_and_rust_share_attachment_rows() {
    let directory = tempdir().expect("temp dir");
    let workspace_root = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace_root).expect("workspace root");
    let db_path = directory.path().join("ads.db");
    let workspace_id = derive_workspace_state_id(&workspace_root);

    let db = WorkspaceDb::open(&db_path).expect("workspace db");
    let connection = db.connect().expect("connection");
    connection
        .execute(
            "INSERT INTO tasks (id, title, prompt, created_at, workspace_id)
             VALUES ('task-ts', 'Task', 'Prompt', 1, ?1)",
            rusqlite::params![workspace_id],
        )
        .expect("insert task");
    let store = AttachmentStore::new(&connection, &workspace_id);
    let rust_attachment = store
        .create_or_get_image_attachment(CreateImageAttachment {
            task_id: None,
            filename: Some("C:\\fakepath\\rust.png".to_string()),
            content_type: "image/png".to_string(),
            size_bytes: 128,
            width: 16,
            height: 8,
            sha256: "a".repeat(64),
            storage_key: format!("attachments/aa/{}.png", "a".repeat(64)),
            now: Some(300),
        })
        .expect("rust attachment");
    drop(connection);
    drop(db);

    let verified = run_fixture(
        "rust-server/scripts/workspace-attachment-fixture.ts",
        "verify",
        &db_path,
        &workspace_root,
    );
    let attachment = verified["attachment"]
        .as_object()
        .expect("typescript reads rust attachment");
    assert_eq!(attachment["id"], json!(rust_attachment.id));
    assert_eq!(attachment["filename"], json!("rust.png"));
    assert_eq!(attachment["sha256"], json!("a".repeat(64)));
    assert_eq!(attachment["createdAt"], json!(300));

    let written = run_fixture(
        "rust-server/scripts/workspace-attachment-fixture.ts",
        "write",
        &db_path,
        &workspace_root,
    );
    assert_eq!(written["attachment"]["taskId"], json!("task-ts"));
    assert_eq!(written["attachment"]["filename"], json!("typescript.png"));
    assert_eq!(written["attachment"]["contentType"], json!("image/webp"));

    let db = WorkspaceDb::open(&db_path).expect("reopen workspace db");
    let connection = db.connect().expect("connection");
    let store = AttachmentStore::new(&connection, &workspace_id);
    let ts_attachment = store
        .get_attachment_by_sha256(&"f".repeat(64))
        .expect("get attachment")
        .expect("typescript attachment visible to rust");
    assert_eq!(ts_attachment.task_id.as_deref(), Some("task-ts"));
    assert_eq!(ts_attachment.filename.as_deref(), Some("typescript.png"));
    assert_eq!(ts_attachment.size_bytes, 256);
    assert_eq!(ts_attachment.width, 32);
    assert_eq!(ts_attachment.height, 24);
    assert_eq!(ts_attachment.created_at, 500);
}

#[test]
fn native_transcript_redaction_matches_typescript() {
    let cases = [
        "Authorization: Bearer abc123",
        "key sk-1234567890",
        "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        concat!("aws AK", "IAABCDEFGHIJKLMNOP"),
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        "https://user:password@example.com/path",
        "api_key=plain-secret",
        "clientSecret: \"camel-secret\"",
        "password = \"quoted-secret\"",
        "{\"password\":\"abc\",\"token\":\"x\",\"ok\":\"Bearer abc\"}",
        "{\"authorization\":\"Bearer nested\",\"safe\":\"keep\"}",
        "{\"broken\":",
        "supersecret and abc and x",
        "line one\nabc\nline three",
    ];
    let redactions = vec![
        "supersecret".to_string(),
        "abc".to_string(),
        "x".to_string(),
    ];
    let expected =
        run_fixture_without_workspace("rust-server/scripts/native-transcript-redaction-fixture.ts");
    let expected = expected["cases"].as_array().expect("redaction cases");
    for (index, value) in cases.iter().enumerate() {
        let actual = ads_state::redact_native_transcript_text(value, &redactions, 0);
        assert_eq!(
            actual,
            expected[index].as_str().expect("expected string"),
            "redaction mismatch for case {index}: {value}"
        );
    }
}

fn run_fixture_without_workspace(script: &str) -> Value {
    let output = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(repo_root().join(script))
        .current_dir(repo_root())
        .output()
        .expect("run node fixture");
    assert!(
        output.status.success(),
        "fixture {script} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or_else(|| panic!("fixture produced no JSON:\n{stdout}"));
    serde_json::from_str(line).expect("fixture json")
}

#[test]
fn typescript_and_rust_share_native_transcript_rows() {
    let directory = tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");
    let db = StateDb::open(&db_path).expect("state db");
    let connection = db.connect().expect("connection");
    let store = NativeTranscriptStore::new(&connection, &["known-secret".to_string()]);
    store
        .claim_transcript("cross-rust", "writer-rust")
        .expect("claim rust transcript");
    store
        .begin_turn(BeginNativeTurn {
            transcript_id: "cross-rust".to_string(),
            turn_id: "rust-turn".to_string(),
            messages: json!([
                {"role": "user", "content": "hello known-secret"},
                {
                    "role": "assistant",
                    "content": "ok",
                    "nativeResponses": {
                        "output": [{"type": "reasoning", "encrypted_content": "cipher"}]
                    }
                }
            ]),
            entries: json!([{"kind": "command", "toolCallId": "t", "command": "echo", "status": "completed"}]),
            provider: json!({"provider": "openai", "model": "gpt"}),
            writer_id: Some("writer-rust".to_string()),
            incremental: true,
        })
        .expect("begin rust turn");
    drop(connection);
    drop(db);

    let verified = run_fixture_with_db(
        "rust-server/scripts/native-transcript-store-fixture.ts",
        "verify",
        &db_path,
    );
    let turns = verified["turns"].as_array().expect("typescript turns");
    assert_eq!(turns[0]["turnId"], json!("rust-turn"));
    assert_eq!(
        turns[0]["messages"][0]["content"],
        json!("hello [redacted]")
    );
    assert_eq!(
        turns[0]["messages"][1]["nativeResponses"]["output"][0]["encrypted_content"],
        json!("cipher")
    );
    let history =
        serde_json::from_str::<Value>(verified["history"].as_str().expect("history string"))
            .expect("history json");
    assert_eq!(history["turn_id"], json!("rust-turn"));

    let written = run_fixture_with_db(
        "rust-server/scripts/native-transcript-store-fixture.ts",
        "write",
        &db_path,
    );
    assert_eq!(written["turns"][0]["status"], json!("completed"));
    assert_eq!(written["turns"][0]["messages"][0]["content"], json!("done"));

    let db = StateDb::open(&db_path).expect("reopen state db");
    let connection = db.connect().expect("connection");
    let store = NativeTranscriptStore::new(&connection, &["known-secret".to_string()]);
    let turns = store
        .list_turns("cross-ts", Some("writer-ts"), false)
        .expect("rust reads typescript transcript");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].turn_id, "ts-turn");
    assert_eq!(turns[0].status, NativeTranscriptTurnStatus::Completed);
    assert_eq!(
        turns[0].messages,
        json!([{"role": "assistant", "content": "done"}])
    );
    assert_eq!(
        turns[0].usage.as_ref().expect("usage"),
        &json!({"input_tokens": 7, "output_tokens": 2})
    );
}

fn run_fixture_with_db(script: &str, mode: &str, db_path: &Path) -> Value {
    let output = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(repo_root().join(script))
        .arg(mode)
        .arg(db_path)
        .current_dir(repo_root())
        .output()
        .expect("run node fixture");
    assert!(
        output.status.success(),
        "fixture {script} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or_else(|| panic!("fixture produced no JSON:\n{stdout}"));
    serde_json::from_str(line).expect("fixture json")
}
