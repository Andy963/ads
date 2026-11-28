use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use ads_contract::models::ModelConfig;
use ads_state::{
    UpstreamCredentialStore, get_model_config, get_model_config_by_agent_model_id,
    get_model_provider, list_service_models, normalize_upstream_base_url,
    resolve_conversation_model,
};
use serde_json::Value;

use crate::{
    NativeError, NativeProviderCapabilities, NativeProviderCapabilityStatus, NativeRequestOptions,
    NativeResult, WireApi, resolve_native_provider_capabilities,
};

const DEFAULT_REASONING_EFFORT: &str = "high";
const MIN_CONTEXT_WINDOW: u64 = 256;
const MAX_TOKEN_LIMIT: u64 = 100_000_000;
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone)]
pub struct ResolveOptions {
    pub owner: String,
    pub model: Option<String>,
    pub require_owner_credentials: bool,
}

#[derive(Debug, Clone)]
pub struct NativeModelConfig {
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub provider: String,
    pub wire_api: WireApi,
    pub context_window: Option<u64>,
    pub options: NativeRequestOptions,
    pub capabilities: NativeProviderCapabilities,
}

#[derive(Clone)]
pub struct ModelResolver {
    db: ads_state::StateDb,
    env: HashMap<String, String>,
    credential_store: Option<UpstreamCredentialStore>,
}

impl ModelResolver {
    pub fn new(db: ads_state::StateDb) -> Self {
        Self {
            db,
            env: std::env::vars().collect(),
            credential_store: None,
        }
    }

    pub fn with_env(db: ads_state::StateDb, env: HashMap<String, String>) -> Self {
        Self {
            db,
            env,
            credential_store: None,
        }
    }

    pub fn with_credential_store(mut self, credential_store: UpstreamCredentialStore) -> Self {
        self.credential_store = Some(credential_store);
        self
    }

    pub fn resolve(&self, options: &ResolveOptions) -> NativeResult<NativeModelConfig> {
        let owner = options.owner.trim();
        if owner.is_empty() {
            return Err(NativeError::Configuration(
                "Native runtime requires an authenticated credential owner".to_string(),
            ));
        }
        let connection = self.db.connect()?;
        let requested = options
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default");
        let saved = self.find_saved_model(&connection, requested)?;
        if let Some(saved) = saved {
            return self.resolve_saved(&connection, owner, requested, saved, options);
        }
        if options.require_owner_credentials {
            return Err(NativeError::Configuration(
                "Reviewer requires a saved model and owner-scoped credentials".to_string(),
            ));
        }
        let fallback = resolve_codex_config(&self.env)?;
        let mut options = request_options(None);
        options.reasoning_effort = Some(
            fallback
                .reasoning_effort
                .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
        );
        Ok(NativeModelConfig {
            model: requested.to_string(),
            base_url: normalize_upstream_base_url(&fallback.base_url)?,
            api_key: fallback.api_key,
            provider: "openai".to_string(),
            wire_api: WireApi::Chat,
            context_window: None,
            options,
            capabilities: resolve_native_provider_capabilities(None),
        })
    }

    fn find_saved_model(
        &self,
        connection: &rusqlite::Connection,
        requested: &str,
    ) -> NativeResult<Option<ModelConfig>> {
        if requested == "default" {
            let models = list_service_models(connection, ads_state::CONVERSATION_SERVICE)?;
            return Ok(models
                .iter()
                .find(|model| model.is_default)
                .cloned()
                .or_else(|| models.first().cloned()));
        }
        if let Some(model) = get_model_config(connection, requested)? {
            return Ok(Some(model));
        }
        Ok(get_model_config_by_agent_model_id(
            connection, requested, None,
        )?)
    }

    fn resolve_saved(
        &self,
        connection: &rusqlite::Connection,
        owner: &str,
        requested: &str,
        saved: ModelConfig,
        options: &ResolveOptions,
    ) -> NativeResult<NativeModelConfig> {
        if !saved.is_enabled {
            return Err(NativeError::Configuration(format!(
                "Native runtime model \"{}\" is disabled",
                saved.model_id
            )));
        }
        resolve_conversation_model(connection, &saved.id)?;
        let config = saved.config_json.as_ref();
        let provider_id = saved.provider_id.as_deref().map(str::trim).unwrap_or("");
        let attached_provider = if provider_id.is_empty() {
            None
        } else {
            Some(get_model_provider(connection, provider_id)?.ok_or_else(|| {
                NativeError::Configuration(format!(
                    "Native runtime model \"{}\" references an unknown provider",
                    saved.model_id
                ))
            })?)
        };
        if let Some(provider) = attached_provider.as_ref() {
            if !provider.is_enabled {
                return Err(NativeError::Configuration(format!(
                    "Native runtime provider \"{}\" is disabled",
                    provider.name
                )));
            }
        }
        let wire_api = match attached_provider
            .as_ref()
            .and_then(|provider| provider.wire_api.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None | Some("chat") => WireApi::Chat,
            Some("responses") => WireApi::Responses,
            Some(_) => {
                return Err(NativeError::Configuration(
                    "Native runtime supports Chat Completions and Responses; select a supported provider API format."
                        .to_string(),
                ));
            }
        };
        let profile = attached_provider
            .as_ref()
            .map(|provider| {
                provider
                    .credential_profile
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&provider.id)
                    .to_string()
            })
            .or_else(|| read_string(config, "credentialProfile"));
        let credential_store = self
            .credential_store
            .clone()
            .unwrap_or_else(|| UpstreamCredentialStore::for_state_db(self.db.path()));
        let credentials = credential_store.get_credentials(
            connection,
            owner,
            profile.as_deref().filter(|value| !value.is_empty()),
        )?;
        let configured_base_url = attached_provider
            .as_ref()
            .map(|provider| provider.base_url.clone())
            .or_else(|| read_string(config, "baseUrl"));
        let saved_provider = saved.provider.trim();
        let (base_url, api_key) = if let Some(credentials) = credentials {
            let credential_provider = credentials.provider.trim().to_lowercase();
            let mut accepted = vec![saved_provider.to_lowercase()];
            if let Some(provider) = attached_provider.as_ref() {
                accepted.push(provider.name.trim().to_lowercase());
                accepted.push(provider.id.trim().to_lowercase());
            }
            accepted.retain(|value| !value.is_empty());
            if !accepted.is_empty() && !accepted.contains(&credential_provider) {
                return Err(NativeError::Configuration(
                    "Native runtime credential profile does not match the model provider"
                        .to_string(),
                ));
            }
            let normalized_credentials = normalize_upstream_base_url(&credentials.base_url)?;
            let base_url = normalize_upstream_base_url(
                configured_base_url
                    .as_deref()
                    .unwrap_or(&credentials.base_url),
            )?;
            if base_url != normalized_credentials {
                return Err(NativeError::Configuration(
                    "Native runtime model endpoint does not match the selected encrypted credential profile"
                        .to_string(),
                ));
            }
            (base_url, credentials.api_key)
        } else {
            let saved_provider_lower = saved_provider.to_lowercase();
            if options.require_owner_credentials
                || profile.as_deref().is_some_and(|value| !value.is_empty())
                || !matches!(saved_provider_lower.as_str(), "openai" | "codex")
            {
                return Err(NativeError::Configuration(format!(
                    "Native runtime credentials are not configured for model \"{}\"",
                    saved.model_id
                )));
            }
            let fallback = resolve_codex_config(&self.env).map_err(|_| {
                NativeError::Configuration(format!(
                    "Native runtime credentials are not configured for model \"{}\"",
                    saved.model_id
                ))
            })?;
            let base_url = normalize_upstream_base_url(
                configured_base_url.as_deref().unwrap_or(&fallback.base_url),
            )?;
            if configured_base_url.is_some()
                && base_url != normalize_upstream_base_url(&fallback.base_url)?
            {
                return Err(NativeError::Configuration(
                    "Native runtime model endpoint does not match the configured Codex endpoint"
                        .to_string(),
                ));
            }
            (base_url, fallback.api_key)
        };
        let model = if saved.model_id.trim().is_empty() {
            requested.to_string()
        } else {
            saved.model_id.trim().to_string()
        };
        Ok(NativeModelConfig {
            model,
            base_url,
            api_key,
            provider: if saved_provider.is_empty() {
                "openai".to_string()
            } else {
                saved_provider.to_string()
            },
            wire_api,
            context_window: read_token_limit(config, CONTEXT_KEYS, MIN_CONTEXT_WINDOW),
            options: request_options(config),
            capabilities: resolve_native_provider_capabilities(config),
        })
    }
}

const CONTEXT_KEYS: &[&str] = &[
    "max_input_tokens",
    "contextWindow",
    "context_window",
    "modelContextWindow",
    "model_context_window",
    "maxContextTokens",
    "max_context_tokens",
];
const OUTPUT_KEYS: &[&str] = &["max_output_tokens", "maxTokens"];

fn request_options(config: Option<&Value>) -> NativeRequestOptions {
    let reasoning_effort = read_string(config, "reasoningEffort")
        .or_else(|| read_string(config, "defaultReasoningEffort"))
        .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string());
    let capabilities = resolve_native_provider_capabilities(config);
    NativeRequestOptions {
        temperature: read_number(config, "temperature", 0.0, 2.0),
        top_p: read_number(config, "topP", 0.0, 1.0),
        max_tokens: read_token_limit(config, OUTPUT_KEYS, 1),
        reasoning_effort: Some(reasoning_effort),
        parallel_tool_calls: (capabilities.parallel_tool_calls
            == NativeProviderCapabilityStatus::Unsupported)
            .then_some(false),
        include_usage: capabilities.usage == NativeProviderCapabilityStatus::Supported,
        stream_idle_timeout: None,
    }
}

fn read_string(config: Option<&Value>, key: &str) -> Option<String> {
    config?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_number(config: Option<&Value>, key: &str, minimum: f64, maximum: f64) -> Option<f64> {
    let value = config?.get(key)?;
    let value = match value {
        Value::Number(value) => value.as_f64()?,
        Value::String(value) => value.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (value.is_finite() && value >= minimum && value <= maximum).then_some(value)
}

fn read_token_limit(config: Option<&Value>, keys: &[&str], minimum: u64) -> Option<u64> {
    for key in keys {
        let Some(value) = config?.get(*key) else {
            continue;
        };
        let value = match value {
            Value::Number(value) => value.as_u64(),
            Value::String(value) => value.trim().parse::<u64>().ok(),
            _ => None,
        };
        if let Some(value) = value.filter(|value| *value >= minimum && *value <= MAX_TOKEN_LIMIT) {
            return Some(value);
        }
    }
    None
}

struct CodexFallback {
    base_url: String,
    api_key: String,
    reasoning_effort: Option<String>,
}

fn resolve_codex_config(env: &HashMap<String, String>) -> NativeResult<CodexFallback> {
    let env_base = ["CODEX_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"]
        .into_iter()
        .find_map(|key| non_empty(env.get(key)));
    let env_api_key = ["CODEX_API_KEY", "OPENAI_API_KEY", "CCHAT_OPENAI_API_KEY"]
        .into_iter()
        .find_map(|key| non_empty(env.get(key)));
    let files = load_codex_files(env);
    let api_key = env_api_key.or(files.api_key).ok_or_else(|| {
        NativeError::Configuration(
            "Codex credentials not found. Provide CODEX_API_KEY or configure ADS with saved credentials."
                .to_string(),
        )
    })?;
    let base_url = env_base
        .or(files.base_url)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    Ok(CodexFallback {
        base_url,
        api_key,
        reasoning_effort: files.reasoning_effort,
    })
}

#[derive(Default)]
struct CodexFiles {
    base_url: Option<String>,
    api_key: Option<String>,
    reasoning_effort: Option<String>,
}

fn load_codex_files(env: &HashMap<String, String>) -> CodexFiles {
    let home = codex_home(env);
    let mut result = CodexFiles::default();
    if let Ok(raw) = fs::read_to_string(home.join("config.toml")) {
        if let Ok(value) = raw.parse::<toml::Value>() {
            if let Some(providers) = value.get("model_providers").and_then(toml::Value::as_table) {
                let selected = value
                    .get("model_provider")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let provider = selected
                    .and_then(|key| providers.get(key))
                    .or_else(|| providers.values().next());
                if let Some(provider) = provider.and_then(toml::Value::as_table) {
                    result.base_url = toml_string(provider.get("base_url"));
                    result.api_key = toml_string(provider.get("api_key"));
                    result.reasoning_effort = ["model_reasoning_effort", "reasoning_effort"]
                        .into_iter()
                        .find_map(|key| toml_string(provider.get(key)));
                }
            }
            if result.reasoning_effort.is_none() {
                result.reasoning_effort = ["model_reasoning_effort", "reasoning_effort"]
                    .into_iter()
                    .find_map(|key| toml_string(value.get(key)));
            }
        }
    }
    if let Ok(raw) = fs::read_to_string(home.join("auth.json")) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if let Some(api_key) = value
                .get("OPENAI_API_KEY")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                result.api_key = result.api_key.or_else(|| Some(api_key.to_string()));
            }
        }
    }
    result
}

fn codex_home(env: &HashMap<String, String>) -> PathBuf {
    let home = non_empty(env.get("HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let raw = env
        .get("CODEX_HOME")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if raw.is_empty() {
        return home.join(".codex");
    }
    if raw == "~" {
        return home;
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.join(rest);
    }
    absolute_path(Path::new(raw))
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn non_empty(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn toml_string(value: Option<&toml::Value>) -> Option<String> {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_unsupported_parallel_tool_calls_to_false() {
        assert_eq!(
            request_options(Some(&json!({"parallelToolCalls": false}))).parallel_tool_calls,
            Some(false)
        );
        assert_eq!(
            request_options(Some(&json!({
                "capabilities": {"parallelToolCalls": "unsupported"}
            })))
            .parallel_tool_calls,
            Some(false)
        );
        assert_eq!(
            request_options(Some(&json!({
                "parallelToolCalls": false,
                "capabilities": {"parallelToolCalls": "supported"}
            })))
            .parallel_tool_calls,
            None
        );
    }
}
