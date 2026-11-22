use std::path::{Path, PathBuf};
use std::process::Command;

use ads_contract::models::ModelConfig;
use ads_state::{
    StateDb, UpsertWebProject, get_active_project_id, get_model_config, get_web_project,
    list_model_configs, set_active_project_id, upsert_model_config, upsert_web_project,
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

fn ts_server_root() -> PathBuf {
    repo_root().join("ts-server")
}

fn run_fixture(mode: &str, db_path: &Path) -> Value {
    let ts_server_root = ts_server_root();
    let output = Command::new("node")
        .arg("--import")
        .arg(ts_server_root.join("node_modules/tsx/dist/loader.mjs"))
        .arg(repo_root().join("rust-server/scripts/state-store-fixture.ts"))
        .arg(mode)
        .arg(db_path)
        .current_dir(ts_server_root)
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

#[test]
fn typescript_and_rust_share_the_same_state_database() {
    let directory = tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");

    let created = run_fixture("create", &db_path);
    assert_eq!(created["activeProjectId"], json!("project-ts"));
    assert_eq!(created["project"]["name"], json!("TS Project"));
    assert_eq!(created["project"]["chatSessionId"], json!("main"));
    let models = created["models"].as_array().expect("models");
    let model_ts = models
        .iter()
        .find(|model| model["id"] == json!("model-ts"))
        .expect("model-ts exists");
    assert_eq!(
        model_ts["configJson"]["reasoningEfforts"],
        json!(["high", "low"])
    );
    assert_eq!(model_ts["configJson"]["max_output_tokens"], json!(4096));

    let db = StateDb::open(&db_path).expect("rust opens typescript database");
    let connection = db.connect().expect("connection");

    let project = get_web_project(&connection, "user-ts", "project-ts")
        .expect("read project")
        .expect("project exists");
    assert_eq!(project.name, "TS Project");
    assert_eq!(
        get_active_project_id(&connection, "user-ts").expect("active"),
        Some("project-ts".to_string())
    );

    let model = get_model_config(&connection, "model-ts")
        .expect("read model")
        .expect("model exists");
    assert_eq!(model.model_id, "gpt-ts");
    assert!(model.is_default);
    assert_eq!(
        model.config_json.as_ref().expect("config")["max_input_tokens"],
        json!(8192)
    );

    upsert_web_project(
        &connection,
        UpsertWebProject {
            user_id: "user-ts",
            project_id: "project-rust",
            workspace_root: "/work/rust-project",
            name: "Rust Project",
            chat_session_id: Some("rt"),
        },
        1_700_000_001_000,
    )
    .expect("rust project");
    set_active_project_id(
        &connection,
        "user-ts",
        Some("project-rust"),
        1_700_000_001_000,
    )
    .expect("rust active project");

    let mut connection = connection;
    upsert_model_config(
        &mut connection,
        &ModelConfig {
            id: "model-rust".to_string(),
            model_id: "gpt-rust".to_string(),
            display_name: "Rust Model".to_string(),
            provider: "openai".to_string(),
            provider_id: None,
            is_enabled: true,
            is_default: true,
            config_json: Some(json!({"max_input_tokens": 2048})),
            updated_at: None,
        },
        1_700_000_001_000,
    )
    .expect("rust model");
    drop(connection);

    let verified = run_fixture("verify", &db_path);
    let project_ids = verified["projects"].as_array().expect("projects");
    assert!(project_ids.contains(&json!("project-rust")));
    assert!(project_ids.contains(&json!("project-ts")));
    let model_ids = verified["models"].as_array().expect("models");
    assert!(model_ids.contains(&json!("model-rust")));
    assert!(model_ids.contains(&json!("model-ts")));

    let db = StateDb::open(&db_path).expect("reopen after typescript writes");
    let connection = db.connect().expect("connection");
    let after = get_web_project(&connection, "user-ts", "project-ts-after")
        .expect("read ts-after project")
        .expect("ts-after project exists");
    assert_eq!(after.name, "TS After Rust");

    let models = list_model_configs(&connection).expect("list models");
    assert!(
        models.iter().any(|model| model.id == "model-ts-after"),
        "rust did not see the model config created by typescript"
    );
}
