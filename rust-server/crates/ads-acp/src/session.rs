use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_runtime::PromptRunContext;
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, watch};

use crate::bridge::{AcpEventBridge, AcpStreamEvent, PendingPermissionRequest, PermissionHandler};
use crate::driver::{AcpDriver, AcpLaunchContext, AcpSessionContext};
use crate::error::{AcpError, AcpResult};
use crate::protocol::{
    ACP_PROTOCOL_VERSION, AgentCapabilities, AvailableCommand, ClientCapabilities, ConfigOption,
    ConfigOptionsState, ContentBlock, ImplementationInfo, InitializeRequest, InitializeResponse,
    PermissionOutcome, RequestPermissionParams, RequestPermissionResponse, SessionCancelParams,
    SessionLoadRequest, SessionLoadResponse, SessionMode, SessionModeState, SessionNewRequest,
    SessionNewResponse, SessionPromptRequest, SessionPromptResponse, SessionResumeRequest,
    SessionResumeResponse, SessionSetConfigOptionRequest, SessionSetConfigOptionResponse,
    SessionSetModeRequest, SessionSetModeResponse, SessionUpdate, SessionUpdateNotification,
    StopReason, UsageUpdateInfo,
};
use crate::transport::{AcpTransport, AcpTransportConfig, Subscription};

pub const DEFAULT_CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpSessionLifecycle {
    Created,
    Initialized,
    Ready,
    Prompting,
    Cancelling,
    Closed,
}

#[derive(Debug, Clone)]
pub struct AcpSessionConfig {
    pub client_info: ImplementationInfo,
    pub client_capabilities: ClientCapabilities,
    pub transport: AcpTransportConfig,
    /// Optional timeout for `session/prompt`. `Duration::ZERO` disables timeout.
    pub prompt_timeout: Duration,
    /// Maximum time to wait for `session/prompt` to finish draining trailing updates
    /// after `session/cancel` is sent.
    pub cancel_drain_timeout: Duration,
}

impl Default for AcpSessionConfig {
    fn default() -> Self {
        Self {
            client_info: ImplementationInfo {
                name: "ads-acp-kernel".to_string(),
                title: Some("ADS ACP v1 Kernel".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            client_capabilities: ClientCapabilities::default(),
            transport: AcpTransportConfig::default(),
            prompt_timeout: Duration::ZERO,
            cancel_drain_timeout: DEFAULT_CANCEL_DRAIN_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesiredConfigAlignment {
    pub mode: Option<SessionMode>,
    pub model: Option<String>,
    pub thought_level: Option<String>,
    pub extra_options: Vec<(String, String)>,
}

impl DesiredConfigAlignment {
    pub fn is_empty(&self) -> bool {
        self.mode.is_none()
            && self.model.is_none()
            && self.thought_level.is_none()
            && self.extra_options.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigAlignmentReport {
    pub mode_changed: bool,
    pub applied_config_ids: Vec<String>,
    pub skipped_config_ids: Vec<String>,
}

#[derive(Clone)]
pub struct AcpPromptRequest {
    pub client_message_id: String,
    pub prompt: Vec<ContentBlock>,
    pub alignment: Option<DesiredConfigAlignment>,
    pub extra: Map<String, Value>,
    pub context: Option<PromptRunContext>,
    pub cancel: Option<watch::Receiver<bool>>,
}

impl AcpPromptRequest {
    pub fn text(client_message_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            client_message_id: client_message_id.into(),
            prompt: vec![ContentBlock::text(text)],
            alignment: None,
            extra: Map::new(),
            context: None,
            cancel: None,
        }
    }

    pub fn with_blocks(client_message_id: impl Into<String>, prompt: Vec<ContentBlock>) -> Self {
        Self {
            client_message_id: client_message_id.into(),
            prompt,
            alignment: None,
            extra: Map::new(),
            context: None,
            cancel: None,
        }
    }

    pub fn with_alignment(mut self, alignment: DesiredConfigAlignment) -> Self {
        self.alignment = Some(alignment);
        self
    }

    pub fn with_context(mut self, context: PromptRunContext) -> Self {
        self.context = Some(context);
        self
    }

    pub fn with_cancel(mut self, cancel: watch::Receiver<bool>) -> Self {
        self.cancel = Some(cancel);
        self
    }
}

#[derive(Debug, Clone)]
pub struct AcpTurnResult {
    pub session_id: String,
    pub stop_reason: StopReason,
    pub response_text: String,
    pub thought_text: String,
    pub usage: Option<UsageUpdateInfo>,
    pub response_usage: Option<Value>,
    pub events: Vec<AcpStreamEvent>,
    pub alignment: ConfigAlignmentReport,
    pub config_options: Vec<ConfigOption>,
    pub available_commands: Vec<AvailableCommand>,
}

#[derive(Debug, Clone)]
pub struct LoadedSessionResult {
    pub response: SessionLoadResponse,
    pub replayed_events: Vec<AcpStreamEvent>,
}

struct SessionRuntimeState {
    lifecycle: AcpSessionLifecycle,
    initialize_response: Option<InitializeResponse>,
    session_id: Option<String>,
    modes: Option<SessionModeState>,
    config_options: ConfigOptionsState,
    available_commands: Vec<AvailableCommand>,
    active_bridge: Option<Arc<StdMutex<AcpEventBridge>>>,
    active_permission_cancel: Option<watch::Sender<bool>>,
    subscriptions: Vec<SubscriptionHandle>,
}

enum SubscriptionHandle {
    Notification(&'static str, Subscription),
    ServerRequest(&'static str, Subscription),
    Close(Subscription),
}

pub struct AcpSession {
    transport: AcpTransport,
    driver: Arc<dyn AcpDriver>,
    config: AcpSessionConfig,
    permission_handler: Arc<dyn PermissionHandler>,
    state: Arc<StdMutex<SessionRuntimeState>>,
    turn_lock: Mutex<()>,
}

impl AcpSession {
    pub async fn spawn(
        driver: Arc<dyn AcpDriver>,
        launch_context: &AcpLaunchContext,
        permission_handler: Arc<dyn PermissionHandler>,
        config: AcpSessionConfig,
    ) -> AcpResult<Arc<Self>> {
        let launch_spec = driver.launch_spec(launch_context)?;
        let transport = AcpTransport::spawn(&launch_spec, config.transport.clone()).await?;
        Ok(Self::from_transport(transport, driver, permission_handler, config).await)
    }

    pub async fn from_transport(
        transport: AcpTransport,
        driver: Arc<dyn AcpDriver>,
        permission_handler: Arc<dyn PermissionHandler>,
        config: AcpSessionConfig,
    ) -> Arc<Self> {
        let state = Arc::new(StdMutex::new(SessionRuntimeState {
            lifecycle: AcpSessionLifecycle::Created,
            initialize_response: None,
            session_id: None,
            modes: None,
            config_options: ConfigOptionsState::default(),
            available_commands: Vec::new(),
            active_bridge: None,
            active_permission_cancel: None,
            subscriptions: Vec::new(),
        }));

        let update_state = Arc::clone(&state);
        let update_sub = transport
            .on_notification("session/update", move |params, _| {
                handle_session_update(&update_state, params);
            })
            .await;

        let perm_state = Arc::clone(&state);
        let perm_handler = Arc::clone(&permission_handler);
        let perm_transport = transport.clone();
        let perm_sub = transport
            .on_server_request("session/request_permission", move |params, _, rpc_id| {
                let perm_state = Arc::clone(&perm_state);
                let perm_handler = Arc::clone(&perm_handler);
                let perm_transport = perm_transport.clone();
                async move {
                    let parsed: RequestPermissionParams =
                        serde_json::from_value(params).map_err(|error| {
                            AcpError::InvalidResponse {
                                method: "session/request_permission".to_string(),
                                message: error.to_string(),
                            }
                        })?;
                    let cancel_rx = {
                        let guard = perm_state.lock().expect("session state lock");
                        if let Some(tx) = guard.active_permission_cancel.as_ref() {
                            tx.subscribe()
                        } else {
                            let (tx, rx) = watch::channel(perm_transport.is_closed());
                            let _ = tx;
                            rx
                        }
                    };
                    let request = PendingPermissionRequest {
                        request_id: format!("acp-perm-{rpc_id}-{}", uuid::Uuid::new_v4().simple()),
                        session_id: parsed.session_id,
                        tool_call: parsed.tool_call,
                        options: parsed.options,
                    };
                    let outcome: PermissionOutcome =
                        perm_handler.request_permission(request, cancel_rx).await;
                    let response = RequestPermissionResponse { outcome };
                    serde_json::to_value(response).map_err(|error| AcpError::InvalidResponse {
                        method: "session/request_permission".to_string(),
                        message: error.to_string(),
                    })
                }
            })
            .await;

        let close_state = Arc::clone(&state);
        let close_sub = transport
            .on_close(move |_| {
                let mut guard = close_state.lock().expect("session state lock");
                guard.lifecycle = AcpSessionLifecycle::Closed;
                if let Some(cancel_tx) = guard.active_permission_cancel.as_ref() {
                    let _ = cancel_tx.send(true);
                }
            })
            .await;

        {
            let mut guard = state.lock().expect("session state lock");
            guard.subscriptions.push(SubscriptionHandle::Notification(
                "session/update",
                update_sub,
            ));
            guard.subscriptions.push(SubscriptionHandle::ServerRequest(
                "session/request_permission",
                perm_sub,
            ));
            guard
                .subscriptions
                .push(SubscriptionHandle::Close(close_sub));
        }

        Arc::new(Self {
            transport,
            driver,
            config,
            permission_handler,
            state,
            turn_lock: Mutex::new(()),
        })
    }

    pub fn transport(&self) -> &AcpTransport {
        &self.transport
    }

    pub fn driver(&self) -> &dyn AcpDriver {
        self.driver.as_ref()
    }

    pub fn permission_handler(&self) -> &Arc<dyn PermissionHandler> {
        &self.permission_handler
    }

    pub fn is_closed(&self) -> bool {
        self.transport.is_closed() || self.lifecycle() == AcpSessionLifecycle::Closed
    }

    pub fn lifecycle(&self) -> AcpSessionLifecycle {
        self.state.lock().expect("session state lock").lifecycle
    }

    pub fn session_id(&self) -> Option<String> {
        self.state
            .lock()
            .expect("session state lock")
            .session_id
            .clone()
    }

    pub fn initialize_response(&self) -> Option<InitializeResponse> {
        self.state
            .lock()
            .expect("session state lock")
            .initialize_response
            .clone()
    }

    pub fn agent_capabilities(&self) -> AgentCapabilities {
        self.state
            .lock()
            .expect("session state lock")
            .initialize_response
            .as_ref()
            .map(|response| response.agent_capabilities.clone())
            .unwrap_or_default()
    }

    pub fn modes(&self) -> Option<SessionModeState> {
        self.state.lock().expect("session state lock").modes.clone()
    }

    pub fn current_mode_id(&self) -> Option<String> {
        self.state
            .lock()
            .expect("session state lock")
            .modes
            .as_ref()
            .map(|modes| modes.current_mode_id.clone())
    }

    pub fn config_options(&self) -> Vec<ConfigOption> {
        self.state
            .lock()
            .expect("session state lock")
            .config_options
            .snapshot()
    }

    pub fn config_option_by_id(&self, id: &str) -> Option<ConfigOption> {
        self.state
            .lock()
            .expect("session state lock")
            .config_options
            .get_by_id(id)
            .cloned()
    }

    pub fn config_option_by_category(&self, category: &str) -> Option<ConfigOption> {
        self.state
            .lock()
            .expect("session state lock")
            .config_options
            .get_by_category(category)
            .cloned()
    }

    pub fn available_commands(&self) -> Vec<AvailableCommand> {
        self.state
            .lock()
            .expect("session state lock")
            .available_commands
            .clone()
    }

    pub async fn initialize(&self) -> AcpResult<InitializeResponse> {
        if let Some(existing) = self.initialize_response() {
            return Ok(existing);
        }
        let params = InitializeRequest {
            protocol_version: ACP_PROTOCOL_VERSION,
            client_capabilities: self.config.client_capabilities.clone(),
            client_info: Some(self.config.client_info.clone()),
        };
        let value = self
            .rpc_request("initialize", serde_json::to_value(params).unwrap(), None)
            .await?;
        let response: InitializeResponse =
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "initialize".to_string(),
                message: error.to_string(),
            })?;
        if response.protocol_version != ACP_PROTOCOL_VERSION {
            return Err(AcpError::InvalidResponse {
                method: "initialize".to_string(),
                message: format!(
                    "unsupported ACP protocol version {} (expected {})",
                    response.protocol_version, ACP_PROTOCOL_VERSION
                ),
            });
        }
        let mut guard = self.state.lock().expect("session state lock");
        guard.initialize_response = Some(response.clone());
        if guard.lifecycle == AcpSessionLifecycle::Created {
            guard.lifecycle = AcpSessionLifecycle::Initialized;
        }
        Ok(response)
    }

    pub async fn new_session(&self, context: &AcpSessionContext) -> AcpResult<SessionNewResponse> {
        self.ensure_initialized()?;
        let cwd = resolve_session_cwd(context);
        let request = SessionNewRequest {
            cwd,
            mcp_servers: context.mcp_servers.clone(),
            extra: self.driver.extra_session_new_params(context),
        };
        let value = self
            .rpc_request("session/new", serde_json::to_value(request).unwrap(), None)
            .await?;
        let response: SessionNewResponse =
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "session/new".to_string(),
                message: error.to_string(),
            })?;
        if response.session_id.trim().is_empty() {
            return Err(AcpError::InvalidResponse {
                method: "session/new".to_string(),
                message: "missing non-empty sessionId".to_string(),
            });
        }
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.session_id = Some(response.session_id.clone());
            guard.modes = response.modes.clone();
            guard
                .config_options
                .replace_all(response.config_options.clone());
            guard.lifecycle = AcpSessionLifecycle::Ready;
        }
        Ok(response)
    }

    pub async fn resume_session(
        &self,
        session_id: &str,
        context: &AcpSessionContext,
    ) -> AcpResult<SessionResumeResponse> {
        self.ensure_initialized()?;
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(AcpError::InvalidState(
                "session_id cannot be empty for session/resume".to_string(),
            ));
        }
        let cwd = resolve_session_cwd(context);
        let request = SessionResumeRequest {
            session_id: session_id.to_string(),
            cwd,
            mcp_servers: context.mcp_servers.clone(),
            extra: Map::new(),
        };
        let value = self
            .rpc_request(
                "session/resume",
                serde_json::to_value(request).unwrap(),
                None,
            )
            .await?;
        let response: SessionResumeResponse =
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "session/resume".to_string(),
                message: error.to_string(),
            })?;
        let resolved_session_id = response
            .session_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| session_id.to_string());
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.session_id = Some(resolved_session_id);
            if response.modes.is_some() {
                guard.modes = response.modes.clone();
            }
            if !response.config_options.is_empty() {
                guard
                    .config_options
                    .replace_all(response.config_options.clone());
            }
            guard.lifecycle = AcpSessionLifecycle::Ready;
        }
        Ok(response)
    }

    pub async fn load_session(
        &self,
        session_id: &str,
        context: &AcpSessionContext,
        replay_context: Option<PromptRunContext>,
    ) -> AcpResult<LoadedSessionResult> {
        self.ensure_initialized()?;
        if !self.agent_capabilities().supports_load_session() {
            return Err(AcpError::UnsupportedCapability("loadSession".to_string()));
        }
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err(AcpError::InvalidState(
                "session_id cannot be empty for session/load".to_string(),
            ));
        }
        let bridge = Arc::new(StdMutex::new(AcpEventBridge::new(
            format!("load-{session_id}"),
            replay_context,
        )));
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.session_id = Some(session_id.to_string());
            guard.active_bridge = Some(Arc::clone(&bridge));
        }

        let cwd = resolve_session_cwd(context);
        let request = SessionLoadRequest {
            session_id: session_id.to_string(),
            cwd,
            mcp_servers: context.mcp_servers.clone(),
            extra: Map::new(),
        };
        let rpc_result = self
            .rpc_request("session/load", serde_json::to_value(request).unwrap(), None)
            .await;

        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.active_bridge = None;
        }

        let value = rpc_result?;
        let response: SessionLoadResponse =
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "session/load".to_string(),
                message: error.to_string(),
            })?;
        let resolved_session_id = response
            .session_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| session_id.to_string());
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.session_id = Some(resolved_session_id);
            if response.modes.is_some() {
                guard.modes = response.modes.clone();
            }
            if !response.config_options.is_empty() {
                guard
                    .config_options
                    .replace_all(response.config_options.clone());
            }
            guard.lifecycle = AcpSessionLifecycle::Ready;
        }
        let replayed_events = bridge.lock().expect("replay bridge lock").events().to_vec();
        Ok(LoadedSessionResult {
            response,
            replayed_events,
        })
    }

    pub async fn set_mode(&self, mode: &SessionMode) -> AcpResult<bool> {
        let session_id = self.require_session_id()?;
        let target_mode_id = self.driver.map_mode_id(mode);
        if self.current_mode_id().as_deref() == Some(target_mode_id.as_str()) {
            return Ok(false);
        }
        let request = SessionSetModeRequest {
            session_id,
            mode_id: target_mode_id.clone(),
        };
        let value = self
            .rpc_request(
                "session/set_mode",
                serde_json::to_value(request).unwrap(),
                None,
            )
            .await?;
        let response: SessionSetModeResponse = serde_json::from_value(value).unwrap_or_default();
        let mut guard = self.state.lock().expect("session state lock");
        if let Some(modes) = response.modes {
            guard.modes = Some(modes);
        } else if let Some(modes) = guard.modes.as_mut() {
            modes.current_mode_id = target_mode_id;
        } else {
            guard.modes = Some(SessionModeState {
                current_mode_id: target_mode_id,
                available_modes: Vec::new(),
            });
        }
        Ok(true)
    }

    pub async fn set_config_option(&self, config_id: &str, value: &str) -> AcpResult<bool> {
        let session_id = self.require_session_id()?;
        if let Some(existing) = self.config_option_by_id(config_id)
            && existing.current_value == value
        {
            return Ok(false);
        }
        let request = SessionSetConfigOptionRequest {
            session_id,
            config_id: config_id.to_string(),
            value: value.to_string(),
        };
        let raw = self
            .rpc_request(
                "session/set_config_option",
                serde_json::to_value(request).unwrap(),
                None,
            )
            .await?;
        let response: SessionSetConfigOptionResponse =
            serde_json::from_value(raw).map_err(|error| AcpError::InvalidResponse {
                method: "session/set_config_option".to_string(),
                message: error.to_string(),
            })?;
        let mut guard = self.state.lock().expect("session state lock");
        if !response.config_options.is_empty() {
            guard.config_options.replace_all(response.config_options);
        } else {
            let mut snapshot = guard.config_options.snapshot();
            if let Some(option) = snapshot.iter_mut().find(|opt| opt.id == config_id) {
                option.current_value = value.to_string();
                guard.config_options.replace_all(snapshot);
            }
        }
        Ok(true)
    }

    /// Performs idempotent `session/set_mode` and `session/set_config_option` alignment.
    ///
    /// When both `model` and `thought_level` are specified, `model` is always aligned
    /// strictly before `thought_level` so any model-dependent thought options returned
    /// by the agent are refreshed before setting `thought_level`.
    pub async fn align_config(
        &self,
        desired: &DesiredConfigAlignment,
    ) -> AcpResult<ConfigAlignmentReport> {
        let mut report = ConfigAlignmentReport::default();
        if let Some(mode) = desired.mode.as_ref() {
            report.mode_changed = self.set_mode(mode).await?;
        }

        if let Some(desired_model) = desired
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let mapped = self.driver.map_model_id(desired_model);
            let model_option = {
                let guard = self.state.lock().expect("session state lock");
                guard.config_options.resolve_model().cloned()
            };
            if let Some(option) = model_option {
                if self.set_config_option(&option.id, &mapped).await? {
                    report.applied_config_ids.push(option.id);
                } else {
                    report.skipped_config_ids.push(option.id);
                }
            }
        }

        if let Some(desired_thought) = desired
            .thought_level
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let mapped = self.driver.map_thought_level(desired_thought);
            let thought_option = {
                let guard = self.state.lock().expect("session state lock");
                guard.config_options.resolve_thought_level().cloned()
            };
            if let Some(option) = thought_option {
                if self.set_config_option(&option.id, &mapped).await? {
                    report.applied_config_ids.push(option.id);
                } else {
                    report.skipped_config_ids.push(option.id);
                }
            }
        }

        for (config_id, value) in &desired.extra_options {
            if self.set_config_option(config_id, value).await? {
                report.applied_config_ids.push(config_id.clone());
            } else {
                report.skipped_config_ids.push(config_id.clone());
            }
        }

        Ok(report)
    }

    pub async fn send_cancel(&self) -> AcpResult<()> {
        let session_id = self.require_session_id()?;
        {
            let mut guard = self.state.lock().expect("session state lock");
            if guard.lifecycle == AcpSessionLifecycle::Prompting {
                guard.lifecycle = AcpSessionLifecycle::Cancelling;
            }
            if let Some(cancel_tx) = guard.active_permission_cancel.as_ref() {
                let _ = cancel_tx.send(true);
            }
        }
        let params = SessionCancelParams { session_id };
        self.transport
            .notify("session/cancel", serde_json::to_value(params).unwrap())
            .await
    }

    pub async fn prompt(&self, request: AcpPromptRequest) -> AcpResult<AcpTurnResult> {
        let _turn_guard = self.turn_lock.lock().await;
        if self.is_closed() {
            return Err(AcpError::Closed {
                exit_code: None,
                graceful: self.transport.is_gracefully_closed(),
                stderr_tail: self.transport.stderr_tail(),
            });
        }
        let session_id = self.require_session_id()?;
        if request
            .cancel
            .as_ref()
            .is_some_and(|cancel| *cancel.borrow())
        {
            return Err(AcpError::Cancelled);
        }

        let alignment = if let Some(desired) = request.alignment.as_ref()
            && !desired.is_empty()
        {
            self.align_config(desired).await?
        } else {
            ConfigAlignmentReport::default()
        };

        let bridge = Arc::new(StdMutex::new(AcpEventBridge::new(
            request.client_message_id.clone(),
            request.context.clone(),
        )));
        let (perm_cancel_tx, _perm_cancel_rx) = watch::channel(false);
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.lifecycle = AcpSessionLifecycle::Prompting;
            guard.active_bridge = Some(Arc::clone(&bridge));
            guard.active_permission_cancel = Some(perm_cancel_tx.clone());
        }

        let rpc_params = SessionPromptRequest {
            session_id: session_id.clone(),
            prompt: request.prompt,
            extra: request.extra,
        };
        let prompt_timeout = self.config.prompt_timeout;
        let prompt_result = self
            .execute_prompt_with_cancel(
                serde_json::to_value(rpc_params).unwrap(),
                prompt_timeout,
                request.cancel,
                &perm_cancel_tx,
            )
            .await;

        // Always cancel lingering permission requests and restore idle/closed state.
        let _ = perm_cancel_tx.send(true);
        let (config_options, available_commands) = {
            let mut guard = self.state.lock().expect("session state lock");
            guard.active_bridge = None;
            guard.active_permission_cancel = None;
            if !self.transport.is_closed() && guard.lifecycle != AcpSessionLifecycle::Closed {
                guard.lifecycle = AcpSessionLifecycle::Ready;
            }
            (
                guard.config_options.snapshot(),
                guard.available_commands.clone(),
            )
        };

        let response_value = prompt_result?;
        let response: SessionPromptResponse =
            serde_json::from_value(response_value).map_err(|error| AcpError::InvalidResponse {
                method: "session/prompt".to_string(),
                message: error.to_string(),
            })?;

        let (response_text, thought_text, usage, events) = {
            let mut guard = bridge.lock().expect("turn bridge lock");
            let dummy = AcpEventBridge::new("", None);
            std::mem::replace(&mut *guard, dummy).into_parts()
        };

        Ok(AcpTurnResult {
            session_id,
            stop_reason: response.stop_reason,
            response_text,
            thought_text,
            usage,
            response_usage: response.usage,
            events,
            alignment,
            config_options,
            available_commands,
        })
    }

    pub async fn shutdown(&self) {
        let subscriptions = {
            let mut guard = self.state.lock().expect("session state lock");
            guard.lifecycle = AcpSessionLifecycle::Closed;
            if let Some(cancel_tx) = guard.active_permission_cancel.as_ref() {
                let _ = cancel_tx.send(true);
            }
            std::mem::take(&mut guard.subscriptions)
        };
        for handle in subscriptions {
            match handle {
                SubscriptionHandle::Notification(method, sub) => {
                    self.transport.off_notification(method, sub).await;
                }
                SubscriptionHandle::ServerRequest(method, sub) => {
                    self.transport.off_server_request(method, sub).await;
                }
                SubscriptionHandle::Close(sub) => {
                    self.transport.off_close(sub).await;
                }
            }
        }
        self.transport.close().await;
    }

    async fn execute_prompt_with_cancel(
        &self,
        params: Value,
        prompt_timeout: Duration,
        cancel: Option<watch::Receiver<bool>>,
        perm_cancel_tx: &watch::Sender<bool>,
    ) -> AcpResult<Value> {
        let mut prompt_fut =
            Box::pin(self.rpc_request("session/prompt", params, Some(prompt_timeout)));

        let Some(mut cancel_rx) = cancel else {
            return prompt_fut.await;
        };

        tokio::select! {
            result = &mut prompt_fut => result,
            _ = wait_for_cancel(&mut cancel_rx) => {
                let _ = perm_cancel_tx.send(true);
                let _ = self.send_cancel().await;
                // Continue draining trailing `session/update` notifications until
                // `session/prompt` resolves or the bounded cancel drain timeout expires.
                match tokio::time::timeout(self.config.cancel_drain_timeout, &mut prompt_fut).await {
                    Ok(result) => result,
                    Err(_) => Err(AcpError::Timeout {
                        method: "session/cancel".to_string(),
                        timeout: self.config.cancel_drain_timeout,
                    }),
                }
            }
        }
    }

    async fn rpc_request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> AcpResult<Value> {
        match self.transport.request(method, params, timeout).await {
            Ok(value) => Ok(value),
            Err(AcpError::Rpc(details)) => Err(self.driver.map_rpc_error(
                &details.method,
                details.code,
                &details.message,
                details.data,
            )),
            Err(other) => Err(other),
        }
    }

    fn ensure_initialized(&self) -> AcpResult<()> {
        let guard = self.state.lock().expect("session state lock");
        if guard.initialize_response.is_none() {
            return Err(AcpError::InvalidState(
                "ACP session must be initialized before starting a session".to_string(),
            ));
        }
        Ok(())
    }

    fn require_session_id(&self) -> AcpResult<String> {
        self.state
            .lock()
            .expect("session state lock")
            .session_id
            .clone()
            .ok_or_else(|| {
                AcpError::InvalidState(
                    "ACP session has no active sessionId (call new_session/resume_session/load_session first)"
                        .to_string(),
                )
            })
    }
}

fn resolve_session_cwd(context: &AcpSessionContext) -> String {
    context
        .working_directory
        .as_ref()
        .unwrap_or(&context.workspace_root)
        .to_string_lossy()
        .to_string()
}

fn handle_session_update(state: &StdMutex<SessionRuntimeState>, params: Value) {
    let Ok(notification) = SessionUpdateNotification::from_params(params) else {
        return;
    };
    let bridge = {
        let mut guard = state.lock().expect("session state lock");
        if let Some(active_session_id) = guard.session_id.as_deref()
            && active_session_id != notification.session_id
        {
            return;
        }
        match &notification.update {
            SessionUpdate::ConfigOptionUpdate { config_options } => {
                guard.config_options.replace_all(config_options.clone());
            }
            SessionUpdate::AvailableCommandsUpdate { available_commands } => {
                guard.available_commands = available_commands.clone();
            }
            SessionUpdate::CurrentModeUpdate { current_mode_id } => {
                if let Some(modes) = guard.modes.as_mut() {
                    modes.current_mode_id = current_mode_id.clone();
                } else {
                    guard.modes = Some(SessionModeState {
                        current_mode_id: current_mode_id.clone(),
                        available_modes: Vec::new(),
                    });
                }
            }
            _ => {}
        }
        guard.active_bridge.clone()
    };
    if let Some(bridge) = bridge {
        bridge
            .lock()
            .expect("active event bridge lock")
            .handle_update(notification.update);
    }
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
    // Sender dropped without cancelling: never resolve as cancelled.
    std::future::pending::<()>().await;
}

/// Helper to build a standard `session/update` JSON payload for testing/diagnostics.
pub fn build_session_update_params(session_id: &str, update: Value) -> Value {
    json!({
        "sessionId": session_id,
        "update": update,
    })
}
