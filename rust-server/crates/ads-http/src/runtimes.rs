use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::{Duration, Instant};

use ads_acp::{
    AcpDriver, AcpPromptRunner, AcpPromptRunnerConfig, AgyAuthConfig, AgyAuthMethod, AgyDriver,
    AgyDriverConfig, AgyIsolatedProfile, AgyLoginHandle, AgyProbeResult, AgyProbeStatus,
    AgyProfileMode, logout_agy_profile, probe_agy_runtime, resolve_agy_binary,
    resolve_agy_profile_dir, start_agy_login, validate_agy_login_response,
};
use ads_contract::models::ModelConfig;
use ads_contract::time::now_unix_millis;
use ads_runtime::scheduler::{ScheduleExecuteFuture, ScheduleExecutor, SchedulerExecutionInput};
use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueFuture, PromptQueueRunOutcome,
    PromptQueueRunner, PromptRunContext,
};
use ads_state::{StateDb, StateError, StateResult, UpstreamCredentialStore, UpstreamCredentials};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::ws::WebSocketHub;

pub const NATIVE_AGENT_ID: &str = "native";
pub const CODEX_AGENT_ID: &str = "codex";
pub const AGY_DEFAULT_AGENT_ID: &str = "agy";
pub const AGY_DEFAULT_ACCOUNT_ID: &str = "default";
pub const AGY_ACCOUNTS_NAMESPACE: &str = "web_agy_accounts";
pub const LANE_AGENT_NAMESPACE: &str = "web_lane_agent";

const AGY_CREDENTIAL_OWNER: &str = "runtime:agy";
const AGY_CREDENTIAL_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1";
const AGY_CREDENTIAL_PROVIDER: &str = "antigravity";
const MAX_AGY_ACCOUNTS: usize = 32;
const ACTIVE_LOGIN_TTL: Duration = Duration::from_secs(10 * 60);
const EFFORT_ORDER: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentDescriptor {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyAccountRecord {
    pub id: String,
    pub label: String,
    pub auth_method: AgyAuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_location: Option<String>,
    pub profile_dir: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyAccountView {
    pub id: String,
    pub agent_id: String,
    pub label: String,
    pub is_default: bool,
    pub auth_method: AgyAuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_location: Option<String>,
    pub has_api_key: bool,
    pub ready: bool,
    pub status: AgyProbeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub model_count: usize,
    pub login_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyLoginStartView {
    pub account_id: String,
    pub agent_id: String,
    pub flow_id: String,
    pub authorization_url: String,
    pub redirect_uri: String,
    pub state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgyAccountInput {
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub auth_method: AgyAuthMethod,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub gcp_project: Option<String>,
    #[serde(default)]
    pub gcp_location: Option<String>,
}

#[derive(Debug)]
pub enum RuntimeApiError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Unavailable(String),
    Internal(String),
}

impl std::fmt::Display for RuntimeApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(msg)
            | Self::NotFound(msg)
            | Self::Conflict(msg)
            | Self::Unavailable(msg)
            | Self::Internal(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for RuntimeApiError {}

impl From<StateError> for RuntimeApiError {
    fn from(error: StateError) -> Self {
        match error {
            StateError::InvalidInput(message) => Self::BadRequest(message),
            other => Self::Internal(other.to_string()),
        }
    }
}

struct ManagedAgyRuntime {
    generation: u64,
    account_id: String,
    agent_id: String,
    label: String,
    is_default: bool,
    auth_method: AgyAuthMethod,
    gcp_project: Option<String>,
    gcp_location: Option<String>,
    has_api_key: bool,
    driver_config: AgyDriverConfig,
    runner: Arc<AcpPromptRunner>,
    probe: AgyProbeResult,
}

struct ActiveAgyLogin {
    authorization_url: String,
    created_at: Instant,
    handle: AgyLoginHandle,
}

#[derive(Clone)]
pub struct RuntimeRegistryConfig {
    pub db: StateDb,
    pub state_dir: PathBuf,
    pub default_workspace_root: PathBuf,
    pub preferred_default_agent_id: String,
    pub native_runner: Option<Arc<dyn PromptQueueRunner>>,
    pub native_scheduler: Option<Arc<dyn ScheduleExecutor>>,
    pub codex_runner: Option<Arc<dyn PromptQueueRunner>>,
    pub codex_scheduler: Option<Arc<dyn ScheduleExecutor>>,
    pub codex_binary: String,
    pub agy_binary: String,
    pub agy_probe_timeout: Duration,
}

impl RuntimeRegistryConfig {
    pub fn new(db: StateDb, state_dir: PathBuf, default_workspace_root: PathBuf) -> Self {
        let preferred_default_agent_id =
            resolve_initial_default_agent(std::env::var("ADS_AGENT_RUNTIME").ok().as_deref());
        let codex_binary = std::env::var("ADS_CODEX_BIN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "codex".to_string());
        let agy_binary = std::env::var(ads_acp::AGY_BINARY_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| ads_acp::DEFAULT_AGY_BINARY.to_string());
        Self {
            db,
            state_dir,
            default_workspace_root,
            preferred_default_agent_id,
            native_runner: None,
            native_scheduler: None,
            codex_runner: None,
            codex_scheduler: None,
            codex_binary,
            agy_binary,
            agy_probe_timeout: Duration::from_secs(20),
        }
    }
}

/// Maps `ADS_AGENT_RUNTIME` (if configured) to an initial default agent ID for backwards
/// compatibility, without hiding or disabling other probed runtimes.
pub fn resolve_initial_default_agent(raw: Option<&str>) -> String {
    let value = raw.unwrap_or_default().trim().to_ascii_lowercase();
    match value.as_str() {
        "" | "native" | "in-process" => NATIVE_AGENT_ID.to_string(),
        "codex" | "codex-app-server" | "cli" => CODEX_AGENT_ID.to_string(),
        "agy" | "antigravity" => AGY_DEFAULT_AGENT_ID.to_string(),
        other if other.starts_with("agy:") => other.to_string(),
        _ => CODEX_AGENT_ID.to_string(),
    }
}

pub struct RuntimeRegistry {
    db: StateDb,
    credentials: UpstreamCredentialStore,
    state_dir: PathBuf,
    default_workspace_root: PathBuf,
    preferred_default_agent_id: String,
    native_runner: Option<Arc<dyn PromptQueueRunner>>,
    native_scheduler: Option<Arc<dyn ScheduleExecutor>>,
    codex_runner: Option<Arc<dyn PromptQueueRunner>>,
    codex_scheduler: Option<Arc<dyn ScheduleExecutor>>,
    codex_binary: String,
    codex_status: RwLock<(bool, Option<String>)>,
    agy_binary: String,
    agy_probe_timeout: Duration,
    next_generation: AtomicU64,
    agy_entries: RwLock<BTreeMap<String, ManagedAgyRuntime>>,
    active_logins: Mutex<HashMap<String, ActiveAgyLogin>>,
    mutation_lock: Mutex<()>,
    probe_lock: Mutex<()>,
    ws_hub: RwLock<Option<Arc<WebSocketHub>>>,
}

impl RuntimeRegistry {
    pub fn new(config: RuntimeRegistryConfig) -> Arc<Self> {
        let credentials = UpstreamCredentialStore::for_state_db(config.db.path());
        let codex_initial = probe_codex_binary(&config.codex_binary, config.codex_runner.is_some());
        let mut agy_entries = BTreeMap::new();
        let mut generation_seq: u64 = 1;

        // Register host-default `agy` runtime.
        let default_cfg = AgyDriverConfig::default()
            .with_id(AGY_DEFAULT_AGENT_ID)
            .with_binary(&config.agy_binary);
        let default_probe = initial_agy_probe_state(&default_cfg, true);
        let default_runner = build_agy_runner(
            config.db.clone(),
            default_cfg.clone(),
            AGY_DEFAULT_AGENT_ID,
            None,
        );
        let default_gen = generation_seq;
        generation_seq += 1;
        agy_entries.insert(
            AGY_DEFAULT_AGENT_ID.to_string(),
            ManagedAgyRuntime {
                generation: default_gen,
                account_id: AGY_DEFAULT_ACCOUNT_ID.to_string(),
                agent_id: AGY_DEFAULT_AGENT_ID.to_string(),
                label: "Antigravity".to_string(),
                is_default: true,
                auth_method: AgyAuthMethod::OAuthPersonal,
                gcp_project: None,
                gcp_location: None,
                has_api_key: false,
                driver_config: default_cfg,
                runner: default_runner,
                probe: default_probe,
            },
        );

        // Load persisted isolated `agy` accounts from StateDb.
        if let Ok(records) = load_agy_account_records(&config.db) {
            for record in records {
                let api_key = read_account_api_key(&config.db, &credentials, &record.id);
                let has_api_key = api_key.is_some();
                let driver_cfg = build_isolated_agy_driver_config(
                    &config.agy_binary,
                    config.agy_probe_timeout,
                    &record,
                    api_key,
                );
                let agent_id = agy_agent_id(&record.id);
                let probe = initial_agy_probe_state(&driver_cfg, false);
                let runner = build_agy_runner(
                    config.db.clone(),
                    driver_cfg.clone(),
                    &agent_id,
                    Some(&record.id),
                );
                let entry_gen = generation_seq;
                generation_seq += 1;
                agy_entries.insert(
                    agent_id.clone(),
                    ManagedAgyRuntime {
                        generation: entry_gen,
                        account_id: record.id,
                        agent_id,
                        label: record.label,
                        is_default: false,
                        auth_method: record.auth_method,
                        gcp_project: record.gcp_project,
                        gcp_location: record.gcp_location,
                        has_api_key,
                        driver_config: driver_cfg,
                        runner,
                        probe,
                    },
                );
            }
        }

        Arc::new(Self {
            db: config.db,
            credentials,
            state_dir: config.state_dir,
            default_workspace_root: config.default_workspace_root,
            preferred_default_agent_id: config.preferred_default_agent_id,
            native_runner: config.native_runner,
            native_scheduler: config.native_scheduler,
            codex_runner: config.codex_runner,
            codex_scheduler: config.codex_scheduler,
            codex_binary: config.codex_binary,
            codex_status: RwLock::new(codex_initial),
            agy_binary: config.agy_binary,
            agy_probe_timeout: config.agy_probe_timeout,
            next_generation: AtomicU64::new(generation_seq),
            agy_entries: RwLock::new(agy_entries),
            active_logins: Mutex::new(HashMap::new()),
            mutation_lock: Mutex::new(()),
            probe_lock: Mutex::new(()),
            ws_hub: RwLock::new(None),
        })
    }

    fn alloc_generation(&self) -> u64 {
        self.next_generation.fetch_add(1, Ordering::Relaxed)
    }

    async fn sweep_expired_logins(&self) {
        let expired: Vec<ActiveAgyLogin> = {
            let mut guard = self.active_logins.lock().await;
            let now = Instant::now();
            let expired_keys: Vec<String> = guard
                .iter()
                .filter(|(_, login)| now.duration_since(login.created_at) >= ACTIVE_LOGIN_TTL)
                .map(|(k, _)| k.clone())
                .collect();
            expired_keys
                .into_iter()
                .filter_map(|key| guard.remove(&key))
                .collect()
        };
        for login in expired {
            login.handle.cancel().await;
        }
    }

    pub fn attach_ws_hub(&self, hub: Arc<WebSocketHub>) {
        *self.ws_hub.write().expect("runtime ws hub lock") = Some(hub);
    }

    /// Launches a non-blocking startup probe of `agy` and saved isolated accounts sequentially
    /// (avoiding PyInstaller unpack storms) and broadcasts updated availability to WebSockets.
    pub fn spawn_startup_probe(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            registry.probe_all().await;
        })
    }

    pub async fn probe_all(&self) {
        let _guard = self.probe_lock.lock().await;
        let codex_binary = self.codex_binary.clone();
        let has_codex = self.codex_runner.is_some();
        let codex_state =
            tokio::task::spawn_blocking(move || probe_codex_binary(&codex_binary, has_codex))
                .await
                .unwrap_or((false, Some("Codex binary probe failed.".to_string())));
        *self.codex_status.write().expect("codex status lock") = codex_state;

        let targets: Vec<(String, u64, AgyDriverConfig)> = {
            let entries = self.agy_entries.read().expect("agy entries read lock");
            entries
                .values()
                .map(|entry| {
                    (
                        entry.agent_id.clone(),
                        entry.generation,
                        entry.driver_config.clone(),
                    )
                })
                .collect()
        };

        for (agent_id, captured_generation, driver_config) in targets {
            let probe = probe_agy_runtime(&driver_config, &self.default_workspace_root).await;
            let mut entries = self.agy_entries.write().expect("agy entries write lock");
            if let Some(entry) = entries.get_mut(&agent_id)
                && entry.generation == captured_generation
            {
                entry.probe = probe;
            }
        }

        self.broadcast_agents_snapshot();
    }

    pub fn list_agents(&self) -> Vec<RuntimeAgentDescriptor> {
        let mut agents = Vec::new();
        if self.native_runner.is_some() {
            agents.push(RuntimeAgentDescriptor {
                id: NATIVE_AGENT_ID.to_string(),
                name: "Native".to_string(),
                kind: "native".to_string(),
                ready: true,
                error: None,
                account_id: None,
                auth_method: None,
                version: None,
            });
        }
        if self.codex_runner.is_some() {
            let (ready, error) = self.codex_status.read().expect("codex status lock").clone();
            agents.push(RuntimeAgentDescriptor {
                id: CODEX_AGENT_ID.to_string(),
                name: "Codex".to_string(),
                kind: "codex".to_string(),
                ready,
                error,
                account_id: None,
                auth_method: None,
                version: None,
            });
        }

        let agy_entries = self.agy_entries.read().expect("agy entries read lock");
        // Emit host-default `agy` first, followed by isolated `agy:<account_id>` entries.
        if let Some(default_entry) = agy_entries.get(AGY_DEFAULT_AGENT_ID) {
            agents.push(entry_to_descriptor(default_entry));
        }
        for (agent_id, entry) in agy_entries.iter() {
            if agent_id == AGY_DEFAULT_AGENT_ID {
                continue;
            }
            agents.push(entry_to_descriptor(entry));
        }
        agents
    }

    pub fn default_active_agent_id(&self) -> String {
        let agents = self.list_agents();
        if agents
            .iter()
            .any(|agent| agent.id == self.preferred_default_agent_id && agent.ready)
        {
            return self.preferred_default_agent_id.clone();
        }
        if let Some(first_ready) = agents.iter().find(|agent| agent.ready) {
            return first_ready.id.clone();
        }
        self.preferred_default_agent_id.clone()
    }

    pub fn resolve_active_agent_for_lane(&self, logical_history_key: &str) -> String {
        if let Ok(Some(saved)) = load_lane_agent(&self.db, logical_history_key)
            && self.is_agent_ready(&saved).is_ok()
        {
            return saved;
        }
        self.default_active_agent_id()
    }

    pub fn save_lane_agent(&self, logical_history_key: &str, agent_id: &str) -> StateResult<()> {
        save_lane_agent(&self.db, logical_history_key, agent_id)
    }

    pub fn is_agent_ready(&self, agent_id: &str) -> Result<(), String> {
        let target = agent_id.trim();
        if target.is_empty() {
            return Err("Agent ID is required.".to_string());
        }
        let agents = self.list_agents();
        let Some(agent) = agents.into_iter().find(|entry| entry.id == target) else {
            return Err(format!("Unknown runtime agent '{target}'."));
        };
        if agent.ready {
            Ok(())
        } else {
            Err(agent
                .error
                .unwrap_or_else(|| format!("Runtime '{target}' is not ready.")))
        }
    }

    pub fn is_codex_ready(&self) -> bool {
        self.codex_runner.is_some() && self.codex_status.read().expect("codex status lock").0
    }

    pub fn runner_for(&self, agent_id: &str) -> Result<Arc<dyn PromptQueueRunner>, String> {
        let target = agent_id.trim();
        if target == NATIVE_AGENT_ID {
            return self
                .native_runner
                .clone()
                .ok_or_else(|| "Native runtime is not enabled.".to_string());
        }
        if target == CODEX_AGENT_ID {
            self.is_agent_ready(CODEX_AGENT_ID)?;
            return self
                .codex_runner
                .clone()
                .ok_or_else(|| "Codex runtime is not enabled.".to_string());
        }
        let entries = self.agy_entries.read().expect("agy entries read lock");
        let Some(entry) = entries.get(target) else {
            return Err(format!("Unknown runtime agent '{target}'."));
        };
        if entry.probe.status != AgyProbeStatus::Ready {
            return Err(describe_agy_probe_error(&entry.probe)
                .unwrap_or_else(|| format!("Antigravity runtime '{target}' is not ready.")));
        }
        Ok(Arc::clone(&entry.runner) as Arc<dyn PromptQueueRunner>)
    }

    pub fn any_runner_for_reconcile(&self, agent_id: &str) -> Option<Arc<dyn PromptQueueRunner>> {
        if agent_id == NATIVE_AGENT_ID {
            return self.native_runner.clone();
        }
        if agent_id == CODEX_AGENT_ID {
            return self.codex_runner.clone();
        }
        if let Some(entry) = self
            .agy_entries
            .read()
            .expect("agy entries read lock")
            .get(agent_id)
        {
            return Some(Arc::clone(&entry.runner) as Arc<dyn PromptQueueRunner>);
        }
        self.native_runner
            .clone()
            .or_else(|| self.codex_runner.clone())
    }

    pub fn schedule_executor_for(
        &self,
        preferred_agent: Option<&str>,
    ) -> Option<Arc<dyn ScheduleExecutor>> {
        let target = preferred_agent
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| self.default_active_agent_id());
        if target == NATIVE_AGENT_ID {
            return self.native_scheduler.clone();
        }
        if target == CODEX_AGENT_ID && self.is_codex_ready() {
            return self.codex_scheduler.clone();
        }
        if let Some(entry) = self
            .agy_entries
            .read()
            .expect("agy entries read lock")
            .get(&target)
            && entry.probe.status == AgyProbeStatus::Ready
        {
            return Some(Arc::clone(&entry.runner) as Arc<dyn ScheduleExecutor>);
        }
        self.native_scheduler
            .clone()
            .or_else(|| self.codex_scheduler.clone())
    }

    /// Synthesizes live `ModelConfig` entries for all discovered models on ready `agy*` runtimes.
    pub fn discovered_agy_models(&self, existing_ids: &HashSet<String>) -> Vec<ModelConfig> {
        struct AggregatedModel {
            model_id: String,
            display_name: String,
            allowed_agents: Vec<String>,
            efforts: HashSet<String>,
        }

        let entries = self.agy_entries.read().expect("agy entries read lock");
        let mut ordered_keys: Vec<String> = Vec::new();
        if entries.contains_key(AGY_DEFAULT_AGENT_ID) {
            ordered_keys.push(AGY_DEFAULT_AGENT_ID.to_string());
        }
        for key in entries.keys() {
            if key != AGY_DEFAULT_AGENT_ID {
                ordered_keys.push(key.clone());
            }
        }

        let mut model_order: Vec<String> = Vec::new();
        let mut by_model_id: HashMap<String, AggregatedModel> = HashMap::new();
        for agent_id in ordered_keys {
            let Some(entry) = entries.get(&agent_id) else {
                continue;
            };
            if entry.probe.status != AgyProbeStatus::Ready {
                continue;
            }
            let agent_efforts: Vec<String> = entry
                .probe
                .thought_levels
                .iter()
                .map(|opt| opt.value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .collect();

            for model in &entry.probe.models {
                let value = model.value.trim();
                if value.is_empty() {
                    continue;
                }
                let display_name = if model.name.trim().is_empty() {
                    value.to_string()
                } else {
                    model.name.trim().to_string()
                };
                if let Some(existing) = by_model_id.get_mut(value) {
                    if !existing.allowed_agents.contains(&agent_id) {
                        existing.allowed_agents.push(agent_id.clone());
                    }
                    for effort in &agent_efforts {
                        existing.efforts.insert(effort.clone());
                    }
                } else {
                    model_order.push(value.to_string());
                    let mut efforts = HashSet::new();
                    for effort in &agent_efforts {
                        efforts.insert(effort.clone());
                    }
                    by_model_id.insert(
                        value.to_string(),
                        AggregatedModel {
                            model_id: value.to_string(),
                            display_name,
                            allowed_agents: vec![agent_id.clone()],
                            efforts,
                        },
                    );
                }
            }
        }

        let mut results = Vec::with_capacity(model_order.len());
        for (index, key) in model_order.into_iter().enumerate() {
            let Some(item) = by_model_id.remove(&key) else {
                continue;
            };
            let mut efforts: Vec<String> = item.efforts.into_iter().collect();
            efforts.sort_by_key(|effort| {
                EFFORT_ORDER
                    .iter()
                    .position(|candidate| candidate == effort)
                    .unwrap_or(EFFORT_ORDER.len())
            });
            let id = if existing_ids.contains(&item.model_id) {
                format!("agy:{}", item.model_id)
            } else {
                item.model_id.clone()
            };
            let mut cfg = serde_json::Map::new();
            cfg.insert("allowedAgents".to_string(), json!(item.allowed_agents));
            if !efforts.is_empty() {
                cfg.insert("reasoningEfforts".to_string(), json!(efforts));
            }
            cfg.insert("runtime".to_string(), json!("agy"));
            results.push(ModelConfig {
                id,
                model_id: item.model_id,
                display_name: item.display_name,
                provider: "antigravity".to_string(),
                provider_id: None,
                is_enabled: true,
                is_default: index == 0,
                config_json: Some(Value::Object(cfg)),
                updated_at: Some(now_unix_millis()),
            });
        }
        results
    }

    pub async fn list_agy_accounts(&self) -> Vec<AgyAccountView> {
        self.sweep_expired_logins().await;
        let pending_urls: HashMap<String, String> = {
            let logins = self.active_logins.lock().await;
            logins
                .iter()
                .map(|(account_id, active)| (account_id.clone(), active.authorization_url.clone()))
                .collect()
        };
        let entries = self.agy_entries.read().expect("agy entries read lock");
        let mut views = Vec::with_capacity(entries.len());
        if let Some(default_entry) = entries.get(AGY_DEFAULT_AGENT_ID) {
            views.push(entry_to_account_view(
                default_entry,
                pending_urls.get(AGY_DEFAULT_ACCOUNT_ID).cloned(),
            ));
        }
        for (agent_id, entry) in entries.iter() {
            if agent_id == AGY_DEFAULT_AGENT_ID {
                continue;
            }
            views.push(entry_to_account_view(
                entry,
                pending_urls.get(&entry.account_id).cloned(),
            ));
        }
        views
    }

    pub async fn create_or_update_agy_account(
        &self,
        input: UpsertAgyAccountInput,
    ) -> Result<AgyAccountView, RuntimeApiError> {
        let label = input.label.trim().to_string();
        if label.is_empty() || label.chars().count() > 80 {
            return Err(RuntimeApiError::BadRequest(
                "Account label must be between 1 and 80 characters.".to_string(),
            ));
        }
        let requested_id = match input.id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            Some(raw) => Some(validate_account_id(raw)?),
            None => None,
        };
        if let Some(ref id) = requested_id
            && is_reserved_account_id(id)
        {
            return Err(RuntimeApiError::BadRequest(format!(
                "Account ID '{id}' is reserved for the host Antigravity profile."
            )));
        }

        let gcp_project = input
            .gcp_project
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let gcp_location = input
            .gcp_location
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let submitted_api_key = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let auth_method = input.auth_method;

        let (account_id, agent_id, generation, driver_config, old_runner) = {
            let _mutation = self.mutation_lock.lock().await;
            let db = self.db.clone();
            let credentials = self.credentials.clone();
            let state_dir = self.state_dir.clone();
            let label_for_db = label.clone();
            let gcp_project_for_db = gcp_project.clone();
            let gcp_location_for_db = gcp_location.clone();
            let submitted_for_db = submitted_api_key.clone();

            let (account_id, record, effective_api_key) =
                tokio::task::spawn_blocking(move || -> Result<_, RuntimeApiError> {
                    let account_id = match requested_id {
                        Some(id) => id,
                        None => derive_unique_account_id(&db, &label_for_db)?,
                    };
                    let existing_records = load_agy_account_records(&db)?;
                    let existing = existing_records
                        .iter()
                        .find(|r| r.id == account_id)
                        .cloned();
                    if existing.is_none() && existing_records.len() >= MAX_AGY_ACCOUNTS {
                        return Err(RuntimeApiError::BadRequest(format!(
                            "Maximum of {MAX_AGY_ACCOUNTS} Antigravity accounts reached."
                        )));
                    }

                    let existing_api_key = read_account_api_key(&db, &credentials, &account_id);
                    let effective_api_key = match auth_method {
                        AgyAuthMethod::GeminiApiKey | AgyAuthMethod::AgentPlatform => {
                            submitted_for_db.clone().or(existing_api_key)
                        }
                        AgyAuthMethod::OAuthPersonal | AgyAuthMethod::OAuthBusiness => None,
                    };

                    let auth_cfg = AgyAuthConfig {
                        method: auth_method,
                        api_key: effective_api_key.clone(),
                        gcp_project: gcp_project_for_db.clone(),
                        gcp_location: gcp_location_for_db.clone(),
                    };
                    auth_cfg.validate().map_err(RuntimeApiError::BadRequest)?;

                    let now = now_unix_millis();
                    let profile_dir = resolve_agy_profile_dir(&state_dir, &account_id);
                    let record = AgyAccountRecord {
                        id: account_id.clone(),
                        label: label_for_db,
                        auth_method,
                        gcp_project: gcp_project_for_db,
                        gcp_location: gcp_location_for_db,
                        profile_dir: profile_dir.to_string_lossy().to_string(),
                        created_at: existing.as_ref().map_or(now, |r| r.created_at),
                        updated_at: now,
                    };

                    // Persist API key encrypted via UpstreamCredentialStore (never plaintext in kv_state or settings.json).
                    let connection = db.connect()?;
                    let cred_profile = agy_credential_profile(&account_id);
                    match auth_method {
                        AgyAuthMethod::GeminiApiKey | AgyAuthMethod::AgentPlatform => {
                            if let Some(new_key) = submitted_for_db.as_deref() {
                                credentials.save(
                                    &connection,
                                    AGY_CREDENTIAL_OWNER,
                                    &UpstreamCredentials {
                                        base_url: AGY_CREDENTIAL_BASE_URL.to_string(),
                                        provider: AGY_CREDENTIAL_PROVIDER.to_string(),
                                        api_key: new_key.to_string(),
                                    },
                                    Some(&cred_profile),
                                )?;
                            }
                        }
                        AgyAuthMethod::OAuthPersonal | AgyAuthMethod::OAuthBusiness => {
                            let _ = credentials.delete(
                                &connection,
                                AGY_CREDENTIAL_OWNER,
                                Some(&cred_profile),
                            );
                        }
                    }
                    save_agy_account_record(&db, &record)?;
                    Ok((account_id, record, effective_api_key))
                })
                .await
                .map_err(|error| RuntimeApiError::Internal(error.to_string()))??;

            if let Some(active) = self.active_logins.lock().await.remove(&account_id) {
                active.handle.cancel().await;
            }

            let agent_id = agy_agent_id(&account_id);
            let driver_config = build_isolated_agy_driver_config(
                &self.agy_binary,
                self.agy_probe_timeout,
                &record,
                effective_api_key.clone(),
            );
            let runner = build_agy_runner(
                self.db.clone(),
                driver_config.clone(),
                &agent_id,
                Some(&account_id),
            );
            let mut initial = initial_agy_probe_state(&driver_config, false);
            if auth_method.uses_browser() && initial.status != AgyProbeStatus::BinaryNotFound {
                initial.status = AgyProbeStatus::AuthenticationRequired;
                initial.message =
                    Some("Sign in required for this Antigravity account.".to_string());
            }

            let generation = self.alloc_generation();
            let old_runner = {
                let mut entries = self.agy_entries.write().expect("agy entries write lock");
                entries
                    .insert(
                        agent_id.clone(),
                        ManagedAgyRuntime {
                            generation,
                            account_id: account_id.clone(),
                            agent_id: agent_id.clone(),
                            label: record.label.clone(),
                            is_default: false,
                            auth_method: record.auth_method,
                            gcp_project: record.gcp_project.clone(),
                            gcp_location: record.gcp_location.clone(),
                            has_api_key: effective_api_key.is_some(),
                            driver_config: driver_config.clone(),
                            runner,
                            probe: initial,
                        },
                    )
                    .map(|old| old.runner)
            };
            (account_id, agent_id, generation, driver_config, old_runner)
        };

        if let Some(old_runner) = old_runner {
            old_runner.shutdown().await;
        }

        if !auth_method.uses_browser() {
            let probe = {
                let _guard = self.probe_lock.lock().await;
                probe_agy_runtime(&driver_config, &self.default_workspace_root).await
            };
            let mut entries = self.agy_entries.write().expect("agy entries write lock");
            if let Some(entry) = entries.get_mut(&agent_id)
                && entry.generation == generation
            {
                entry.probe = probe;
            }
        }

        self.broadcast_agents_snapshot();
        self.account_view_by_id(&account_id).await
    }

    pub async fn delete_agy_account(&self, account_id: &str) -> Result<bool, RuntimeApiError> {
        let account_id = validate_account_id(account_id)?;
        if is_reserved_account_id(&account_id) {
            return Err(RuntimeApiError::BadRequest(
                "Cannot delete the built-in default Antigravity profile.".to_string(),
            ));
        }

        let _mutation = self.mutation_lock.lock().await;
        if let Some(active) = self.active_logins.lock().await.remove(&account_id) {
            active.handle.cancel().await;
        }

        let agent_id = agy_agent_id(&account_id);
        let removed_entry = self
            .agy_entries
            .write()
            .expect("agy entries write lock")
            .remove(&agent_id);
        if let Some(entry) = removed_entry {
            entry.runner.shutdown().await;
        }

        let db = self.db.clone();
        let credentials = self.credentials.clone();
        let state_dir = self.state_dir.clone();
        let id_for_db = account_id.clone();
        let deleted_record =
            tokio::task::spawn_blocking(move || -> Result<bool, RuntimeApiError> {
                let deleted_record = delete_agy_account_record(&db, &id_for_db)?;
                let connection = db.connect()?;
                let _ = credentials.delete(
                    &connection,
                    AGY_CREDENTIAL_OWNER,
                    Some(&agy_credential_profile(&id_for_db)),
                );
                let profile_dir = resolve_agy_profile_dir(&state_dir, &id_for_db);
                let providers_root = state_dir.join("providers").join("agy");
                if profile_dir.starts_with(&providers_root) && profile_dir.exists() {
                    let _ = fs::remove_dir_all(&profile_dir);
                }
                Ok(deleted_record)
            })
            .await
            .map_err(|error| RuntimeApiError::Internal(error.to_string()))??;

        self.broadcast_agents_snapshot();
        Ok(deleted_record)
    }

    pub async fn start_agy_account_login(
        &self,
        account_id: &str,
    ) -> Result<AgyLoginStartView, RuntimeApiError> {
        self.sweep_expired_logins().await;
        let account_id = normalize_target_account_id(account_id)?;
        let (agent_id, captured_generation, driver_config, uses_browser) = {
            let entries = self.agy_entries.read().expect("agy entries read lock");
            let entry = find_entry_by_account_id(&entries, &account_id).ok_or_else(|| {
                RuntimeApiError::NotFound(format!("Unknown Antigravity account '{account_id}'."))
            })?;
            (
                entry.agent_id.clone(),
                entry.generation,
                entry.driver_config.clone(),
                entry.auth_method.uses_browser(),
            )
        };
        if !uses_browser {
            return Err(RuntimeApiError::BadRequest(
                "Interactive Google OAuth login is only used for OAuth accounts.".to_string(),
            ));
        }

        // Cancel any previous login flow for this account before spawning a fresh one.
        if let Some(previous) = self.active_logins.lock().await.remove(&account_id) {
            previous.handle.cancel().await;
        }

        let handle = start_agy_login(&driver_config, &HashMap::new())
            .await
            .map_err(|error| {
                eprintln!("[ads-http] agy login startup failed for {account_id}: {error}");
                RuntimeApiError::Unavailable(
                    "Unable to start Antigravity sign-in flow. Ensure 'agy' CLI is installed and reachable."
                        .to_string(),
                )
            })?;
        let auth = handle.authorization().clone();
        let flow_id = format!("agy-login-{}", uuid::Uuid::new_v4().simple());

        let still_valid = {
            let entries = self.agy_entries.read().expect("agy entries read lock");
            entries
                .get(&agent_id)
                .is_some_and(|entry| entry.generation == captured_generation)
        };
        if !still_valid {
            handle.cancel().await;
            return Err(RuntimeApiError::Conflict(
                "Account changed or was removed while starting sign-in. Please try again."
                    .to_string(),
            ));
        }

        let replaced = self.active_logins.lock().await.insert(
            account_id.clone(),
            ActiveAgyLogin {
                authorization_url: auth.authorization_url.clone(),
                created_at: Instant::now(),
                handle,
            },
        );
        if let Some(previous) = replaced {
            previous.handle.cancel().await;
        }

        Ok(AgyLoginStartView {
            account_id,
            agent_id,
            flow_id,
            authorization_url: auth.authorization_url,
            redirect_uri: auth.redirect_uri,
            state: auth.state,
        })
    }

    pub async fn complete_agy_account_login(
        &self,
        account_id: &str,
        code: &str,
    ) -> Result<AgyAccountView, RuntimeApiError> {
        self.sweep_expired_logins().await;
        let account_id = normalize_target_account_id(account_id)?;
        let code = code.trim();
        if code.is_empty() {
            return Err(RuntimeApiError::BadRequest(
                "Authorization code or callback URL is required.".to_string(),
            ));
        }

        let mut active = {
            let mut logins = self.active_logins.lock().await;
            let Some(existing) = logins.get(&account_id) else {
                return Err(RuntimeApiError::BadRequest(
                    "No active sign-in flow for this account. Start sign-in first.".to_string(),
                ));
            };
            if validate_agy_login_response(existing.handle.authorization(), code).is_none() {
                return Err(RuntimeApiError::BadRequest(
                    "Invalid authorization code or callback URL. Check the value and try again."
                        .to_string(),
                ));
            }
            logins
                .remove(&account_id)
                .expect("validated active login entry")
        };

        if let Err(error) = active.handle.submit_response(code).await {
            return Err(RuntimeApiError::BadRequest(error.to_string()));
        }

        self.refresh_agy_account(&account_id).await
    }

    pub async fn cancel_agy_account_login(
        &self,
        account_id: &str,
    ) -> Result<bool, RuntimeApiError> {
        self.sweep_expired_logins().await;
        let account_id = normalize_target_account_id(account_id)?;
        if let Some(active) = self.active_logins.lock().await.remove(&account_id) {
            active.handle.cancel().await;
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn logout_agy_account(
        &self,
        account_id: &str,
    ) -> Result<AgyAccountView, RuntimeApiError> {
        let account_id = normalize_target_account_id(account_id)?;
        let _mutation = self.mutation_lock.lock().await;
        if let Some(active) = self.active_logins.lock().await.remove(&account_id) {
            active.handle.cancel().await;
        }

        let new_generation = self.alloc_generation();
        let (agent_id, runner, isolated_dir) = {
            let mut entries = self.agy_entries.write().expect("agy entries write lock");
            let entry = entries
                .values_mut()
                .find(|entry| entry.account_id == account_id)
                .ok_or_else(|| {
                    RuntimeApiError::NotFound(format!(
                        "Unknown Antigravity account '{account_id}'."
                    ))
                })?;
            let isolated_dir = match &entry.driver_config.profile {
                AgyProfileMode::Isolated(profile) => Some(profile.profile_dir.clone()),
                AgyProfileMode::HostDefault => None,
            };
            if isolated_dir.is_none() {
                return Err(RuntimeApiError::BadRequest(
                    "Sign-out is supported on isolated Antigravity accounts; use 'agy' CLI to sign out the host default profile."
                        .to_string(),
                ));
            }
            entry.generation = new_generation;
            (
                entry.agent_id.clone(),
                Arc::clone(&entry.runner),
                isolated_dir,
            )
        };

        runner.shutdown().await;
        if let Some(profile_dir) = isolated_dir {
            tokio::task::spawn_blocking(move || logout_agy_profile(&profile_dir))
                .await
                .map_err(|error| RuntimeApiError::Internal(error.to_string()))?
                .map_err(|error| RuntimeApiError::Internal(error.to_string()))?;
        }

        {
            let mut entries = self.agy_entries.write().expect("agy entries write lock");
            if let Some(entry) = entries.get_mut(&agent_id)
                && entry.generation == new_generation
            {
                entry.probe = AgyProbeResult {
                    status: AgyProbeStatus::AuthenticationRequired,
                    binary_path: entry.probe.binary_path.clone(),
                    version: entry.probe.version.clone(),
                    auth_methods: entry.probe.auth_methods.clone(),
                    models: Vec::new(),
                    thought_levels: Vec::new(),
                    modes: None,
                    config_options: Vec::new(),
                    message: Some("Signed out. Sign in again to use this account.".to_string()),
                    probed_at_ms: now_unix_millis(),
                };
            }
        }

        self.broadcast_agents_snapshot();
        self.account_view_by_id(&account_id).await
    }

    pub async fn refresh_agy_account(
        &self,
        account_id: &str,
    ) -> Result<AgyAccountView, RuntimeApiError> {
        let account_id = normalize_target_account_id(account_id)?;
        let (agent_id, captured_generation, driver_config) = {
            let entries = self.agy_entries.read().expect("agy entries read lock");
            let entry = find_entry_by_account_id(&entries, &account_id).ok_or_else(|| {
                RuntimeApiError::NotFound(format!("Unknown Antigravity account '{account_id}'."))
            })?;
            (
                entry.agent_id.clone(),
                entry.generation,
                entry.driver_config.clone(),
            )
        };

        let probe = {
            let _guard = self.probe_lock.lock().await;
            probe_agy_runtime(&driver_config, &self.default_workspace_root).await
        };
        {
            let mut entries = self.agy_entries.write().expect("agy entries write lock");
            if let Some(entry) = entries.get_mut(&agent_id)
                && entry.generation == captured_generation
            {
                entry.probe = probe;
            }
        }
        self.broadcast_agents_snapshot();
        self.account_view_by_id(&account_id).await
    }

    pub async fn shutdown_all(&self) {
        let logins: Vec<ActiveAgyLogin> = {
            let mut guard = self.active_logins.lock().await;
            guard.drain().map(|(_, value)| value).collect()
        };
        for login in logins {
            login.handle.cancel().await;
        }
        let runners: Vec<Arc<AcpPromptRunner>> = {
            let entries = self.agy_entries.read().expect("agy entries read lock");
            entries.values().map(|e| Arc::clone(&e.runner)).collect()
        };
        for runner in runners {
            runner.shutdown().await;
        }
    }

    async fn account_view_by_id(
        &self,
        account_id: &str,
    ) -> Result<AgyAccountView, RuntimeApiError> {
        self.sweep_expired_logins().await;
        let pending_url = self
            .active_logins
            .lock()
            .await
            .get(account_id)
            .map(|active| active.authorization_url.clone());
        let entries = self.agy_entries.read().expect("agy entries read lock");
        let entry = find_entry_by_account_id(&entries, account_id).ok_or_else(|| {
            RuntimeApiError::NotFound(format!("Unknown Antigravity account '{account_id}'."))
        })?;
        Ok(entry_to_account_view(entry, pending_url))
    }

    fn broadcast_agents_snapshot(&self) {
        let hub = self.ws_hub.read().expect("runtime ws hub lock").clone();
        if let Some(hub) = hub {
            let agents = self.list_agents();
            // Leave `activeAgentId` empty so live clients update availability without
            // overwriting a user's active runtime unless it became unavailable.
            let frame = json!({
                "type": "agents",
                "agents": agents,
            });
            hub.broadcast_agents(&frame);
        }
    }
}

struct ActiveTurnRouteGuard<'a> {
    routes: &'a StdMutex<HashMap<LaneTurnKey, Arc<dyn PromptQueueRunner>>>,
    key: LaneTurnKey,
}

impl Drop for ActiveTurnRouteGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.routes.lock() {
            guard.remove(&self.key);
        }
    }
}

/// Multi-runtime `PromptQueueRunner` + `ScheduleExecutor` dispatching each turn dynamically
/// based on `payload["agentId"]` -> persisted lane preference -> default ready runtime.
pub struct RoutingPromptRunner {
    registry: Arc<RuntimeRegistry>,
    active_routes: StdMutex<HashMap<LaneTurnKey, Arc<dyn PromptQueueRunner>>>,
}

impl RoutingPromptRunner {
    pub fn new(registry: Arc<RuntimeRegistry>) -> Self {
        Self {
            registry,
            active_routes: StdMutex::new(HashMap::new()),
        }
    }

    pub fn registry(&self) -> &Arc<RuntimeRegistry> {
        &self.registry
    }

    fn resolve_target_agent(&self, entry: &LaneTurn) -> String {
        // Reviewer → Acopilot handoff wakes historically carry a legacy `"agentId": "codex"`
        // field from `ReviewVerdictHandoff::to_payload_map()`; always route handoffs to the
        // lane's active ready runtime (falling back to the default ready runtime).
        if entry.kind == LaneTurnKind::AgentHandoff {
            return self
                .registry
                .resolve_active_agent_for_lane(&entry.logical_history_key);
        }
        if let Some(explicit) = entry
            .payload
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return explicit.to_string();
        }
        self.registry
            .resolve_active_agent_for_lane(&entry.logical_history_key)
    }
}

impl PromptQueueRunner for RoutingPromptRunner {
    fn reconcile_lane_turn<'a>(
        &'a self,
        entry: &'a LaneTurn,
    ) -> PromptQueueFuture<'a, StateResult<Option<PromptQueueRunOutcome>>> {
        Box::pin(async move {
            let target = self.resolve_target_agent(entry);
            let Some(runner) = self.registry.any_runner_for_reconcile(&target) else {
                return Ok(None);
            };
            runner.reconcile_lane_turn(entry).await
        })
    }

    fn run_lane_turn<'a>(
        &'a self,
        entry: LaneTurn,
        context: PromptRunContext,
    ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
        Box::pin(async move {
            let target = self.resolve_target_agent(&entry);
            let runner = match self.registry.runner_for(&target) {
                Ok(runner) => runner,
                Err(message) => {
                    let is_auth = message.to_ascii_lowercase().contains("sign in")
                        || message.to_ascii_lowercase().contains("auth");
                    context.emit(json!({
                        "type": "error",
                        "clientMessageId": entry.client_message_id,
                        "message": message,
                        "authRequired": is_auth,
                        "errorInfo": {
                            "code": if is_auth { "acp_auth_required" } else { "runtime_unavailable" },
                            "retryable": false,
                            "needsReset": false,
                        },
                        "ts": now_unix_millis(),
                    }));
                    return Ok(PromptQueueRunOutcome::failure(message));
                }
            };
            let key = entry.key.clone();
            {
                self.active_routes
                    .lock()
                    .expect("routing active turns lock")
                    .insert(key.clone(), Arc::clone(&runner));
            }
            let _guard = ActiveTurnRouteGuard {
                routes: &self.active_routes,
                key,
            };
            runner.run_lane_turn(entry, context).await
        })
    }

    fn abort_lane_turn(&self, entry: &LaneTurn) {
        let active = self
            .active_routes
            .lock()
            .expect("routing active turns lock")
            .get(&entry.key)
            .cloned();
        if let Some(runner) = active {
            runner.abort_lane_turn(entry);
            return;
        }
        let target = self.resolve_target_agent(entry);
        if let Ok(runner) = self.registry.runner_for(&target) {
            runner.abort_lane_turn(entry);
        }
    }
}

impl ScheduleExecutor for RoutingPromptRunner {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a> {
        Box::pin(async move {
            let preferred = std::env::var("ADS_SCHEDULER_AGENT").ok();
            let Some(executor) = self.registry.schedule_executor_for(preferred.as_deref()) else {
                return Err("No ready runtime available for scheduled prompt.".to_string());
            };
            executor.execute(input).await
        })
    }
}

fn agy_agent_id(account_id: &str) -> String {
    if account_id == AGY_DEFAULT_ACCOUNT_ID {
        AGY_DEFAULT_AGENT_ID.to_string()
    } else {
        format!("{AGY_DEFAULT_AGENT_ID}:{account_id}")
    }
}

fn agy_credential_profile(account_id: &str) -> String {
    format!("agy-account-{account_id}")
}

fn is_reserved_account_id(account_id: &str) -> bool {
    account_id == AGY_DEFAULT_ACCOUNT_ID || account_id == AGY_DEFAULT_AGENT_ID
}

fn normalize_target_account_id(raw: &str) -> Result<String, RuntimeApiError> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if is_reserved_account_id(&trimmed) {
        return Ok(AGY_DEFAULT_ACCOUNT_ID.to_string());
    }
    validate_account_id(&trimmed)
}

fn validate_account_id(raw: &str) -> Result<String, RuntimeApiError> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err(RuntimeApiError::BadRequest(
            "Account ID must be 1 to 64 characters.".to_string(),
        ));
    }
    let mut chars = trimmed.chars();
    if !chars
        .next()
        .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        || !chars
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
    {
        return Err(RuntimeApiError::BadRequest(
            "Account ID must start with a letter or digit and contain only lowercase letters, digits, '-' or '_'."
                .to_string(),
        ));
    }
    Ok(trimmed)
}

fn derive_unique_account_id(db: &StateDb, label: &str) -> Result<String, RuntimeApiError> {
    let existing: HashSet<String> = load_agy_account_records(db)?
        .into_iter()
        .map(|record| record.id)
        .collect();
    let mut slug = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 32 {
            break;
        }
    }
    let base = slug.trim_matches('-').to_string();
    let base = if base.is_empty() || is_reserved_account_id(&base) {
        format!("acct-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
    } else {
        base
    };
    if !existing.contains(&base) {
        return Ok(base);
    }
    for suffix in 2..1000 {
        let candidate = format!("{base}-{suffix}");
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Ok(format!(
        "acct-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    ))
}

fn find_entry_by_account_id<'a>(
    entries: &'a BTreeMap<String, ManagedAgyRuntime>,
    account_id: &str,
) -> Option<&'a ManagedAgyRuntime> {
    entries.get(&agy_agent_id(account_id))
}

fn probe_codex_binary(binary: &str, has_runner: bool) -> (bool, Option<String>) {
    if !has_runner {
        return (false, Some("Codex runtime is not registered.".to_string()));
    }
    if resolve_executable(binary).is_some() {
        (true, None)
    } else {
        (
            false,
            Some(format!("Codex CLI binary '{binary}' not found in PATH.")),
        )
    }
}

fn resolve_executable(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() || raw.contains(std::path::MAIN_SEPARATOR) || raw.contains('/') {
        return is_executable_file(candidate).then(|| candidate.to_path_buf());
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let full = dir.join(raw);
        if is_executable_file(&full) {
            return Some(full);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn initial_agy_probe_state(config: &AgyDriverConfig, is_default: bool) -> AgyProbeResult {
    let now = now_unix_millis();
    let Some(binary_path) = resolve_agy_binary(Some(&config.binary)) else {
        return AgyProbeResult {
            status: AgyProbeStatus::BinaryNotFound,
            binary_path: None,
            version: None,
            auth_methods: Vec::new(),
            models: Vec::new(),
            thought_levels: Vec::new(),
            modes: None,
            config_options: Vec::new(),
            message: Some(format!("Antigravity binary '{}' not found.", config.binary)),
            probed_at_ms: now,
        };
    };
    AgyProbeResult {
        status: AgyProbeStatus::Error,
        binary_path: Some(binary_path.to_string_lossy().to_string()),
        version: None,
        auth_methods: Vec::new(),
        models: Vec::new(),
        thought_levels: Vec::new(),
        modes: None,
        config_options: Vec::new(),
        message: Some(if is_default {
            "Probing Antigravity runtime...".to_string()
        } else {
            "Pending probe or sign-in.".to_string()
        }),
        probed_at_ms: now,
    }
}

fn build_isolated_agy_driver_config(
    binary: &str,
    probe_timeout: Duration,
    record: &AgyAccountRecord,
    api_key: Option<String>,
) -> AgyDriverConfig {
    let profile =
        AgyIsolatedProfile::new(PathBuf::from(&record.profile_dir)).with_auth(AgyAuthConfig {
            method: record.auth_method,
            api_key,
            gcp_project: record.gcp_project.clone(),
            gcp_location: record.gcp_location.clone(),
        });
    let mut cfg = AgyDriverConfig::isolated(profile)
        .with_id(agy_agent_id(&record.id))
        .with_binary(binary);
    cfg.probe_timeout = probe_timeout;
    cfg
}

fn build_agy_runner(
    db: StateDb,
    driver_config: AgyDriverConfig,
    agent_id: &str,
    account_id: Option<&str>,
) -> Arc<AcpPromptRunner> {
    let driver: Arc<dyn AcpDriver> = Arc::new(AgyDriver::new(driver_config));
    let mut runner_cfg = AcpPromptRunnerConfig::new(driver).with_agent_id(agent_id);
    if let Some(account_id) = account_id {
        runner_cfg = runner_cfg.with_account_id(account_id);
    }
    Arc::new(AcpPromptRunner::new(db, runner_cfg))
}

fn describe_agy_probe_error(probe: &AgyProbeResult) -> Option<String> {
    match probe.status {
        AgyProbeStatus::Ready => None,
        AgyProbeStatus::BinaryNotFound => Some(
            probe
                .message
                .clone()
                .unwrap_or_else(|| "Antigravity CLI ('agy') not installed.".to_string()),
        ),
        AgyProbeStatus::AuthenticationRequired => Some(
            probe
                .message
                .clone()
                .unwrap_or_else(|| "Sign in to Antigravity in Settings.".to_string()),
        ),
        AgyProbeStatus::Error => Some(
            probe
                .message
                .clone()
                .unwrap_or_else(|| "Antigravity runtime unavailable.".to_string()),
        ),
    }
}

fn entry_to_descriptor(entry: &ManagedAgyRuntime) -> RuntimeAgentDescriptor {
    let ready = entry.probe.status == AgyProbeStatus::Ready;
    RuntimeAgentDescriptor {
        id: entry.agent_id.clone(),
        name: entry.label.clone(),
        kind: "agy".to_string(),
        ready,
        error: describe_agy_probe_error(&entry.probe),
        account_id: Some(entry.account_id.clone()),
        auth_method: Some(entry.auth_method.as_wire_str().to_string()),
        version: entry.probe.version.clone(),
    }
}

fn entry_to_account_view(
    entry: &ManagedAgyRuntime,
    authorization_url: Option<String>,
) -> AgyAccountView {
    AgyAccountView {
        id: entry.account_id.clone(),
        agent_id: entry.agent_id.clone(),
        label: entry.label.clone(),
        is_default: entry.is_default,
        auth_method: entry.auth_method,
        gcp_project: entry.gcp_project.clone(),
        gcp_location: entry.gcp_location.clone(),
        has_api_key: entry.has_api_key,
        ready: entry.probe.status == AgyProbeStatus::Ready,
        status: entry.probe.status,
        version: entry.probe.version.clone(),
        error: describe_agy_probe_error(&entry.probe),
        model_count: entry.probe.models.len(),
        login_pending: authorization_url.is_some(),
        authorization_url,
    }
}

fn read_account_api_key(
    db: &StateDb,
    credentials: &UpstreamCredentialStore,
    account_id: &str,
) -> Option<String> {
    let connection = db.connect().ok()?;
    credentials
        .get_credentials(
            &connection,
            AGY_CREDENTIAL_OWNER,
            Some(&agy_credential_profile(account_id)),
        )
        .ok()
        .flatten()
        .map(|cred| cred.api_key)
}

fn load_agy_account_records(db: &StateDb) -> StateResult<Vec<AgyAccountRecord>> {
    let connection = db.connect()?;
    let mut statement =
        connection.prepare("SELECT value FROM kv_state WHERE namespace = ?1 ORDER BY key ASC")?;
    let rows = statement.query_map(params![AGY_ACCOUNTS_NAMESPACE], |row| {
        row.get::<_, String>(0)
    })?;
    let mut records = Vec::new();
    for row in rows {
        let raw = row?;
        if let Ok(record) = serde_json::from_str::<AgyAccountRecord>(&raw) {
            records.push(record);
        }
    }
    Ok(records)
}

fn save_agy_account_record(db: &StateDb, record: &AgyAccountRecord) -> StateResult<()> {
    let connection = db.connect()?;
    let encoded = serde_json::to_string(record)?;
    connection.execute(
        "INSERT INTO kv_state (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![
            AGY_ACCOUNTS_NAMESPACE,
            record.id,
            encoded,
            now_unix_millis()
        ],
    )?;
    Ok(())
}

fn delete_agy_account_record(db: &StateDb, account_id: &str) -> StateResult<bool> {
    let connection = db.connect()?;
    let deleted = connection.execute(
        "DELETE FROM kv_state WHERE namespace = ?1 AND key = ?2",
        params![AGY_ACCOUNTS_NAMESPACE, account_id],
    )?;
    Ok(deleted > 0)
}

fn load_lane_agent(db: &StateDb, logical_history_key: &str) -> StateResult<Option<String>> {
    let key = logical_history_key.trim();
    if key.is_empty() {
        return Ok(None);
    }
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![LANE_AGENT_NAMESPACE, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StateError::from)
}

fn save_lane_agent(db: &StateDb, logical_history_key: &str, agent_id: &str) -> StateResult<()> {
    let key = logical_history_key.trim();
    if key.is_empty() {
        return Ok(());
    }
    let connection = db.connect()?;
    connection.execute(
        "INSERT INTO kv_state (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![
            LANE_AGENT_NAMESPACE,
            key,
            agent_id.trim(),
            now_unix_millis()
        ],
    )?;
    Ok(())
}
