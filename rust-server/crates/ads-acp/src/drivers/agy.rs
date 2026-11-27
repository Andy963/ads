use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_contract::time::now_unix_millis;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use url::Url;

use crate::bridge::AutoDenyPermissionHandler;
use crate::driver::{AcpDriver, AcpLaunchContext, AcpLaunchSpec, AcpSessionContext};
use crate::error::{AcpError, AcpResult};
use crate::protocol::{
    AuthMethod, ClientCapabilities, ConfigOption, ConfigOptionValue, ConfigOptionsState,
    FileSystemCapabilities, InitializeResponse, PlanEntry, SessionMode, SessionModeState,
    SessionUpdate, ToolCallInfo,
};
use crate::session::{AcpSession, AcpSessionConfig, DesiredConfigAlignment};

pub const AGY_DRIVER_ID: &str = "agy";
pub const AGY_BINARY_ENV: &str = "ADS_AGY_BIN";
pub const DEFAULT_AGY_BINARY: &str = "agy";
pub const AGY_APP_DATA_DIR_NAME: &str = "antigravity-acp";
pub const AGY_AUTH_STDOUT_PREFIX: &str = "Open the following link to authenticate the ACP server: ";
pub const AGY_NO_BROWSER_PREFIX: &str = "No browser is available here";
pub const AGY_CODE_REDIRECT_URI: &str = "https://antigravity.google/oauth-callback";
pub const DEFAULT_AGY_PROBE_TTL: Duration = Duration::from_secs(300);

const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_LOGIN_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_AUTHORIZATION_URL_LEN: usize = 16_384;
const MAX_UPDATE_STEPS_TRACKED: usize = 256;
const TOOL_TEXT_LIMIT: usize = 8_000;
const TOOL_TEXT_TRUNCATED: &str = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED: &str = "\n\n[Command truncated]";
const KNOWN_THOUGHT_LEVELS: [&str; 5] = ["minimal", "low", "medium", "high", "xhigh"];

/// Environment variables stripped before launching an isolated `agy` profile so ambient
/// credentials, project configuration, or inherited Electron Crashpad pipes cannot interfere.
const REMOVED_ISOLATED_ENV_KEYS: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
];

const USER_SKILL_RELATIVE_DIRS: [&[&str]; 2] =
    [&["config", "skills"], &["antigravity-cli", "skills"]];
const USER_CONFIG_RELATIVE_FILES: [&[&str]; 3] =
    [&["AGENTS.md"], &["GEMINI.md"], &["config", "skills.json"]];
const PROFILE_TOKEN_FILES: [&str; 6] = [
    "acp_token.json",
    "oauth_creds.json",
    "google_accounts.json",
    "mcp-oauth-tokens-v2.json",
    "credentials.json",
    "token.json",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum AgyAuthMethod {
    #[default]
    #[serde(rename = "oauth-personal")]
    OAuthPersonal,
    #[serde(rename = "oauth-business")]
    OAuthBusiness,
    #[serde(rename = "gemini-api-key")]
    GeminiApiKey,
    #[serde(rename = "agent-platform")]
    AgentPlatform,
}

impl AgyAuthMethod {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::OAuthPersonal => "oauth-personal",
            Self::OAuthBusiness => "oauth-business",
            Self::GeminiApiKey => "gemini-api-key",
            Self::AgentPlatform => "agent-platform",
        }
    }

    pub fn from_wire_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "oauth-personal" => Some(Self::OAuthPersonal),
            "oauth-business" => Some(Self::OAuthBusiness),
            "gemini-api-key" => Some(Self::GeminiApiKey),
            "agent-platform" => Some(Self::AgentPlatform),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::OAuthPersonal => "Google account",
            Self::OAuthBusiness => "Gemini Enterprise",
            Self::GeminiApiKey => "Gemini API key",
            Self::AgentPlatform => "Agent Platform",
        }
    }

    pub fn uses_browser(self) -> bool {
        matches!(self, Self::OAuthPersonal | Self::OAuthBusiness)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyAuthConfig {
    #[serde(default)]
    pub method: AgyAuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gcp_location: Option<String>,
}

impl AgyAuthConfig {
    pub fn validate(&self) -> Result<(), String> {
        let has_api_key = self
            .api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let has_gcp = self
            .gcp_project
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            && self
                .gcp_location
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty());
        match self.method {
            AgyAuthMethod::OAuthPersonal => Ok(()),
            AgyAuthMethod::OAuthBusiness => {
                if has_gcp {
                    Ok(())
                } else {
                    Err("Gemini Enterprise requires both gcp_project and gcp_location.".to_string())
                }
            }
            AgyAuthMethod::GeminiApiKey => {
                if has_api_key {
                    Ok(())
                } else {
                    Err("Gemini API key auth requires a non-empty api_key.".to_string())
                }
            }
            AgyAuthMethod::AgentPlatform => {
                if has_api_key || has_gcp {
                    Ok(())
                } else {
                    Err(
                        "Agent Platform requires an api_key or both gcp_project and gcp_location."
                            .to_string(),
                    )
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgyIsolatedProfile {
    pub profile_dir: PathBuf,
    pub runtime_temp_dir: Option<PathBuf>,
    pub user_home: Option<PathBuf>,
    pub auth: AgyAuthConfig,
    pub link_user_skills: bool,
}

impl AgyIsolatedProfile {
    pub fn new(profile_dir: impl Into<PathBuf>) -> Self {
        Self {
            profile_dir: profile_dir.into(),
            runtime_temp_dir: None,
            user_home: None,
            auth: AgyAuthConfig::default(),
            link_user_skills: true,
        }
    }

    pub fn with_auth(mut self, auth: AgyAuthConfig) -> Self {
        self.auth = auth;
        self
    }

    pub fn with_temp_dir(mut self, temp_dir: impl Into<PathBuf>) -> Self {
        self.runtime_temp_dir = Some(temp_dir.into());
        self
    }

    pub fn with_user_home(mut self, user_home: impl Into<PathBuf>) -> Self {
        self.user_home = Some(user_home.into());
        self
    }

    pub fn with_link_user_skills(mut self, link: bool) -> Self {
        self.link_user_skills = link;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum AgyProfileMode {
    /// Inherit the host user's default `~/.gemini` configuration and CLI authentication.
    #[default]
    HostDefault,
    /// Isolate credentials, settings, and temp storage inside a private `GEMINI_HOME` profile.
    Isolated(AgyIsolatedProfile),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgyDriverConfig {
    pub id: String,
    pub binary: String,
    pub profile: AgyProfileMode,
    pub system_prompt_append: Option<String>,
    pub disable_telemetry: bool,
    pub process_per_session: bool,
    pub client_file_reads: bool,
    pub extra_args: Vec<String>,
    pub extra_env: HashMap<String, String>,
    pub probe_timeout: Duration,
}

impl Default for AgyDriverConfig {
    fn default() -> Self {
        let binary = env::var(AGY_BINARY_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_AGY_BINARY.to_string());
        Self {
            id: AGY_DRIVER_ID.to_string(),
            binary,
            profile: AgyProfileMode::HostDefault,
            system_prompt_append: None,
            disable_telemetry: true,
            process_per_session: false,
            client_file_reads: false,
            extra_args: Vec::new(),
            extra_env: HashMap::new(),
            probe_timeout: DEFAULT_PROBE_TIMEOUT,
        }
    }
}

impl AgyDriverConfig {
    pub fn isolated(profile: AgyIsolatedProfile) -> Self {
        Self {
            profile: AgyProfileMode::Isolated(profile),
            ..Self::default()
        }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_binary(mut self, binary: impl Into<String>) -> Self {
        self.binary = binary.into();
        self
    }

    pub fn with_system_prompt_append(mut self, prompt: impl Into<String>) -> Self {
        let prompt = prompt.into();
        if !prompt.trim().is_empty() {
            self.system_prompt_append = Some(prompt);
        }
        self
    }

    pub fn with_process_per_session(mut self, enabled: bool) -> Self {
        self.process_per_session = enabled;
        self
    }

    pub fn with_disable_telemetry(mut self, enabled: bool) -> Self {
        self.disable_telemetry = enabled;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.insert(key.into(), value.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAgyProfile {
    pub gemini_home: PathBuf,
    pub acp_dir: PathBuf,
    pub token_path: PathBuf,
    pub settings_path: PathBuf,
    pub temp_dir: PathBuf,
    pub ca_bundle_path: Option<PathBuf>,
}

/// Resolves a deterministic, case-safe isolated profile directory under `<state_dir>/providers/agy`.
pub fn resolve_agy_profile_dir(state_dir: &Path, profile_id: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(profile_id.as_bytes());
    let digest = hasher.finalize();
    let hex_digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    state_dir.join("providers").join("agy").join(hex_digest)
}

/// Creates and initializes an isolated `GEMINI_HOME` profile directory (`0700`), writes
/// credential-free `settings.json`, discovers Linux CA bundles if unset, and symlinks user skills/rules.
pub fn prepare_agy_isolated_profile(
    profile: &AgyIsolatedProfile,
    base_env: &HashMap<String, String>,
) -> AcpResult<PreparedAgyProfile> {
    profile.auth.validate().map_err(|message| {
        AcpError::InvalidState(format!("invalid agy auth configuration: {message}"))
    })?;

    let gemini_home = absolutize_path(&profile.profile_dir)?;
    let acp_dir = gemini_home.join(AGY_APP_DATA_DIR_NAME);
    let temp_dir = profile
        .runtime_temp_dir
        .clone()
        .unwrap_or_else(|| acp_dir.join("tmp"));
    let settings_path = acp_dir.join("settings.json");
    let token_path = acp_dir.join("acp_token.json");

    for dir in [&gemini_home, &acp_dir, &temp_dir] {
        ensure_private_dir(dir)?;
    }

    let settings_json = render_profile_settings_json(&profile.auth);
    write_private_file_atomically(&settings_path, settings_json.as_bytes())?;

    if profile.link_user_skills
        && let Some(user_home) = resolve_user_home(profile.user_home.as_deref(), base_env)
    {
        link_user_gemini_config(&gemini_home, &user_home);
    }

    let ca_bundle_path = discover_linux_ca_bundle(base_env);
    Ok(PreparedAgyProfile {
        gemini_home,
        acp_dir,
        token_path,
        settings_path,
        temp_dir,
        ca_bundle_path,
    })
}

/// Removes cached credential/token files inside an isolated profile directory without
/// removing global skill symlinks or workspace history.
pub fn logout_agy_profile(profile_dir: &Path) -> AcpResult<()> {
    let acp_dir = profile_dir.join(AGY_APP_DATA_DIR_NAME);
    if !acp_dir.exists() {
        return Ok(());
    }
    for file_name in PROFILE_TOKEN_FILES {
        let candidate = acp_dir.join(file_name);
        if candidate.exists() {
            fs::remove_file(&candidate).map_err(|error| {
                AcpError::Transport(format!(
                    "failed to remove agy credential file {}: {error}",
                    candidate.display()
                ))
            })?;
        }
    }
    Ok(())
}

/// Builds the full launch specification for spawning `agy acp`.
pub fn build_agy_launch_spec(
    config: &AgyDriverConfig,
    context: &AcpLaunchContext,
) -> AcpResult<AcpLaunchSpec> {
    let mut base_env: HashMap<String, String> = env::vars().collect();
    base_env.extend(config.extra_env.clone());
    base_env.extend(context.env.clone());

    let mut args = vec!["acp".to_string(), "--stdio".to_string()];
    if config.disable_telemetry {
        args.push("--disable-telemetry".to_string());
    }
    if config.process_per_session {
        args.push("--process-per-session".to_string());
    }

    let launch_env = match &config.profile {
        AgyProfileMode::HostDefault => build_host_default_env(&base_env),
        AgyProfileMode::Isolated(isolated) => {
            let prepared = prepare_agy_isolated_profile(isolated, &base_env)?;
            args.push("--gemini-dir".to_string());
            args.push(prepared.gemini_home.to_string_lossy().to_string());
            args.push("--app-data-dir".to_string());
            args.push(AGY_APP_DATA_DIR_NAME.to_string());
            build_isolated_env(&base_env, &prepared, &isolated.auth)
        }
    };

    args.extend(config.extra_args.clone());

    let cwd = context.working_directory.clone().or_else(|| {
        (!context.workspace_root.as_os_str().is_empty()).then(|| context.workspace_root.clone())
    });

    Ok(AcpLaunchSpec {
        binary: config.binary.clone(),
        args,
        cwd,
        env: launch_env,
        clear_env: true,
    })
}

fn build_host_default_env(base_env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (key, value) in base_env {
        let upper = key.to_ascii_uppercase();
        if matches!(
            upper.as_str(),
            "CHROME_CRASHPAD_PIPE_NAME" | "ELECTRON_RUN_AS_NODE" | "BROWSER"
        ) {
            continue;
        }
        env.insert(key.clone(), value.clone());
    }
    env.insert(
        "AGY_CLI_DISABLE_AUTO_UPDATE".to_string(),
        "true".to_string(),
    );
    env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    if !env.contains_key("SSL_CERT_FILE")
        && !env.contains_key("SSL_CERT_DIR")
        && let Some(bundle) = discover_linux_ca_bundle(base_env)
    {
        env.insert(
            "SSL_CERT_FILE".to_string(),
            bundle.to_string_lossy().to_string(),
        );
    }
    env
}

fn build_isolated_env(
    base_env: &HashMap<String, String>,
    prepared: &PreparedAgyProfile,
    auth: &AgyAuthConfig,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (key, value) in base_env {
        let upper = key.to_ascii_uppercase();
        if REMOVED_ISOLATED_ENV_KEYS.contains(&upper.as_str()) {
            continue;
        }
        env.insert(key.clone(), value.clone());
    }

    if let Some(api_key) = auth
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match auth.method {
            AgyAuthMethod::GeminiApiKey => {
                env.insert("GEMINI_API_KEY".to_string(), api_key.to_string());
            }
            AgyAuthMethod::AgentPlatform => {
                env.insert("GOOGLE_API_KEY".to_string(), api_key.to_string());
            }
            AgyAuthMethod::OAuthPersonal | AgyAuthMethod::OAuthBusiness => {}
        }
    }

    if !env.contains_key("SSL_CERT_FILE")
        && !env.contains_key("SSL_CERT_DIR")
        && let Some(bundle) = prepared.ca_bundle_path.as_ref()
    {
        env.insert(
            "SSL_CERT_FILE".to_string(),
            bundle.to_string_lossy().to_string(),
        );
    }

    // `agy` 1.5 ignores AGY_ACP_FORCE_FILE_STORAGE for personal OAuth unless it detects SSH.
    if auth.method == AgyAuthMethod::OAuthPersonal {
        let ssh_connection = base_env
            .get("SSH_CONNECTION")
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("127.0.0.1 0 127.0.0.1 0")
            .to_string();
        env.insert("SSH_CONNECTION".to_string(), ssh_connection);
    }

    env.insert(
        "GEMINI_HOME".to_string(),
        prepared.gemini_home.to_string_lossy().to_string(),
    );
    env.insert("AGY_ACP_FORCE_FILE_STORAGE".to_string(), "1".to_string());
    env.insert(
        "AGY_CLI_DISABLE_AUTO_UPDATE".to_string(),
        "true".to_string(),
    );
    env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    let temp = prepared.temp_dir.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        env.insert("TEMP".to_string(), temp.clone());
        env.insert("TMP".to_string(), temp);
    }
    #[cfg(not(windows))]
    {
        env.insert("TMPDIR".to_string(), temp);
    }

    env
}

fn render_profile_settings_json(auth: &AgyAuthConfig) -> String {
    let mut gcp = Map::new();
    if let Some(project) = auth
        .gcp_project
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        gcp.insert("project".to_string(), Value::String(project.to_string()));
    }
    if let Some(location) = auth
        .gcp_location
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        gcp.insert("location".to_string(), Value::String(location.to_string()));
    }
    let mut root = Map::new();
    root.insert(
        "auth".to_string(),
        json!({ "type": auth.method.as_wire_str() }),
    );
    if !gcp.is_empty() {
        root.insert("gcp".to_string(), Value::Object(gcp));
    }
    let mut encoded = serde_json::to_string_pretty(&Value::Object(root))
        .unwrap_or_else(|_| "{\"auth\":{\"type\":\"oauth-personal\"}}".to_string());
    encoded.push('\n');
    encoded
}

fn resolve_user_home(
    explicit: Option<&Path>,
    base_env: &HashMap<String, String>,
) -> Option<PathBuf> {
    if let Some(path) = explicit
        && !path.as_os_str().is_empty()
    {
        return Some(path.to_path_buf());
    }
    base_env
        .get("HOME")
        .or_else(|| base_env.get("USERPROFILE"))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
}

fn discover_linux_ca_bundle(base_env: &HashMap<String, String>) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let nix_cert = base_env
            .get("NIX_SSL_CERT_FILE")
            .or_else(|| base_env.get("nix_ssl_cert_file"))
            .map(String::as_str);
        let candidates = [
            nix_cert,
            Some("/etc/ssl/certs/ca-bundle.crt"),
            Some("/etc/ssl/certs/ca-certificates.crt"),
            Some("/etc/pki/tls/certs/ca-bundle.crt"),
            Some("/etc/ssl/cert.pem"),
        ];
        for candidate in candidates.into_iter().flatten() {
            let path = Path::new(candidate);
            if path.is_absolute() && path.exists() {
                return Some(path.to_path_buf());
            }
        }
        None
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = base_env;
        None
    }
}

fn absolutize_path(path: &Path) -> AcpResult<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| {
                AcpError::Transport(format!("failed to resolve profile path: {error}"))
            })
    }
}

fn ensure_private_dir(path: &Path) -> AcpResult<()> {
    fs::create_dir_all(path).map_err(|error| {
        AcpError::Transport(format!(
            "failed to create agy directory {}: {error}",
            path.display()
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o700);
        fs::set_permissions(path, perms).map_err(|error| {
            AcpError::Transport(format!(
                "failed to chmod agy directory {}: {error}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

fn write_private_file_atomically(path: &Path, bytes: &[u8]) -> AcpResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AcpError::Transport(format!("missing parent directory for {}", path.display()))
    })?;
    let temp_path = parent.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp_path, bytes).map_err(|error| {
        AcpError::Transport(format!(
            "failed to write temp agy settings {}: {error}",
            temp_path.display()
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        AcpError::Transport(format!(
            "failed to finalize agy settings {}: {error}",
            path.display()
        ))
    })
}

fn link_user_gemini_config(profile_dir: &Path, user_home: &Path) {
    let user_gemini = user_home.join(".gemini");
    for segments in USER_SKILL_RELATIVE_DIRS {
        let link = join_segments(profile_dir, segments);
        let target = join_segments(&user_gemini, segments);
        sync_symlink_target(&link, &target, true);
    }
    #[cfg(unix)]
    for segments in USER_CONFIG_RELATIVE_FILES {
        let link = join_segments(profile_dir, segments);
        let target = join_segments(&user_gemini, segments);
        sync_symlink_target(&link, &target, false);
    }
    #[cfg(not(unix))]
    for segments in USER_CONFIG_RELATIVE_FILES {
        let link = join_segments(profile_dir, segments);
        let target = join_segments(&user_gemini, segments);
        if target.exists() {
            if let Some(parent) = link.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::copy(&target, &link);
        }
    }
}

fn join_segments(base: &Path, segments: &[&str]) -> PathBuf {
    let mut path = base.to_path_buf();
    for segment in segments {
        path.push(segment);
    }
    path
}

fn sync_symlink_target(link: &Path, target: &Path, is_dir: bool) {
    if !target.exists() {
        if fs::symlink_metadata(link)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(link);
        }
        return;
    }

    if let Ok(meta) = fs::symlink_metadata(link) {
        if meta.file_type().is_symlink() {
            if let Ok(existing) = fs::read_link(link) {
                let resolved = if existing.is_absolute() {
                    existing
                } else {
                    link.parent()
                        .unwrap_or_else(|| Path::new("."))
                        .join(existing)
                };
                if resolved == target {
                    return;
                }
            }
            let _ = fs::remove_file(link);
        } else if is_dir && meta.is_dir() {
            // `remove_dir` removes an empty harness placeholder without deleting user files.
            if fs::remove_dir(link).is_err() {
                return;
            }
        } else {
            return;
        }
    }

    if let Some(parent) = link.parent() {
        let _ = fs::create_dir_all(parent);
    }
    #[cfg(unix)]
    {
        let _ = std::os::unix::fs::symlink(target, link);
    }
    #[cfg(windows)]
    {
        if is_dir {
            let _ = std::os::windows::fs::symlink_dir(target, link);
        } else {
            let _ = std::os::windows::fs::symlink_file(target, link);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgyAuthUrlKind {
    Code,
    Loopback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyAuthorizationUrl {
    pub authorization_url: String,
    pub redirect_uri: String,
    pub state: String,
}

pub fn parse_agy_authorization_url(
    raw: &str,
    kind: AgyAuthUrlKind,
) -> AcpResult<AgyAuthorizationUrl> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_AUTHORIZATION_URL_LEN
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err(AcpError::InvalidResponse {
            method: "authenticate".to_string(),
            message: "Antigravity returned an invalid Google sign-in URL.".to_string(),
        });
    }
    let parsed = Url::parse(trimmed).map_err(|_| AcpError::InvalidResponse {
        method: "authenticate".to_string(),
        message: "Antigravity returned an unparseable Google sign-in URL.".to_string(),
    })?;

    let expected_path = match kind {
        AgyAuthUrlKind::Code => "/o/oauth2/auth",
        AgyAuthUrlKind::Loopback => "/o/oauth2/v2/auth",
    };

    if parsed.scheme() != "https"
        || parsed.host_str() != Some("accounts.google.com")
        || parsed.port().is_some()
        || parsed.path() != expected_path
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(AcpError::InvalidResponse {
            method: "authenticate".to_string(),
            message: "Antigravity Google sign-in URL failed host/path validation.".to_string(),
        });
    }

    let states: Vec<String> = parsed
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .collect();
    let redirects: Vec<String> = parsed
        .query_pairs()
        .filter(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.into_owned())
        .collect();
    let response_types: Vec<String> = parsed
        .query_pairs()
        .filter(|(k, _)| k == "response_type")
        .map(|(_, v)| v.into_owned())
        .collect();

    if states.len() != 1
        || redirects.len() != 1
        || response_types.len() != 1
        || response_types[0] != "code"
    {
        return Err(AcpError::InvalidResponse {
            method: "authenticate".to_string(),
            message: "Antigravity Google sign-in URL missing required OAuth parameters."
                .to_string(),
        });
    }

    let state = states.into_iter().next().unwrap_or_default();
    if state.is_empty() || state.len() > 512 || state.chars().any(char::is_whitespace) {
        return Err(AcpError::InvalidResponse {
            method: "authenticate".to_string(),
            message: "Antigravity Google sign-in URL has invalid state parameter.".to_string(),
        });
    }

    let redirect_uri = redirects.into_iter().next().unwrap_or_default();
    match kind {
        AgyAuthUrlKind::Code => {
            if redirect_uri != AGY_CODE_REDIRECT_URI {
                return Err(AcpError::InvalidResponse {
                    method: "authenticate".to_string(),
                    message: "Antigravity code sign-in URL has unexpected redirect_uri."
                        .to_string(),
                });
            }
        }
        AgyAuthUrlKind::Loopback => {
            let Ok(redirect) = Url::parse(&redirect_uri) else {
                return Err(AcpError::InvalidResponse {
                    method: "authenticate".to_string(),
                    message: "Antigravity loopback redirect_uri is invalid.".to_string(),
                });
            };
            let valid_port = redirect.port().is_some_and(|port| port >= 1_024);
            if redirect.scheme() != "http"
                || redirect.host_str() != Some("127.0.0.1")
                || redirect.path() != "/"
                || !valid_port
            {
                return Err(AcpError::InvalidResponse {
                    method: "authenticate".to_string(),
                    message: "Antigravity loopback redirect_uri must target 127.0.0.1:port/."
                        .to_string(),
                });
            }
        }
    }

    Ok(AgyAuthorizationUrl {
        authorization_url: trimmed.to_string(),
        redirect_uri,
        state,
    })
}

/// Validates a user-submitted authorization response (`agy acp --login` accepts either the raw
/// pasted authorization code or the full callback URL containing matching `state` and `code`).
pub fn validate_agy_login_response(
    pending: &AgyAuthorizationUrl,
    response: &str,
) -> Option<String> {
    let value = response.trim();
    if value.is_empty() {
        return None;
    }
    if value.len() <= 2048 && value.bytes().all(is_code_token_byte) {
        return Some(value.to_string());
    }
    if value.len() > MAX_AUTHORIZATION_URL_LEN || value.chars().any(char::is_whitespace) {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    let base = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str()?,
        parsed.path()
    );
    if base != pending.redirect_uri || !parsed.username().is_empty() || parsed.password().is_some()
    {
        return None;
    }
    let states: Vec<_> = parsed
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .collect();
    let codes: Vec<_> = parsed
        .query_pairs()
        .filter(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .collect();
    if states.len() != 1 || states[0] != pending.state || codes.len() != 1 || codes[0].is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn is_code_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'~' | b'-')
}

/// Live handle for a headless `agy acp --login` authorization session.
pub struct AgyLoginHandle {
    child: Child,
    pid: Option<u32>,
    stdin: Option<ChildStdin>,
    authorization: AgyAuthorizationUrl,
}

impl AgyLoginHandle {
    pub fn authorization(&self) -> &AgyAuthorizationUrl {
        &self.authorization
    }

    pub async fn submit_response(&mut self, response: &str) -> AcpResult<()> {
        let Some(validated) = validate_agy_login_response(&self.authorization, response) else {
            return Err(AcpError::InvalidState(
                "Invalid Antigravity authorization code or callback URL.".to_string(),
            ));
        };
        let mut stdin = self.stdin.take().ok_or_else(|| {
            AcpError::InvalidState(
                "Antigravity login response has already been submitted.".to_string(),
            )
        })?;
        stdin
            .write_all(format!("{validated}\n").as_bytes())
            .await
            .map_err(|error| AcpError::Transport(format!("failed writing login code: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| AcpError::Transport(format!("failed flushing login code: {error}")))?;
        drop(stdin);

        let status = tokio::time::timeout(Duration::from_secs(60), self.child.wait())
            .await
            .map_err(|_| AcpError::Timeout {
                method: "agy_login".to_string(),
                timeout: Duration::from_secs(60),
            })?
            .map_err(|error| {
                AcpError::Transport(format!("failed awaiting agy --login: {error}"))
            })?;
        self.pid = None;
        if status.success() {
            Ok(())
        } else {
            Err(AcpError::Closed {
                exit_code: status.code(),
                graceful: false,
                stderr_tail: None,
            })
        }
    }

    pub async fn cancel(mut self) {
        let _ = self.stdin.take();
        self.terminate_group();
        let _ = self.child.wait().await;
    }

    fn terminate_group(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take().and_then(|pid| i32::try_from(pid).ok()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for AgyLoginHandle {
    fn drop(&mut self) {
        let _ = self.stdin.take();
        self.terminate_group();
    }
}

/// Starts headless `agy acp --login`, strips display env vars so it prints a code-flow URL
/// instead of opening a local browser, and waits for the Google OAuth URL.
pub async fn start_agy_login(
    config: &AgyDriverConfig,
    extra_env: &HashMap<String, String>,
) -> AcpResult<AgyLoginHandle> {
    let mut base_env: HashMap<String, String> = env::vars().collect();
    base_env.extend(config.extra_env.clone());
    base_env.extend(extra_env.clone());

    let mut args = vec!["acp".to_string()];
    let mut env_map = match &config.profile {
        AgyProfileMode::HostDefault => build_host_default_env(&base_env),
        AgyProfileMode::Isolated(isolated) => {
            let prepared = prepare_agy_isolated_profile(isolated, &base_env)?;
            args.push("--gemini-dir".to_string());
            args.push(prepared.gemini_home.to_string_lossy().to_string());
            args.push("--app-data-dir".to_string());
            args.push(AGY_APP_DATA_DIR_NAME.to_string());
            build_isolated_env(&base_env, &prepared, &isolated.auth)
        }
    };
    args.push("--login".to_string());
    env_map.remove("DISPLAY");
    env_map.remove("WAYLAND_DISPLAY");

    let mut command = Command::new(&config.binary);
    command.args(&args);
    command.env_clear();
    command.envs(&env_map);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|error| AcpError::Spawn(format!("{}: {error}", config.binary)))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AcpError::Spawn("missing agy --login stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AcpError::Spawn("missing agy --login stdout".to_string()))?;
    let stderr = child.stderr.take();

    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = stderr.map(|stream| BufReader::new(stream).lines());

    let authorization = tokio::time::timeout(DEFAULT_LOGIN_STARTUP_TIMEOUT, async {
        loop {
            tokio::select! {
                line = stdout_lines.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            if let Some(auth_url) = extract_authorization_url_from_line(&text) {
                                return Ok(auth_url);
                            }
                        }
                        Ok(None) => {
                            return Err(AcpError::Transport(
                                "agy --login exited before emitting an authorization URL.".to_string(),
                            ));
                        }
                        Err(error) => {
                            return Err(AcpError::Transport(error.to_string()));
                        }
                    }
                }
                line = async {
                    match stderr_lines.as_mut() {
                        Some(lines) => lines.next_line().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Ok(Some(text)) = line
                        && let Some(auth_url) = extract_authorization_url_from_line(&text)
                    {
                        return Ok(auth_url);
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| AcpError::Timeout {
        method: "agy_login".to_string(),
        timeout: DEFAULT_LOGIN_STARTUP_TIMEOUT,
    })??;

    Ok(AgyLoginHandle {
        child,
        pid,
        stdin: Some(stdin),
        authorization,
    })
}

fn extract_authorization_url_from_line(line: &str) -> Option<AgyAuthorizationUrl> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix(AGY_AUTH_STDOUT_PREFIX) {
        return parse_agy_authorization_url(rest, AgyAuthUrlKind::Code)
            .or_else(|_| parse_agy_authorization_url(rest, AgyAuthUrlKind::Loopback))
            .ok();
    }
    if let Some(idx) = trimmed.find("https://accounts.google.com/") {
        let candidate = trimmed[idx..].split_whitespace().next()?;
        return parse_agy_authorization_url(candidate, AgyAuthUrlKind::Code)
            .or_else(|_| parse_agy_authorization_url(candidate, AgyAuthUrlKind::Loopback))
            .ok();
    }
    None
}

pub struct AgyDriver {
    config: AgyDriverConfig,
    update_steps_calls: StdMutex<HashSet<String>>,
}

impl AgyDriver {
    pub fn new(config: AgyDriverConfig) -> Self {
        Self {
            config,
            update_steps_calls: StdMutex::new(HashSet::new()),
        }
    }

    pub fn from_env() -> Self {
        Self::new(AgyDriverConfig::default())
    }

    pub fn config(&self) -> &AgyDriverConfig {
        &self.config
    }

    fn track_update_steps(
        &self,
        key: &str,
        status: Option<&str>,
        is_update_steps_title: bool,
    ) -> bool {
        let mut guard = self.update_steps_calls.lock().expect("update_steps lock");
        if is_update_steps_title {
            if guard.len() >= MAX_UPDATE_STEPS_TRACKED {
                guard.clear();
            }
            guard.insert(key.to_string());
        }
        if !guard.contains(key) {
            return false;
        }
        if matches!(status, Some("completed" | "failed")) {
            guard.remove(key);
        }
        true
    }
}

impl AcpDriver for AgyDriver {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn launch_spec(&self, context: &AcpLaunchContext) -> AcpResult<AcpLaunchSpec> {
        build_agy_launch_spec(&self.config, context)
    }

    fn client_capabilities(&self, mut default: ClientCapabilities) -> ClientCapabilities {
        // Never advertise writeTextFile so agy uses its native diff tools instead of whole-file client_edit_file.
        default.fs = Some(FileSystemCapabilities {
            read_text_file: self.config.client_file_reads,
            write_text_file: false,
        });
        default.terminal = false;
        default
    }

    fn extra_session_new_params(
        &self,
        _context: &AcpSessionContext,
        initialize: Option<&InitializeResponse>,
    ) -> Map<String, Value> {
        let mut extra = Map::new();
        let Some(append) = self
            .config
            .system_prompt_append
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return extra;
        };
        if initialize.is_some_and(agy_supports_system_prompt_append) {
            extra.insert(
                "_meta".to_string(),
                json!({
                    "antigravity": {
                        "systemPrompt": {
                            "append": append
                        }
                    }
                }),
            );
        }
        extra
    }

    fn intercept_non_json_stdout_line(&self, line: &str) -> Option<AcpError> {
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        let url_part = trimmed.strip_prefix(AGY_AUTH_STDOUT_PREFIX)?;
        let parsed = parse_agy_authorization_url(url_part, AgyAuthUrlKind::Loopback)
            .or_else(|_| parse_agy_authorization_url(url_part, AgyAuthUrlKind::Code))
            .ok();
        let data = parsed
            .as_ref()
            .map(|url| json!({ "authorizationUrl": url.authorization_url }))
            .unwrap_or_else(|| json!({ "rawUrl": url_part.trim() }));
        Some(AcpError::authentication_required(
            "authenticate",
            -32000,
            "Antigravity requires Google sign-in.",
            Some(data),
        ))
    }

    fn map_rpc_error(
        &self,
        method: &str,
        code: i64,
        message: &str,
        data: Option<Value>,
    ) -> AcpError {
        if is_agy_auth_error(code, message, data.as_ref()) {
            return AcpError::authentication_required(method, code, message, data);
        }
        AcpError::rpc(method, code, message, data)
    }

    fn resolve_alignment(
        &self,
        config_options: &ConfigOptionsState,
        modes: Option<&SessionModeState>,
        mut desired: DesiredConfigAlignment,
    ) -> DesiredConfigAlignment {
        if let Some(raw_model) = desired
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            && let Some(model_option) = config_options.resolve_model()
        {
            let option_values: Vec<&str> = model_option
                .flattened_values()
                .into_iter()
                .map(|entry| entry.value.as_str())
                .collect();
            if !option_values.is_empty() && !option_values.contains(&raw_model.as_str()) {
                let mut candidates: Vec<&str> = option_values
                    .iter()
                    .copied()
                    .filter(|family| raw_model.starts_with(&format!("{family}-")))
                    .collect();
                candidates.sort_by_key(|family| std::cmp::Reverse(family.len()));
                if let Some(family) = candidates.into_iter().next() {
                    let suffix = &raw_model[family.len() + 1..];
                    let suffix_supported = config_options
                        .resolve_thought_level()
                        .map(|opt| opt.supports_value(suffix))
                        .unwrap_or_else(|| KNOWN_THOUGHT_LEVELS.contains(&suffix));
                    if suffix_supported {
                        desired.model = Some(family.to_string());
                        if desired.thought_level.is_none() {
                            desired.thought_level = Some(suffix.to_string());
                        }
                    }
                }
            }
        }

        if let Some(mode) = desired.mode.take() {
            desired.mode = Some(coerce_agy_mode(mode, config_options, modes));
        }

        desired
    }

    fn normalize_session_update(
        &self,
        session_id: &str,
        update: SessionUpdate,
    ) -> Option<SessionUpdate> {
        match update {
            SessionUpdate::ToolCall(mut info) => {
                let is_update_steps = info.title.as_deref().is_some_and(is_update_steps_title)
                    && info.kind.as_deref().is_none_or(|k| k == "other");
                let key = format!("{session_id}\0{}", info.tool_call_id);
                if self.track_update_steps(&key, info.status.as_deref(), is_update_steps) {
                    return extract_plan_entries(info.raw_input.as_ref())
                        .map(|entries| SessionUpdate::Plan { entries });
                }
                normalize_tool_call_info(&mut info);
                Some(SessionUpdate::ToolCall(info))
            }
            SessionUpdate::ToolCallUpdate(mut info) => {
                let is_update_steps = info.title.as_deref().is_some_and(is_update_steps_title)
                    && info.kind.as_deref().is_none_or(|k| k == "other");
                let key = format!("{session_id}\0{}", info.tool_call_id);
                if self.track_update_steps(&key, info.status.as_deref(), is_update_steps) {
                    return extract_plan_entries(info.raw_input.as_ref())
                        .map(|entries| SessionUpdate::Plan { entries });
                }
                normalize_tool_call_info(&mut info);
                Some(SessionUpdate::ToolCallUpdate(info))
            }
            other => Some(other),
        }
    }
}

pub fn agy_supports_system_prompt_append(initialize: &InitializeResponse) -> bool {
    initialize
        .agent_capabilities
        .extra
        .get("_meta")
        .and_then(|meta| meta.get("antigravity"))
        .and_then(|agy| agy.get("systemPrompt"))
        .and_then(|sp| sp.get("append"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn is_agy_auth_error(code: i64, message: &str, data: Option<&Value>) -> bool {
    if code == -32000 {
        return true;
    }
    if code == -32603 && message.trim_start().starts_with(AGY_NO_BROWSER_PREFIX) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("unauthenticated")
        || lower.contains("unauthorized")
        || lower.contains("sign in")
        || lower.contains("log in")
        || message.contains("SUBSCRIPTION_REQUIRED")
    {
        return true;
    }
    data.and_then(|value| value.get("authMethods")).is_some()
}

fn mode_is_supported(
    candidate: &str,
    config_options: &ConfigOptionsState,
    modes: Option<&SessionModeState>,
) -> bool {
    if let Some(modes) = modes
        && !modes.available_modes.is_empty()
    {
        return modes
            .available_modes
            .iter()
            .any(|entry| entry.id == candidate);
    }
    if let Some(mode_option) = config_options.resolve_mode() {
        return mode_option.supports_value(candidate);
    }
    false
}

fn coerce_agy_mode(
    mode: SessionMode,
    config_options: &ConfigOptionsState,
    modes: Option<&SessionModeState>,
) -> SessionMode {
    match mode {
        SessionMode::Default => SessionMode::Default,
        SessionMode::Plan => SessionMode::Plan,
        SessionMode::AcceptEdits => {
            if mode_is_supported("accept-edits", config_options, modes) {
                SessionMode::AcceptEdits
            } else if mode_is_supported("auto_edit", config_options, modes) {
                SessionMode::Custom("auto_edit".to_string())
            } else if modes.is_none() && config_options.resolve_mode().is_none() {
                // Unknown capability table yet: preserve standard ACP AcceptEdits (`accept-edits`).
                SessionMode::AcceptEdits
            } else {
                SessionMode::Default
            }
        }
        SessionMode::Custom(ref raw) => match raw.trim() {
            "yolo" => SessionMode::Default,
            "auto_edit" => coerce_agy_mode(SessionMode::AcceptEdits, config_options, modes),
            "auto" => {
                if mode_is_supported("auto", config_options, modes) {
                    SessionMode::Custom("auto".to_string())
                } else {
                    SessionMode::Default
                }
            }
            "default" => SessionMode::Default,
            "accept-edits" => coerce_agy_mode(SessionMode::AcceptEdits, config_options, modes),
            "plan" => SessionMode::Plan,
            other => SessionMode::Custom(other.to_string()),
        },
    }
}

fn is_update_steps_title(title: &str) -> bool {
    matches!(title.trim(), "Run update_steps" | "Running update_steps")
}

fn extract_plan_entries(raw_input: Option<&Value>) -> Option<Vec<PlanEntry>> {
    let steps = raw_input?.get("steps")?.as_array()?;
    let mut entries = Vec::with_capacity(steps.len());
    for step in steps {
        let Some(title) = step.get("title").and_then(Value::as_str) else {
            continue;
        };
        let status = match step.get("status").and_then(Value::as_str) {
            Some("done") => "completed".to_string(),
            Some(other) => other.to_string(),
            None => "pending".to_string(),
        };
        entries.push(PlanEntry {
            content: title.to_string(),
            priority: Some("medium".to_string()),
            status: Some(status),
            extra: Map::new(),
        });
    }
    Some(entries)
}

fn normalize_tool_call_info(info: &mut ToolCallInfo) {
    if let Some(title) = info.title.as_mut() {
        *title = bound_tail_text(title, TOOL_TEXT_LIMIT, TOOL_TEXT_TRUNCATED);
    }

    let input_obj = info.raw_input.as_ref().and_then(Value::as_object);
    let output_obj = info.raw_output.as_ref().and_then(Value::as_object);

    let command = first_non_empty_str(
        input_obj,
        &["CommandLine", "command_line", "commandLine", "command"],
    )
    .or_else(|| first_non_empty_str(output_obj, &["commandLine", "command_line", "command"]))
    .map(|value| bound_command_text(value, TOOL_TEXT_LIMIT));

    let cwd = first_non_empty_str(
        input_obj,
        &[
            "Cwd",
            "WorkingDirectory",
            "working_dir",
            "workingDir",
            "cwd",
        ],
    )
    .or_else(|| first_non_empty_str(output_obj, &["workingDir", "working_dir", "cwd"]))
    .map(|value| bound_tail_text(value, TOOL_TEXT_LIMIT, TOOL_TEXT_TRUNCATED));

    let aggregated_output = first_str(output_obj, &["combinedOutput", "combined_output"])
        .map(|value| bound_tail_text(value, TOOL_TEXT_LIMIT, TOOL_TEXT_TRUNCATED));
    let exit_code = output_obj.and_then(|obj| {
        obj.get("exitCode")
            .or_else(|| obj.get("exit_code"))
            .and_then(Value::as_i64)
    });

    if info.kind.is_none() && command.is_some() {
        info.kind = Some("execute".to_string());
    }
    if let Some(raw_input) = info.raw_input.as_mut() {
        *raw_input = sanitize_json_value(raw_input.clone(), TOOL_TEXT_LIMIT, 0);
    }
    if let Some(raw_output) = info.raw_output.as_mut() {
        *raw_output = sanitize_json_value(raw_output.clone(), TOOL_TEXT_LIMIT, 0);
    }

    let mut normalized_exec = Map::new();
    if let Some(command) = command {
        if info.title.is_none() {
            info.title = Some(command.clone());
        }
        normalized_exec.insert("command".to_string(), Value::String(command));
    }
    if let Some(cwd) = cwd {
        normalized_exec.insert("cwd".to_string(), Value::String(cwd));
    }
    if let Some(aggregated_output) = aggregated_output {
        normalized_exec.insert(
            "aggregatedOutput".to_string(),
            Value::String(aggregated_output),
        );
    }
    if let Some(exit_code) = exit_code {
        normalized_exec.insert("exitCode".to_string(), json!(exit_code));
    }
    if !normalized_exec.is_empty() {
        info.extra
            .insert("normalized".to_string(), Value::Object(normalized_exec));
    }
}

fn first_non_empty_str<'a>(obj: Option<&'a Map<String, Value>>, keys: &[&str]) -> Option<&'a str> {
    let obj = obj?;
    for key in keys {
        if let Some(text) = obj
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(text);
        }
    }
    None
}

fn first_str<'a>(obj: Option<&'a Map<String, Value>>, keys: &[&str]) -> Option<&'a str> {
    let obj = obj?;
    for key in keys {
        if let Some(text) = obj.get(*key).and_then(Value::as_str) {
            return Some(text);
        }
    }
    None
}

fn bound_tail_text(text: &str, limit: usize, prefix: &str) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let keep = limit.saturating_sub(prefix.len());
    let mut start = text.len().saturating_sub(keep);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("{prefix}{}", &text[start..])
}

fn bound_command_text(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit.saturating_sub(COMMAND_LINE_TRUNCATED.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{COMMAND_LINE_TRUNCATED}", &text[..end])
}

fn sanitize_json_value(value: Value, text_limit: usize, depth: usize) -> Value {
    const MAX_DEPTH: usize = 8;
    const MAX_ITEMS: usize = 128;
    if depth >= MAX_DEPTH {
        return Value::String("[truncated nested value]".to_string());
    }
    match value {
        Value::String(text) => {
            Value::String(bound_tail_text(&text, text_limit, TOOL_TEXT_TRUNCATED))
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(MAX_ITEMS)
                .map(|item| sanitize_json_value(item, text_limit, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let mut next = Map::new();
            for (k, v) in map.into_iter().take(MAX_ITEMS) {
                next.insert(k, sanitize_json_value(v, text_limit, depth + 1));
            }
            Value::Object(next)
        }
        other => other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgyProbeStatus {
    Ready,
    BinaryNotFound,
    AuthenticationRequired,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyProbeResult {
    pub status: AgyProbeStatus,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub auth_methods: Vec<AuthMethod>,
    pub models: Vec<ConfigOptionValue>,
    pub thought_levels: Vec<ConfigOptionValue>,
    pub modes: Option<SessionModeState>,
    pub config_options: Vec<ConfigOption>,
    pub message: Option<String>,
    pub probed_at_ms: i64,
}

/// Resolves an `agy` executable path from `configured`, `ADS_AGY_BIN`, or `PATH`.
pub fn resolve_agy_binary(configured: Option<&str>) -> Option<PathBuf> {
    let raw = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var(AGY_BINARY_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_AGY_BINARY.to_string());

    let candidate = Path::new(&raw);
    if candidate.is_absolute() || raw.contains(std::path::MAIN_SEPARATOR) || raw.contains('/') {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }

    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let full = dir.join(&raw);
        if full.is_file() {
            return Some(full);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = dir.join(format!("{raw}.{ext}"));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// Probes `agy acp` binary readiness, version, auth status, and available models/modes.
/// Avoids spawning if the binary does not exist or auth config is statically incomplete.
pub async fn probe_agy_runtime(config: &AgyDriverConfig, workspace_root: &Path) -> AgyProbeResult {
    let probed_at_ms = now_unix_millis();
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
            probed_at_ms,
        };
    };
    let binary_str = binary_path.to_string_lossy().to_string();

    if let AgyProfileMode::Isolated(isolated) = &config.profile
        && let Err(issue) = isolated.auth.validate()
    {
        return AgyProbeResult {
            status: AgyProbeStatus::Error,
            binary_path: Some(binary_str),
            version: None,
            auth_methods: Vec::new(),
            models: Vec::new(),
            thought_levels: Vec::new(),
            modes: None,
            config_options: Vec::new(),
            message: Some(issue),
            probed_at_ms,
        };
    }

    let mut effective_config = config.clone();
    effective_config.binary = binary_str.clone();
    let timeout = if effective_config.probe_timeout.is_zero() {
        DEFAULT_PROBE_TIMEOUT
    } else {
        effective_config.probe_timeout
    };

    let driver: Arc<dyn crate::driver::AcpDriver> = Arc::new(AgyDriver::new(effective_config));
    let launch_ctx = AcpLaunchContext {
        session_key: "agy-probe".to_string(),
        workspace_root: workspace_root.to_path_buf(),
        working_directory: None,
        env: HashMap::new(),
    };
    let session_ctx = AcpSessionContext {
        session_key: "agy-probe".to_string(),
        workspace_root: workspace_root.to_path_buf(),
        working_directory: None,
        mcp_servers: Vec::new(),
    };

    let session_config = AcpSessionConfig {
        transport: crate::transport::AcpTransportConfig {
            rpc_timeout: timeout,
            ..Default::default()
        },
        ..Default::default()
    };

    let session = match AcpSession::spawn(
        driver,
        &launch_ctx,
        Arc::new(AutoDenyPermissionHandler),
        session_config,
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            return probe_error_result(Some(binary_str), None, Vec::new(), error, probed_at_ms);
        }
    };

    let init = match session.initialize().await {
        Ok(init) => init,
        Err(error) => {
            session.shutdown().await;
            return probe_error_result(Some(binary_str), None, Vec::new(), error, probed_at_ms);
        }
    };
    let version = init.agent_info.as_ref().map(|info| info.version.clone());
    let auth_methods = init.auth_methods.clone();

    let new_session_res = session.new_session(&session_ctx).await;
    session.shutdown().await;

    match new_session_res {
        Ok(created) => {
            let cfg_state = ConfigOptionsState::from_vec(created.config_options.clone());
            let models = cfg_state
                .resolve_model()
                .map(|opt| {
                    opt.flattened_values()
                        .into_iter()
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let thought_levels = cfg_state
                .resolve_thought_level()
                .map(|opt| {
                    opt.flattened_values()
                        .into_iter()
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            AgyProbeResult {
                status: AgyProbeStatus::Ready,
                binary_path: Some(binary_str),
                version,
                auth_methods,
                models,
                thought_levels,
                modes: created.modes,
                config_options: created.config_options,
                message: None,
                probed_at_ms,
            }
        }
        Err(error) => {
            probe_error_result(Some(binary_str), version, auth_methods, error, probed_at_ms)
        }
    }
}

fn probe_error_result(
    binary_path: Option<String>,
    version: Option<String>,
    auth_methods: Vec<AuthMethod>,
    error: AcpError,
    probed_at_ms: i64,
) -> AgyProbeResult {
    let status = if error.is_auth_required() {
        AgyProbeStatus::AuthenticationRequired
    } else {
        AgyProbeStatus::Error
    };
    AgyProbeResult {
        status,
        binary_path,
        version,
        auth_methods,
        models: Vec::new(),
        thought_levels: Vec::new(),
        modes: None,
        config_options: Vec::new(),
        message: Some(error.to_string()),
        probed_at_ms,
    }
}

/// Thread-safe cached prober preventing redundant PyInstaller unpack storms on frequent status checks.
#[derive(Default)]
pub struct AgyProbeCache {
    entries: Mutex<HashMap<String, AgyProbeResult>>,
}

impl AgyProbeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn cached(&self, cache_key: &str) -> Option<AgyProbeResult> {
        self.entries.lock().await.get(cache_key).cloned()
    }

    pub async fn invalidate(&self, cache_key: &str) {
        self.entries.lock().await.remove(cache_key);
    }

    pub async fn get_or_probe(
        &self,
        cache_key: &str,
        ttl: Duration,
        config: &AgyDriverConfig,
        workspace_root: &Path,
    ) -> AgyProbeResult {
        let now = now_unix_millis();
        let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
        if let Some(existing) = self.entries.lock().await.get(cache_key).cloned()
            && now.saturating_sub(existing.probed_at_ms) <= ttl_ms
        {
            return existing;
        }
        let fresh = probe_agy_runtime(config, workspace_root).await;
        self.entries
            .lock()
            .await
            .insert(cache_key.to_string(), fresh.clone());
        fresh
    }
}
