use ads_contract::models::ModelConfig;
use ads_state::{
    StateDb, UpdateWebProject, UpsertWebProject, delete_model_config, delete_web_project,
    ensure_model_config_tables, ensure_web_project_tables, get_active_project_id, get_model_config,
    get_model_config_by_agent_model_id, get_web_project, list_model_configs, list_web_projects,
    reorder_web_projects, sanitize_model_config_json, set_active_project_id, update_web_project,
    upsert_model_config, upsert_web_project,
};
use serde_json::json;
use tempfile::tempdir;

fn open_state() -> (StateDb, tempfile::TempDir) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    {
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
                 VALUES ('user-1', 'admin', 'hash', 1, 1)",
                [],
            )
            .expect("user");
        ensure_web_project_tables(&connection).expect("project tables");
        ensure_model_config_tables(&connection).expect("model config tables");
    }
    (db, directory)
}

#[test]
fn project_lifecycle_matches_the_typescript_store() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");

    let project = upsert_web_project(
        &connection,
        UpsertWebProject {
            user_id: "user-1",
            project_id: "project-1",
            workspace_root: "/work/one",
            name: "One",
            chat_session_id: None,
        },
        1_000,
    )
    .expect("upsert");
    assert_eq!(project.name, "One");
    assert_eq!(project.chat_session_id, "main");
    assert_eq!(project.created_at, 1_000);

    let updated = upsert_web_project(
        &connection,
        UpsertWebProject {
            user_id: "user-1",
            project_id: "project-1",
            workspace_root: "/work/one",
            name: "Renamed",
            chat_session_id: Some("chat-2"),
        },
        2_000,
    )
    .expect("upsert again");
    assert_eq!(updated.name, "Renamed");
    assert_eq!(updated.chat_session_id, "chat-2");
    assert_eq!(updated.created_at, 1_000, "created_at is preserved");
    assert_eq!(updated.updated_at, 2_000);

    set_active_project_id(&connection, "user-1", Some("project-1"), 2_000).expect("active");
    assert_eq!(
        get_active_project_id(&connection, "user-1").expect("active read"),
        Some("project-1".to_string())
    );

    let second = upsert_web_project(
        &connection,
        UpsertWebProject {
            user_id: "user-1",
            project_id: "project-2",
            workspace_root: "/work/two",
            name: "Two",
            chat_session_id: None,
        },
        3_000,
    )
    .expect("second project");
    assert_eq!(second.created_at, 3_000);

    let listed = list_web_projects(&connection, "user-1").expect("list");
    assert_eq!(
        listed
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["project-1", "project-2"]
    );

    let updated = update_web_project(
        &connection,
        UpdateWebProject {
            user_id: "user-1",
            project_id: "project-1",
            name: Some("Renamed again"),
            chat_session_id: None,
        },
        4_000,
    )
    .expect("update")
    .expect("project exists");
    assert_eq!(updated.name, "Renamed again");
    assert_eq!(updated.chat_session_id, "chat-2");
    assert_eq!(updated.updated_at, 4_000);

    assert!(delete_web_project(&connection, "user-1", "project-1").expect("delete"));
    assert!(!delete_web_project(&connection, "user-1", "project-1").expect("delete again"));
    assert!(
        get_web_project(&connection, "user-1", "project-1")
            .expect("get")
            .is_none()
    );
}

#[test]
fn project_reorder_rejects_default_and_unknown_ids() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    for (index, id) in ["a", "b", "c"].iter().enumerate() {
        upsert_web_project(
            &connection,
            UpsertWebProject {
                user_id: "user-1",
                project_id: id,
                workspace_root: &format!("/work/{id}"),
                name: id,
                chat_session_id: None,
            },
            index as i64,
        )
        .expect("seed");
    }

    reorder_web_projects(
        &mut connection,
        "user-1",
        &[
            "c".to_string(),
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
        ],
    )
    .expect("reorder");
    let listed = list_web_projects(&connection, "user-1").expect("list");
    assert_eq!(
        listed
            .iter()
            .map(|project| project.id.as_str())
            .collect::<Vec<_>>(),
        vec!["c", "a", "b"]
    );

    let error = reorder_web_projects(&mut connection, "user-1", &["missing".to_string()])
        .expect_err("unknown id");
    assert!(error.to_string().contains("Unknown project id: missing"));

    let error = reorder_web_projects(&mut connection, "user-1", &["default".to_string()])
        .expect_err("default id");
    assert!(
        error
            .to_string()
            .contains("default project cannot be reordered")
    );
}

#[test]
fn model_config_sanitizer_matches_the_typescript_rules() {
    let sanitized = sanitize_model_config_json(Some(&json!({
        "max_input_tokens": "4096",
        "max_output_tokens": 0,
        "reasoningEfforts": ["HIGH", "bogus", "high", "low"],
        "defaultReasoningEffort": "low"
    })))
    .expect("object");
    assert_eq!(sanitized["max_input_tokens"], json!(4096));
    assert_eq!(sanitized["max_output_tokens"], json!(null));
    assert!(sanitized.get("max_output_tokens").is_none());
    assert_eq!(sanitized["reasoningEfforts"], json!(["high", "low"]));
    assert_eq!(sanitized["defaultReasoningEffort"], json!("low"));

    let sanitized = sanitize_model_config_json(Some(&json!({
        "reasoningEfforts": [],
        "defaultReasoningEffort": "low"
    })))
    .expect("object");
    assert_eq!(sanitized["reasoningEfforts"], json!(["medium", "high"]));
    assert_eq!(sanitized["defaultReasoningEffort"], json!("high"));

    let sanitized = sanitize_model_config_json(Some(&json!({
        "reasoningEfforts": ["low"],
        "defaultReasoningEffort": "high"
    })))
    .expect("object");
    assert_eq!(sanitized["defaultReasoningEffort"], json!("low"));

    assert!(sanitize_model_config_json(Some(&json!([1, 2]))).is_none());
}

#[test]
fn model_config_upsert_clears_overlapping_defaults() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");

    let first = upsert_model_config(
        &mut connection,
        &ModelConfig {
            id: "model-1".to_string(),
            model_id: "gpt-local-1".to_string(),
            display_name: "GPT-5.5".to_string(),
            provider: "openai".to_string(),
            provider_id: None,
            is_enabled: true,
            is_default: true,
            config_json: Some(json!({"reasoningEfforts": ["high"]})),
            updated_at: None,
        },
        100,
    )
    .expect("first");
    assert!(first.is_default);

    let second = upsert_model_config(
        &mut connection,
        &ModelConfig {
            id: "model-2".to_string(),
            model_id: "gpt-local-2".to_string(),
            display_name: "GPT-5.6".to_string(),
            provider: "openai".to_string(),
            provider_id: Some("provider-a".to_string()),
            is_enabled: true,
            is_default: true,
            config_json: None,
            updated_at: None,
        },
        200,
    )
    .expect("second");
    assert!(second.is_default);
    assert!(
        !get_model_config(&connection, "model-1")
            .expect("read")
            .expect("exists")
            .is_default,
        "existing default is cleared because all configs share the codex scope"
    );

    let listed = list_model_configs(&connection).expect("list");
    assert!(listed.iter().any(|model| model.id == "model-1"));
    assert!(listed.iter().any(|model| model.id == "model-2"));
    assert_eq!(
        listed[0].id, "model-2",
        "the default model sorts before the seeded catalog"
    );

    let by_model = get_model_config_by_agent_model_id(&connection, "gpt-local-1", None)
        .expect("by model")
        .expect("exists");
    assert_eq!(by_model.id, "model-1");

    assert!(delete_model_config(&connection, "model-1").expect("delete"));
    assert!(!delete_model_config(&connection, "model-1").expect("delete again"));
}

#[test]
fn model_config_lookup_rejects_ambiguous_agent_model_ids() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    for (id, provider_id) in [("model-a", "provider-a"), ("model-b", "provider-b")] {
        upsert_model_config(
            &mut connection,
            &ModelConfig {
                id: id.to_string(),
                model_id: "shared-model".to_string(),
                display_name: id.to_string(),
                provider: "openai".to_string(),
                provider_id: Some(provider_id.to_string()),
                is_enabled: true,
                is_default: false,
                config_json: None,
                updated_at: None,
            },
            1,
        )
        .expect("seed");
    }

    let error = get_model_config_by_agent_model_id(&connection, "shared-model", None)
        .expect_err("ambiguous");
    assert!(error.to_string().contains("Ambiguous model name"));

    let resolved =
        get_model_config_by_agent_model_id(&connection, "shared-model", Some(Some("provider-b")))
            .expect("scoped lookup")
            .expect("exists");
    assert_eq!(resolved.id, "model-b");
}
