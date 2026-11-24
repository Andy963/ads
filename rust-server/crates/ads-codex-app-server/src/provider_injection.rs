use std::collections::HashMap;

use ads_state::{
    CONVERSATION_SERVICE, ROLE_ACOPILOT, StateDb, StateError, StateResult, UpstreamCredentialStore,
    get_default_role_profile, get_model_config, get_model_config_by_agent_model_id,
    get_model_provider, get_model_service, normalize_upstream_base_url,
};

use crate::SpawnOptions;

pub const CODEX_PROVIDER_API_KEY_ENV: &str = "ADS_CODEX_PROVIDER_API_KEY";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexModelSelection {
    pub model: Option<String>,
    pub model_key: String,
    pub daemon_options: SpawnOptions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexProviderInjection {
    provider_id: String,
    global_args: Vec<String>,
    env: HashMap<String, String>,
}

pub fn resolve_codex_model_selection(
    db: &StateDb,
    owner: &str,
    requested_model: Option<&str>,
    base_daemon_options: SpawnOptions,
) -> StateResult<CodexModelSelection> {
    let requested = requested_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(requested) = requested else {
        if let Some(default_selection) =
            resolve_ads_default_codex_model(db, owner, &base_daemon_options)
        {
            return Ok(default_selection);
        }
        return Ok(CodexModelSelection {
            model: None,
            model_key: "default".to_string(),
            daemon_options: base_daemon_options,
        });
    };

    resolve_explicit_codex_model(db, owner, requested, base_daemon_options)
}

fn resolve_ads_default_codex_model(
    db: &StateDb,
    owner: &str,
    base_daemon_options: &SpawnOptions,
) -> Option<CodexModelSelection> {
    let connection = db.connect().ok()?;
    let mut candidates = Vec::new();
    if let Ok(Some(profile)) = get_default_role_profile(&connection, ROLE_ACOPILOT)
        && profile.is_enabled != 0
    {
        let model_id = profile.model_id.trim();
        if !model_id.is_empty() {
            candidates.push(model_id.to_string());
        }
    }
    if let Ok(service) = get_model_service(&connection, CONVERSATION_SERVICE)
        && let Some(default_id) = service.default_model_id
    {
        let trimmed = default_id.trim();
        if !trimmed.is_empty() && !candidates.iter().any(|item| item == trimmed) {
            candidates.push(trimmed.to_string());
        }
    }
    let enabled_candidates: Vec<String> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let config = get_model_config(&connection, &candidate)
                .ok()
                .flatten()
                .or_else(|| {
                    get_model_config_by_agent_model_id(&connection, &candidate, None)
                        .ok()
                        .flatten()
                })?;
            config.is_enabled.then_some(config.id)
        })
        .collect();
    drop(connection);
    for candidate in enabled_candidates {
        if let Ok(selection) =
            resolve_explicit_codex_model(db, owner, &candidate, base_daemon_options.clone())
        {
            return Some(selection);
        }
    }
    None
}

fn resolve_explicit_codex_model(
    db: &StateDb,
    owner: &str,
    requested: &str,
    base_daemon_options: SpawnOptions,
) -> StateResult<CodexModelSelection> {
    let connection = db.connect()?;
    let config = get_model_config(&connection, requested)?.or(get_model_config_by_agent_model_id(
        &connection,
        requested,
        None,
    )?);
    let Some(config) = config else {
        return Ok(CodexModelSelection {
            model: Some(requested.to_string()),
            model_key: requested.to_string(),
            daemon_options: base_daemon_options,
        });
    };

    let model = config.model_id.trim().to_string();
    let provider_id = config
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(provider_id) = provider_id else {
        return Ok(CodexModelSelection {
            model: Some(model.clone()),
            model_key: format!("{}@{model}", config.id),
            daemon_options: base_daemon_options,
        });
    };

    let provider = get_model_provider(&connection, provider_id)?.ok_or_else(|| {
        StateError::InvalidInput(format!(
            "Model \"{requested}\" references an unknown provider; re-select the model's provider."
        ))
    })?;
    if !provider.is_enabled {
        return Err(StateError::InvalidInput(format!(
            "Provider \"{}\" is disabled.",
            provider.name
        )));
    }

    let profile = provider
        .credential_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&provider.id);
    let credentials = UpstreamCredentialStore::for_state_db(db.path()).get_credentials(
        &connection,
        owner,
        Some(profile),
    )?;
    let credentials = credentials.ok_or_else(|| {
        StateError::InvalidInput(format!(
            "Provider \"{}\" has no API key configured for this account.",
            provider.name
        ))
    })?;
    if normalize_upstream_base_url(&credentials.base_url)?
        != normalize_upstream_base_url(&provider.base_url)?
    {
        return Err(StateError::InvalidInput(format!(
            "Provider \"{}\" endpoint does not match this account's saved credential.",
            provider.name
        )));
    }

    let injection = build_provider_injection(&provider, &credentials.api_key);
    let mut daemon_options = base_daemon_options;
    daemon_options.global_args.extend(injection.global_args);
    daemon_options.env.extend(injection.env);
    Ok(CodexModelSelection {
        model: Some(model.clone()),
        model_key: format!("{}@{model}@{}", config.id, injection.provider_id),
        daemon_options,
    })
}

fn build_provider_injection(
    provider: &ads_contract::models::ModelProvider,
    api_key: &str,
) -> CodexProviderInjection {
    let slug = codex_provider_slug(&provider.id);
    let wire_api = provider
        .wire_api
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("responses");
    CodexProviderInjection {
        provider_id: provider.id.clone(),
        global_args: vec![
            "-c".to_string(),
            format!(
                "model_providers.{slug}.name={}",
                toml_string(&provider.name)
            ),
            "-c".to_string(),
            format!(
                "model_providers.{slug}.base_url={}",
                toml_string(&provider.base_url)
            ),
            "-c".to_string(),
            format!(
                "model_providers.{slug}.env_key={}",
                toml_string(CODEX_PROVIDER_API_KEY_ENV)
            ),
            "-c".to_string(),
            format!("model_providers.{slug}.wire_api={}", toml_string(wire_api)),
            "-c".to_string(),
            format!("model_provider={}", toml_string(&slug)),
        ],
        env: HashMap::from([(CODEX_PROVIDER_API_KEY_ENV.to_string(), api_key.to_string())]),
    }
}

fn codex_provider_slug(provider_id: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in provider_id.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            if separator && !slug.is_empty() && !slug.ends_with('-') {
                slug.push('-');
            }
            separator = false;
            slug.push(character);
        } else {
            separator = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "ads-provider".to_string()
    } else {
        format!("ads-{slug}")
    }
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).expect("serialize TOML string")
}

#[cfg(test)]
mod tests {
    use ads_contract::models::{ModelConfig, ModelProvider};
    use ads_state::{
        StateDb, UpstreamCredentialStore, UpstreamCredentials, upsert_model_config,
        upsert_model_provider,
    };
    use tempfile::tempdir;

    use super::{codex_provider_slug, resolve_codex_model_selection};
    use crate::SpawnOptions;

    #[test]
    fn provider_slug_matches_the_typescript_contract() {
        assert_eq!(
            codex_provider_slug(" Provider/Seven Bad! "),
            "ads-provider-seven-bad"
        );
        assert_eq!(codex_provider_slug("---"), "ads-provider");
    }

    #[test]
    fn omitted_model_resolves_configured_acopilot_role_model_and_matches_explicit_key() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let mut connection = db.connect().expect("connection");
        upsert_model_provider(
            &connection,
            &ModelProvider {
                id: "provider-cpa".to_string(),
                name: "CPA".to_string(),
                base_url: "https://cpa.example.com/v1".to_string(),
                wire_api: Some("responses".to_string()),
                credential_profile: Some("provider-cpa".to_string()),
                is_enabled: true,
                updated_at: Some(1),
            },
            1,
        )
        .expect("provider");
        upsert_model_config(
            &mut connection,
            &ModelConfig {
                id: "model-neon".to_string(),
                model_id: "gemini-4-neon-xhigh".to_string(),
                display_name: "gemini-4-neon-xhigh".to_string(),
                provider: "cpa".to_string(),
                provider_id: Some("provider-cpa".to_string()),
                is_enabled: true,
                is_default: false,
                config_json: None,
                updated_at: Some(1),
            },
            1,
        )
        .expect("model");
        connection
            .execute(
                "UPDATE role_profiles SET model_id = 'model-neon', is_enabled = 1 WHERE role = 'acopilot'",
                [],
            )
            .expect("role");
        UpstreamCredentialStore::for_state_db(db.path())
            .save(
                &connection,
                "user-1",
                &UpstreamCredentials {
                    base_url: "https://cpa.example.com/v1".to_string(),
                    provider: "cpa".to_string(),
                    api_key: "sk-test-key".to_string(),
                },
                Some("provider-cpa"),
            )
            .expect("creds");
        drop(connection);

        let fallback = resolve_codex_model_selection(&db, "user-1", None, SpawnOptions::default())
            .expect("fallback selection");
        let explicit = resolve_codex_model_selection(
            &db,
            "user-1",
            Some("model-neon"),
            SpawnOptions::default(),
        )
        .expect("explicit selection");
        assert_eq!(fallback.model.as_deref(), Some("gemini-4-neon-xhigh"));
        assert_eq!(fallback.model_key, explicit.model_key);
        assert!(
            fallback
                .daemon_options
                .global_args
                .iter()
                .any(|arg| arg.contains("provider-cpa"))
        );
    }
}
