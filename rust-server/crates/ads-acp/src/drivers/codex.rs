use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use ads_contract::time::now_unix_millis;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::bridge::AutoDenyPermissionHandler;
use crate::driver::{AcpDriver, AcpLaunchContext, AcpLaunchSpec, AcpSessionContext};
use crate::error::{AcpError, AcpResult};
use crate::protocol::{
    AuthMethod, ClientCapabilities, ConfigOption, ConfigOptionValue, ConfigOptionsState,
    FileSystemCapabilities, PlanEntry, SessionMode, SessionModeState, SessionUpdate, ToolCallInfo,
};
use crate::session::{AcpSession, AcpSessionConfig, DesiredConfigAlignment};

pub const CODEX_DRIVER_ID: &str = "codex";
pub const CODEX_ACP_BINARY_ENV: &str = "ADS_CODEX_ACP_BIN";
pub const DEFAULT_CODEX_ACP_BINARY: &str = "codex-acp";
pub const DEFAULT_CODEX_PROBE_TTL: Duration = Duration::from_secs(300);

const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_AUTH_META_FILE_BYTES: u64 = 256 * 1024;
const MAX_UPDATE_PLAN_TRACKED: usize = 256;
const TOOL_TEXT_LIMIT: usize = 8_000;
const TOOL_TEXT_TRUNCATED: &str = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED: &str = "\n\n[Command truncated]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexDriverConfig {
    pub id: String,
    pub binary: String,
    pub codex_home: Option<PathBuf>,
    pub client_file_reads: bool,
    pub extra_args: Vec<String>,
    pub extra_env: HashMap<String, String>,
    pub probe_timeout: Duration,
}

impl Default for CodexDriverConfig {
    fn default() -> Self {
        let binary = env::var(CODEX_ACP_BINARY_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_CODEX_ACP_BINARY.to_string());
        Self {
            id: CODEX_DRIVER_ID.to_string(),
            binary,
            codex_home: None,
            client_file_reads: false,
            extra_args: Vec::new(),
            extra_env: HashMap::new(),
            probe_timeout: DEFAULT_PROBE_TIMEOUT,
        }
    }
}

impl CodexDriverConfig {
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_binary(mut self, binary: impl Into<String>) -> Self {
        self.binary = binary.into();
        self
    }

    pub fn with_codex_home(mut self, codex_home: impl Into<PathBuf>) -> Self {
        self.codex_home = Some(codex_home.into());
        self
    }

    pub fn with_extra_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.extra_args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.insert(key.into(), value.into());
        self
    }

    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }
}

/// Resolves the effective `CODEX_HOME` directory for a `CodexDriverConfig`, preferring
/// explicit config, then `extra_env`, then process `CODEX_HOME`, then `$HOME/.codex`.
pub fn resolve_codex_home_dir(config: &CodexDriverConfig) -> Option<PathBuf> {
    if let Some(explicit) = config
        .codex_home
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty())
    {
        return Some(explicit.to_path_buf());
    }
    if let Some(env_home) = config
        .extra_env
        .get("CODEX_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(env_home));
    }
    if let Ok(env_home) = env::var("CODEX_HOME") {
        let trimmed = env_home.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    config
        .extra_env
        .get("HOME")
        .or_else(|| config.extra_env.get("USERPROFILE"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .map(|home| home.join(".codex"))
}

/// Builds the ACP stdio launch specification for `codex-acp`, reusing persistent `CODEX_HOME`
/// credentials without forcing repeated logins.
pub fn build_codex_launch_spec(
    config: &CodexDriverConfig,
    context: &AcpLaunchContext,
) -> AcpResult<AcpLaunchSpec> {
    let mut base_env: HashMap<String, String> = env::vars().collect();
    base_env.extend(config.extra_env.clone());
    base_env.extend(context.env.clone());

    let mut launch_env = HashMap::new();
    for (key, value) in &base_env {
        let upper = key.to_ascii_uppercase();
        if matches!(
            upper.as_str(),
            "CHROME_CRASHPAD_PIPE_NAME" | "ELECTRON_RUN_AS_NODE" | "BROWSER"
        ) {
            continue;
        }
        launch_env.insert(key.clone(), value.clone());
    }

    if let Some(explicit_home) = config
        .codex_home
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty())
    {
        let abs_home = absolutize_path(explicit_home)?;
        ensure_private_dir(&abs_home)?;
        launch_env.insert(
            "CODEX_HOME".to_string(),
            abs_home.to_string_lossy().to_string(),
        );
    }

    let cwd = context.working_directory.clone().or_else(|| {
        (!context.workspace_root.as_os_str().is_empty()).then(|| context.workspace_root.clone())
    });

    Ok(AcpLaunchSpec {
        binary: config.binary.clone(),
        args: config.extra_args.clone(),
        cwd,
        env: launch_env,
        clear_env: true,
    })
}

fn absolutize_path(path: &Path) -> AcpResult<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| {
                AcpError::Transport(format!("failed to resolve codex home path: {error}"))
            })
    }
}

fn ensure_private_dir(path: &Path) -> AcpResult<()> {
    let existed = path.exists();
    if !existed {
        fs::create_dir_all(path).map_err(|error| {
            AcpError::Transport(format!(
                "failed to create codex home directory {}: {error}",
                path.display()
            ))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o700);
            fs::set_permissions(path, perms).map_err(|error| {
                AcpError::Transport(format!(
                    "failed to chmod codex home directory {}: {error}",
                    path.display()
                ))
            })?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct UpdatePlanTracker {
    order: VecDeque<String>,
    active: HashSet<String>,
}

impl UpdatePlanTracker {
    fn track(&mut self, key: &str, status: Option<&str>, is_update_plan: bool) -> bool {
        if is_update_plan && self.active.insert(key.to_string()) {
            self.order.push_back(key.to_string());
            while self.order.len() > MAX_UPDATE_PLAN_TRACKED {
                if let Some(oldest) = self.order.pop_front() {
                    self.active.remove(&oldest);
                } else {
                    break;
                }
            }
        }
        if !self.active.contains(key) {
            return false;
        }
        if matches!(
            status,
            Some("completed" | "failed" | "cancelled" | "declined")
        ) {
            self.active.remove(key);
            self.order.retain(|entry| entry != key);
        }
        true
    }
}

pub struct CodexDriver {
    config: CodexDriverConfig,
    update_plan_calls: StdMutex<UpdatePlanTracker>,
}

impl CodexDriver {
    pub fn new(config: CodexDriverConfig) -> Self {
        Self {
            config,
            update_plan_calls: StdMutex::new(UpdatePlanTracker::default()),
        }
    }

    pub fn from_env() -> Self {
        Self::new(CodexDriverConfig::default())
    }

    pub fn config(&self) -> &CodexDriverConfig {
        &self.config
    }

    fn track_update_plan(&self, key: &str, status: Option<&str>, is_update_plan: bool) -> bool {
        self.update_plan_calls
            .lock()
            .expect("update_plan lock")
            .track(key, status, is_update_plan)
    }
}

impl AcpDriver for CodexDriver {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn launch_spec(&self, context: &AcpLaunchContext) -> AcpResult<AcpLaunchSpec> {
        build_codex_launch_spec(&self.config, context)
    }

    fn client_capabilities(&self, mut default: ClientCapabilities) -> ClientCapabilities {
        default.fs = Some(FileSystemCapabilities {
            read_text_file: self.config.client_file_reads,
            write_text_file: false,
        });
        default.terminal = false;
        default
    }

    fn map_model_id(&self, model: &str) -> String {
        let trimmed = model.trim();
        trimmed
            .strip_prefix("codex:")
            .map(str::trim)
            .unwrap_or(trimmed)
            .to_string()
    }

    fn map_thought_level(&self, thought_level: &str) -> String {
        thought_level.trim().to_ascii_lowercase()
    }

    fn map_rpc_error(
        &self,
        method: &str,
        code: i64,
        message: &str,
        data: Option<Value>,
    ) -> AcpError {
        if is_codex_auth_error(code, message, data.as_ref()) {
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
        if let Some(raw_model) = desired.model.take() {
            let mapped = self.map_model_id(&raw_model);
            if !mapped.is_empty() {
                desired.model = Some(mapped);
            }
        }

        if let Some(raw_thought) = desired.thought_level.take() {
            let mapped = self.map_thought_level(&raw_thought);
            if !mapped.is_empty() {
                desired.thought_level = Some(mapped);
            }
        }

        if let Some(mode) = desired.mode.take() {
            desired.mode = coerce_codex_mode(mode, config_options, modes);
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
                let is_plan = info.title.as_deref().is_some_and(is_update_plan_title)
                    || info
                        .raw_input
                        .as_ref()
                        .and_then(|v| v.get("plan"))
                        .is_some_and(Value::is_array);
                let key = format!("{session_id}\0{}", info.tool_call_id);
                if self.track_update_plan(&key, info.status.as_deref(), is_plan) {
                    return extract_codex_plan_entries(info.raw_input.as_ref())
                        .map(|entries| SessionUpdate::Plan { entries });
                }
                normalize_codex_tool_call(&mut info);
                Some(SessionUpdate::ToolCall(info))
            }
            SessionUpdate::ToolCallUpdate(mut info) => {
                let is_plan = info.title.as_deref().is_some_and(is_update_plan_title)
                    || info
                        .raw_input
                        .as_ref()
                        .and_then(|v| v.get("plan"))
                        .is_some_and(Value::is_array);
                let key = format!("{session_id}\0{}", info.tool_call_id);
                if self.track_update_plan(&key, info.status.as_deref(), is_plan) {
                    return extract_codex_plan_entries(info.raw_input.as_ref())
                        .map(|entries| SessionUpdate::Plan { entries });
                }
                normalize_codex_tool_call(&mut info);
                Some(SessionUpdate::ToolCallUpdate(info))
            }
            other => Some(other),
        }
    }
}

fn is_codex_auth_error(code: i64, message: &str, data: Option<&Value>) -> bool {
    if code == -32000 {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("unauthenticated")
        || lower.contains("unauthorized")
        || lower.contains("authentication required")
        || lower.contains("not logged in")
        || lower.contains("codex login")
        || lower.contains("sign in")
        || lower.contains("token expired")
        || lower.contains("invalid api key")
        || lower.contains("missing api key")
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

fn coerce_codex_mode(
    mode: SessionMode,
    config_options: &ConfigOptionsState,
    modes: Option<&SessionModeState>,
) -> Option<SessionMode> {
    let has_catalog = modes.is_some_and(|m| !m.available_modes.is_empty())
        || config_options.resolve_mode().is_some();
    let fallback_default = || {
        (!has_catalog || mode_is_supported("default", config_options, modes))
            .then_some(SessionMode::Default)
    };
    match mode {
        SessionMode::Default => fallback_default(),
        SessionMode::Plan => {
            if !has_catalog || mode_is_supported("plan", config_options, modes) {
                Some(SessionMode::Plan)
            } else if mode_is_supported("read-only", config_options, modes) {
                Some(SessionMode::Custom("read-only".to_string()))
            } else if mode_is_supported("readonly", config_options, modes) {
                Some(SessionMode::Custom("readonly".to_string()))
            } else {
                fallback_default()
            }
        }
        SessionMode::AcceptEdits => {
            if !has_catalog || mode_is_supported("accept-edits", config_options, modes) {
                Some(SessionMode::AcceptEdits)
            } else if mode_is_supported("auto", config_options, modes) {
                Some(SessionMode::Custom("auto".to_string()))
            } else if mode_is_supported("workspace-write", config_options, modes) {
                Some(SessionMode::Custom("workspace-write".to_string()))
            } else if mode_is_supported("full-access", config_options, modes) {
                Some(SessionMode::Custom("full-access".to_string()))
            } else {
                fallback_default()
            }
        }
        SessionMode::Custom(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed == "default" {
                fallback_default()
            } else if trimmed == "plan" {
                coerce_codex_mode(SessionMode::Plan, config_options, modes)
            } else if trimmed == "accept-edits" {
                coerce_codex_mode(SessionMode::AcceptEdits, config_options, modes)
            } else if !has_catalog || mode_is_supported(trimmed, config_options, modes) {
                Some(SessionMode::Custom(trimmed.to_string()))
            } else {
                fallback_default()
            }
        }
    }
}

fn is_update_plan_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "update_plan" | "run update_plan" | "running update_plan" | "update plan"
    )
}

fn is_generic_command_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "running command"
            | "run command"
            | "executing command"
            | "execute command"
            | "shell"
            | "bash"
            | "command"
            | "exec_command"
    )
}

fn extract_codex_plan_entries(raw_input: Option<&Value>) -> Option<Vec<PlanEntry>> {
    let items = raw_input?
        .get("plan")
        .or_else(|| raw_input?.get("steps"))?
        .as_array()?;
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let Some(content) = item
            .get("step")
            .or_else(|| item.get("title"))
            .or_else(|| item.get("content"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let status = match item.get("status").and_then(Value::as_str) {
            Some("done" | "completed") => "completed".to_string(),
            Some("in_progress" | "running") => "in_progress".to_string(),
            Some(other) => other.to_string(),
            None => "pending".to_string(),
        };
        entries.push(PlanEntry {
            content: content.to_string(),
            priority: Some("medium".to_string()),
            status: Some(status),
            extra: Map::new(),
        });
    }
    Some(entries)
}

fn normalize_codex_tool_call(info: &mut ToolCallInfo) {
    if let Some(title) = info.title.as_mut() {
        *title = bound_tail_text(title, TOOL_TEXT_LIMIT, TOOL_TEXT_TRUNCATED);
    }

    let input_obj = info.raw_input.as_ref().and_then(Value::as_object);
    let output_obj = info.raw_output.as_ref().and_then(Value::as_object);

    let command = extract_command_string(input_obj)
        .or_else(|| extract_command_string(output_obj))
        .map(|value| bound_command_text(&value, TOOL_TEXT_LIMIT));

    let cwd = first_non_empty_str(
        input_obj,
        &["cwd", "workdir", "working_dir", "workingDirectory", "Cwd"],
    )
    .or_else(|| first_non_empty_str(output_obj, &["cwd", "workdir", "working_dir"]))
    .map(|value| bound_tail_text(value, TOOL_TEXT_LIMIT, TOOL_TEXT_TRUNCATED));

    let aggregated_output = first_str(
        output_obj,
        &[
            "aggregatedOutput",
            "aggregated_output",
            "combinedOutput",
            "combined_output",
            "output",
            "stdout",
        ],
    )
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
        if info
            .title
            .as_deref()
            .is_none_or(|title| title.trim().is_empty() || is_generic_command_title(title))
        {
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
        info.extra.insert("exit_code".to_string(), json!(exit_code));
    }
    if !normalized_exec.is_empty() {
        info.extra
            .insert("normalized".to_string(), Value::Object(normalized_exec));
    }
}

fn extract_command_string(obj: Option<&Map<String, Value>>) -> Option<String> {
    let obj = obj?;
    for key in ["command", "commandLine", "command_line", "cmd", "CommandLine"] {
        let Some(value) = obj.get(key) else {
            continue;
        };
        if let Some(text) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
            return Some(text.to_string());
        }
        if let Some(items) = value.as_array() {
            let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            if !parts.is_empty() {
                return Some(parts.join(" "));
            }
        }
    }
    None
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
pub enum CodexProbeStatus {
    Ready,
    BinaryNotFound,
    AuthenticationRequired,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProbeResult {
    pub status: CodexProbeStatus,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_email: Option<String>,
    pub auth_methods: Vec<AuthMethod>,
    pub models: Vec<ConfigOptionValue>,
    pub thought_levels: Vec<ConfigOptionValue>,
    pub modes: Option<SessionModeState>,
    pub config_options: Vec<ConfigOption>,
    pub message: Option<String>,
    pub probed_at_ms: i64,
}

#[derive(Deserialize)]
struct CodexAuthFileMeta {
    #[serde(default)]
    auth_mode: Option<Value>,
    #[serde(default)]
    tokens: Option<Value>,
    #[serde(default, rename = "OPENAI_API_KEY")]
    openai_api_key: Option<Value>,
    #[serde(default)]
    email: Option<Value>,
    #[serde(default)]
    account_email: Option<Value>,
}

fn normalize_email(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 254
        || trimmed
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return None;
    }
    let mut parts = trimmed.split('@');
    let local = parts.next()?;
    let domain = parts.next()?;
    if parts.next().is_some()
        || local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Detects non-secret Codex auth metadata (`auth_method` and optional email) from `$CODEX_HOME/auth.json`
/// or environment variables, without ever returning or logging credential tokens or API keys.
pub fn read_codex_auth_metadata(config: &CodexDriverConfig) -> (Option<String>, Option<String>) {
    if let Some(codex_home) = resolve_codex_home_dir(config) {
        let auth_path = codex_home.join("auth.json");
        if let Ok(meta) = fs::symlink_metadata(&auth_path)
            && meta.file_type().is_file()
            && meta.len() > 0
            && meta.len() <= MAX_AUTH_META_FILE_BYTES
            && let Ok(file) = File::open(&auth_path)
        {
            let mut bytes = Vec::new();
            if file
                .take(MAX_AUTH_META_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_ok()
                && !bytes.is_empty()
                && (bytes.len() as u64) <= MAX_AUTH_META_FILE_BYTES
                && let Ok(parsed) = serde_json::from_slice::<CodexAuthFileMeta>(&bytes)
            {
                let email = [parsed.account_email, parsed.email]
                    .into_iter()
                    .flatten()
                    .find_map(|value| value.as_str().and_then(normalize_email));
                let mode = parsed
                    .auth_mode
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        if parsed.tokens.as_ref().is_some_and(Value::is_object) {
                            Some("chatgpt".to_string())
                        } else if parsed
                            .openai_api_key
                            .as_ref()
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.trim().is_empty())
                        {
                            Some("api_key".to_string())
                        } else {
                            None
                        }
                    });
                if mode.is_some() || email.is_some() {
                    return (mode, email);
                }
            }
        }
    }

    let lookup_env = |key: &str| -> Option<String> {
        if let Some(value) = config.extra_env.get(key) {
            Some(value.clone())
        } else {
            env::var(key).ok()
        }
    };
    let has_env_key = ["CODEX_API_KEY", "OPENAI_API_KEY"]
        .iter()
        .any(|key| lookup_env(key).is_some_and(|value| !value.trim().is_empty()));
    if has_env_key {
        return (Some("api_key".to_string()), None);
    }
    (None, None)
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

/// Resolves a `codex-acp` executable path from `configured`, `ADS_CODEX_ACP_BIN`, or `PATH`.
pub fn resolve_codex_acp_binary(configured: Option<&str>) -> Option<PathBuf> {
    let raw = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            env::var(CODEX_ACP_BINARY_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_CODEX_ACP_BINARY.to_string());

    let candidate = Path::new(&raw);
    if candidate.is_absolute() || raw.contains(std::path::MAIN_SEPARATOR) || raw.contains('/') {
        return is_executable_file(candidate).then(|| candidate.to_path_buf());
    }

    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let full = dir.join(&raw);
        if is_executable_file(&full) {
            return Some(full);
        }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = dir.join(format!("{raw}.{ext}"));
                if is_executable_file(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// Probes `codex-acp` binary readiness, version, auth status, and available models/reasoning levels.
pub async fn probe_codex_runtime(
    config: &CodexDriverConfig,
    workspace_root: &Path,
) -> CodexProbeResult {
    let probed_at_ms = now_unix_millis();
    let Some(binary_path) = resolve_codex_acp_binary(Some(&config.binary)) else {
        return CodexProbeResult {
            status: CodexProbeStatus::BinaryNotFound,
            binary_path: None,
            version: None,
            auth_method: None,
            account_email: None,
            auth_methods: Vec::new(),
            models: Vec::new(),
            thought_levels: Vec::new(),
            modes: None,
            config_options: Vec::new(),
            message: Some(format!(
                "Codex ACP binary '{}' not found (install @agentclientprotocol/codex-acp or set {CODEX_ACP_BINARY_ENV}).",
                config.binary
            )),
            probed_at_ms,
        };
    };
    let binary_str = binary_path.to_string_lossy().to_string();

    let mut effective_config = config.clone();
    effective_config.binary = binary_str.clone();
    let timeout = if effective_config.probe_timeout.is_zero() {
        DEFAULT_PROBE_TIMEOUT
    } else {
        effective_config.probe_timeout
    };

    let driver: Arc<dyn AcpDriver> = Arc::new(CodexDriver::new(effective_config.clone()));
    let launch_ctx = AcpLaunchContext {
        session_key: "codex-probe".to_string(),
        workspace_root: workspace_root.to_path_buf(),
        working_directory: None,
        env: HashMap::new(),
    };
    let session_ctx = AcpSessionContext {
        session_key: "codex-probe".to_string(),
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
            let (auth_method, account_email) = read_codex_auth_metadata(&effective_config);
            CodexProbeResult {
                status: CodexProbeStatus::Ready,
                binary_path: Some(binary_str),
                version,
                auth_method,
                account_email,
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
) -> CodexProbeResult {
    let status = if error.is_auth_required() {
        CodexProbeStatus::AuthenticationRequired
    } else {
        CodexProbeStatus::Error
    };
    CodexProbeResult {
        status,
        binary_path,
        version,
        auth_method: None,
        account_email: None,
        auth_methods,
        models: Vec::new(),
        thought_levels: Vec::new(),
        modes: None,
        config_options: Vec::new(),
        message: Some(error.to_string()),
        probed_at_ms,
    }
}

/// Thread-safe cached prober for `codex-acp`.
#[derive(Default)]
pub struct CodexProbeCache {
    entries: Mutex<HashMap<String, CodexProbeResult>>,
}

impl CodexProbeCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn cached(&self, cache_key: &str) -> Option<CodexProbeResult> {
        self.entries.lock().await.get(cache_key).cloned()
    }

    pub async fn invalidate(&self, cache_key: &str) {
        self.entries.lock().await.remove(cache_key);
    }

    pub async fn get_or_probe(
        &self,
        cache_key: &str,
        ttl: Duration,
        config: &CodexDriverConfig,
        workspace_root: &Path,
    ) -> CodexProbeResult {
        let now = now_unix_millis();
        let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
        if let Some(existing) = self.entries.lock().await.get(cache_key).cloned()
            && now.saturating_sub(existing.probed_at_ms) <= ttl_ms
        {
            return existing;
        }
        let fresh = probe_codex_runtime(config, workspace_root).await;
        self.entries
            .lock()
            .await
            .insert(cache_key.to_string(), fresh.clone());
        fresh
    }
}
