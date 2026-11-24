use ads_contract::models::{ModelConfig, ModelProvider};
use ads_state::{
    StateDb, delete_model_provider, get_model_config, get_model_config_by_agent_model_id,
    get_model_provider, get_model_service, initialize_model_services, list_model_configs,
    list_model_providers, list_model_services, list_service_models,
    remove_model_service_references, save_model_service, upsert_model_config,
    upsert_model_provider,
};
use tempfile::tempdir;

fn open_state() -> (StateDb, tempfile::TempDir) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    (db, directory)
}

fn model(id: &str, model_id: &str, provider_id: Option<&str>) -> ModelConfig {
    ModelConfig {
        id: id.to_string(),
        model_id: model_id.to_string(),
        display_name: model_id.to_string(),
        provider: "openai".to_string(),
        provider_id: provider_id.map(ToString::to_string),
        is_enabled: true,
        is_default: false,
        config_json: None,
        updated_at: None,
    }
}

#[test]
fn fresh_database_contains_the_typescript_seed_rows() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");

    let models = list_model_configs(&connection).expect("models");
    assert_eq!(models.len(), 5, "seed catalog size");
    let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
    assert!(ids.contains(&"model-seed-codex-gpt-5-5"));
    assert!(ids.contains(&"model-seed-droid-gpt-5-6-luna"));

    let profiles: i64 = connection
        .query_row("SELECT COUNT(*) FROM role_profiles", [], |row| row.get(0))
        .expect("profiles");
    assert_eq!(profiles, 2);
}

#[test]
fn initialization_seeds_the_conversation_service_from_the_catalog() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    initialize_model_services(&connection).expect("initialize");

    let selection = get_model_service(&connection, "conversation").expect("selection");
    assert_eq!(selection.model_ids.len(), 5);
    assert_eq!(
        selection.default_model_id.as_deref(),
        Some("model-seed-droid-gpt-5-6-luna"),
        "the newest seeded model is selected first"
    );

    let services = list_model_services(&connection).expect("services");
    assert_eq!(services.len(), 3);
    assert!(
        services
            .iter()
            .filter(|service| service.service != "conversation")
            .all(|service| service.model_ids.is_empty())
    );
}

#[test]
fn provider_crud_and_delete_cascade() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");

    let provider = upsert_model_provider(
        &connection,
        &ModelProvider {
            id: "provider-a".to_string(),
            name: "Provider A".to_string(),
            base_url: "https://example.test/v1".to_string(),
            credential_profile: Some(" default ".to_string()),
            wire_api: Some("responses".to_string()),
            is_enabled: true,
            updated_at: None,
        },
        100,
    )
    .expect("upsert provider");
    assert_eq!(provider.credential_profile.as_deref(), Some("default"));
    assert_eq!(list_model_providers(&connection).expect("list").len(), 1);

    upsert_model_config(
        &mut connection,
        &model("model-a", "gpt-a", Some("provider-a")),
        100,
    )
    .expect("model");

    assert!(delete_model_provider(&mut connection, "provider-a").expect("delete"));
    assert!(
        get_model_provider(&connection, "provider-a")
            .expect("get")
            .is_none()
    );
    assert!(
        get_model_config(&connection, "model-a")
            .expect("model")
            .is_none(),
        "provider delete cascades to attached model configs"
    );
}

#[test]
fn service_save_validates_defaults_and_provider_requirements() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    initialize_model_services(&connection).expect("initialize");

    let enabled: Vec<String> = list_model_configs(&connection)
        .expect("models")
        .into_iter()
        .filter(|model| model.is_enabled)
        .map(|model| model.id)
        .collect();
    let all_ids = enabled.clone();

    save_model_service(
        &mut connection,
        "conversation",
        &all_ids,
        all_ids.first().map(String::as_str),
    )
    .expect("save conversation");

    let error = save_model_service(&mut connection, "conversation", &all_ids, None)
        .expect_err("default required");
    assert!(
        error
            .to_string()
            .contains("Select exactly one default from the enabled models")
    );

    let error = save_model_service(
        &mut connection,
        "conversation",
        &all_ids,
        Some("model-missing"),
    )
    .expect_err("default must be a member");
    assert!(
        error
            .to_string()
            .contains("Select exactly one default from the enabled models")
    );

    let error = save_model_service(&mut connection, "conversation", &[], Some("x"))
        .expect_err("disabled service needs a null default");
    assert!(
        error
            .to_string()
            .contains("Select exactly one default from the enabled models")
    );

    let error = save_model_service(
        &mut connection,
        "conversation",
        &["missing".to_string()],
        Some("missing"),
    )
    .expect_err("unknown model");
    assert!(error.to_string().contains("Unknown model configuration."));

    let conversation_only = enabled[0].clone();
    let error = save_model_service(
        &mut connection,
        "transcription",
        std::slice::from_ref(&conversation_only),
        Some(&conversation_only),
    )
    .expect_err("non-conversation services require a provider");
    assert!(
        error
            .to_string()
            .contains("Attach the model to a provider first.")
    );
}

#[test]
fn removing_a_default_promotes_the_next_service_model() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    initialize_model_services(&connection).expect("initialize");

    let selection = get_model_service(&connection, "conversation").expect("selection");
    let removed = selection.default_model_id.clone().expect("default");
    let remaining: Vec<String> = selection
        .model_ids
        .iter()
        .filter(|id| **id != removed)
        .cloned()
        .collect();

    remove_model_service_references(&mut connection, &removed, 500).expect("remove references");

    let after = get_model_service(&connection, "conversation").expect("selection");
    assert!(!after.model_ids.contains(&removed));
    assert!(after.default_model_id.is_some());
    assert_ne!(after.default_model_id.as_deref(), Some(removed.as_str()));
    assert!(
        after
            .default_model_id
            .as_deref()
            .is_some_and(|id| remaining.contains(&id.to_string()))
    );

    let listed = list_service_models(&connection, "conversation").expect("models");
    assert_eq!(
        listed
            .iter()
            .find(|model| model.is_default)
            .map(|model| model.id.as_str()),
        after.default_model_id.as_deref()
    );
}

#[test]
fn agent_model_lookup_stays_provider_scoped() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    upsert_model_provider(
        &connection,
        &ModelProvider {
            id: "provider-a".to_string(),
            name: "A".to_string(),
            base_url: "https://a.test".to_string(),
            credential_profile: None,
            wire_api: None,
            is_enabled: true,
            updated_at: None,
        },
        1,
    )
    .expect("provider");
    upsert_model_config(
        &mut connection,
        &model("model-a", "shared", Some("provider-a")),
        1,
    )
    .expect("model a");
    upsert_model_config(&mut connection, &model("model-b", "shared", None), 1).expect("model b");

    let resolved =
        get_model_config_by_agent_model_id(&connection, "shared", Some(Some("provider-a")))
            .expect("scoped")
            .expect("exists");
    assert_eq!(resolved.id, "model-a");
    assert!(resolved.provider_id.is_some());

    let null_scoped = get_model_config_by_agent_model_id(&connection, "shared", Some(None))
        .expect("null scoped")
        .expect("exists");
    assert_eq!(null_scoped.id, "model-b");
}

#[test]
fn reconcile_provider_models_prunes_obsolete_preserves_other_providers_and_cleans_references() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let mut connection = db.connect().expect("connection");
    initialize_model_services(&connection).expect("init services");

    let provider_a = ModelProvider {
        id: "provider-a".to_string(),
        name: "Provider A".to_string(),
        base_url: "https://a.test/v1".to_string(),
        credential_profile: None,
        wire_api: None,
        is_enabled: true,
        updated_at: None,
    };
    let provider_b = ModelProvider {
        id: "provider-b".to_string(),
        name: "Provider B".to_string(),
        base_url: "https://b.test/v1".to_string(),
        credential_profile: None,
        wire_api: None,
        is_enabled: true,
        updated_at: None,
    };
    upsert_model_provider(&connection, &provider_a, 1).expect("provider a");
    upsert_model_provider(&connection, &provider_b, 1).expect("provider b");

    let mut kept = model("model-kept", "kept-upstream", Some("provider-a"));
    kept.display_name = "Custom Kept Alias".to_string();
    upsert_model_config(&mut connection, &kept, 1).expect("kept");
    upsert_model_config(
        &mut connection,
        &model("model-stale", "stale-upstream", Some("provider-a")),
        1,
    )
    .expect("stale");
    upsert_model_config(
        &mut connection,
        &model("model-other", "stale-upstream", Some("provider-b")),
        1,
    )
    .expect("other provider");
    upsert_model_config(
        &mut connection,
        &model("model-unscoped", "unscoped-model", None),
        1,
    )
    .expect("unscoped");

    save_model_service(
        &mut connection,
        ads_state::CONVERSATION_SERVICE,
        &["model-stale".to_string(), "model-kept".to_string()],
        Some("model-stale"),
    )
    .expect("save conversation service");
    connection
        .execute(
            "UPDATE role_profiles SET model_id = 'model-stale' WHERE role = 'acopilot'",
            [],
        )
        .expect("set role model");

    let synced = ads_state::reconcile_provider_models(
        &mut connection,
        &provider_a,
        &["kept-upstream".to_string(), "brand-new".to_string()],
        200,
    )
    .expect("reconcile");

    let synced_model_ids: Vec<&str> = synced.iter().map(|m| m.model_id.as_str()).collect();
    assert!(synced_model_ids.contains(&"kept-upstream"));
    assert!(synced_model_ids.contains(&"brand-new"));
    assert!(!synced_model_ids.contains(&"stale-upstream"));

    let kept_after = get_model_config(&connection, "model-kept")
        .expect("read kept")
        .expect("kept exists");
    assert_eq!(kept_after.display_name, "Custom Kept Alias");
    assert!(
        get_model_config(&connection, "model-stale")
            .expect("read stale")
            .is_none()
    );
    assert!(
        get_model_config(&connection, "model-other")
            .expect("read other")
            .is_some()
    );
    assert!(
        get_model_config(&connection, "model-unscoped")
            .expect("read unscoped")
            .is_some()
    );

    let conversation = get_model_service(&connection, ads_state::CONVERSATION_SERVICE).expect("service");
    assert_eq!(conversation.model_ids, vec!["model-kept"]);
    assert_eq!(
        conversation.default_model_id.as_deref(),
        Some("model-kept")
    );
    let role_model: String = connection
        .query_row(
            "SELECT model_id FROM role_profiles WHERE role = 'acopilot'",
            [],
            |row| row.get(0),
        )
        .expect("role model");
    assert_eq!(role_model, "model-kept");
}
