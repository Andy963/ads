use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::error::{AcpError, AcpResult};
use crate::protocol::SessionMode;

#[derive(Debug, Clone, Default)]
pub struct AcpLaunchContext {
    pub session_key: String,
    pub workspace_root: PathBuf,
    pub working_directory: Option<PathBuf>,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct AcpSessionContext {
    pub session_key: String,
    pub workspace_root: PathBuf,
    pub working_directory: Option<PathBuf>,
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpLaunchSpec {
    pub binary: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub clear_env: bool,
}

impl AcpLaunchSpec {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            clear_env: false,
        }
    }

    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }
}

/// Lightweight driver hook trait for concrete external ACP agents (Phase 2+).
///
/// The ACP kernel owns protocol framing, session lifecycle, capability discovery,
/// config alignment, streaming bridges, and process supervision. Concrete drivers
/// only customize launch arguments, extra `session/new` fields, optional alias
/// mapping, and agent-specific JSON-RPC error classification.
pub trait AcpDriver: Send + Sync {
    fn id(&self) -> &str;

    fn launch_spec(&self, context: &AcpLaunchContext) -> AcpResult<AcpLaunchSpec>;

    fn extra_session_new_params(&self, _context: &AcpSessionContext) -> Map<String, Value> {
        Map::new()
    }

    fn map_model_id(&self, model: &str) -> String {
        model.to_string()
    }

    fn map_thought_level(&self, thought_level: &str) -> String {
        thought_level.to_string()
    }

    fn map_mode_id(&self, mode: &SessionMode) -> String {
        mode.as_wire_str().to_string()
    }

    fn map_rpc_error(
        &self,
        method: &str,
        code: i64,
        message: &str,
        data: Option<Value>,
    ) -> AcpError {
        if code == -32000 && looks_like_auth_error(message, data.as_ref()) {
            return AcpError::authentication_required(method, code, message, data);
        }
        AcpError::rpc(method, code, message, data)
    }
}

fn looks_like_auth_error(message: &str, data: Option<&Value>) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthenticated")
        || lower.contains("unauthorized")
    {
        return true;
    }
    data.and_then(|value| value.get("authMethods")).is_some()
}

/// Agent-agnostic driver backed by explicit binary, arguments, and optional overrides.
#[derive(Debug, Clone)]
pub struct GenericAcpDriver {
    id: String,
    binary: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    clear_env: bool,
    extra_session_new_params: Map<String, Value>,
    model_aliases: HashMap<String, String>,
    thought_level_aliases: HashMap<String, String>,
}

impl GenericAcpDriver {
    pub fn new(id: impl Into<String>, binary: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            binary: binary.into(),
            args: Vec::new(),
            env: HashMap::new(),
            clear_env: false,
            extra_session_new_params: Map::new(),
            model_aliases: HashMap::new(),
            thought_level_aliases: HashMap::new(),
        }
    }

    pub fn with_args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn with_extra_session_new_param(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra_session_new_params.insert(key.into(), value);
        self
    }

    pub fn with_model_alias(
        mut self,
        alias: impl Into<String>,
        canonical: impl Into<String>,
    ) -> Self {
        self.model_aliases.insert(alias.into(), canonical.into());
        self
    }

    pub fn with_thought_level_alias(
        mut self,
        alias: impl Into<String>,
        canonical: impl Into<String>,
    ) -> Self {
        self.thought_level_aliases
            .insert(alias.into(), canonical.into());
        self
    }
}

impl AcpDriver for GenericAcpDriver {
    fn id(&self) -> &str {
        &self.id
    }

    fn launch_spec(&self, context: &AcpLaunchContext) -> AcpResult<AcpLaunchSpec> {
        let mut env = self.env.clone();
        env.extend(context.env.clone());
        let cwd = context.working_directory.clone().or_else(|| {
            (!context.workspace_root.as_os_str().is_empty()).then(|| context.workspace_root.clone())
        });
        Ok(AcpLaunchSpec {
            binary: self.binary.clone(),
            args: self.args.clone(),
            cwd,
            env,
            clear_env: self.clear_env,
        })
    }

    fn extra_session_new_params(&self, _context: &AcpSessionContext) -> Map<String, Value> {
        self.extra_session_new_params.clone()
    }

    fn map_model_id(&self, model: &str) -> String {
        self.model_aliases
            .get(model)
            .cloned()
            .unwrap_or_else(|| model.to_string())
    }

    fn map_thought_level(&self, thought_level: &str) -> String {
        self.thought_level_aliases
            .get(thought_level)
            .cloned()
            .unwrap_or_else(|| thought_level.to_string())
    }
}
