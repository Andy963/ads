use std::sync::atomic::AtomicBool;
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
    PermissionOptionKind, PermissionOutcome, RequestPermissionParams, RequestPermissionResponse,
    SessionCancelParams, SessionLoadRequest, SessionLoadResponse, SessionMode, SessionModeState,
    SessionNewRequest, SessionNewResponse, SessionPromptRequest, SessionPromptResponse,
    SessionResumeRequest, SessionResumeResponse, SessionSetConfigOptionRequest,
    SessionSetConfigOptionResponse, SessionSetModeRequest, SessionSetModeResponse, SessionUpdate,
    SessionUpdateNotification, StopReason, UsageUpdateInfo,
};
use crate::transport::{AcpTransport, AcpTransportConfig, StdoutLineInterceptor, Subscription};

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
    pub retry_fence: Option<Arc<AtomicBool>>,
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
            retry_fence: None,
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
            retry_fence: None,
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

    pub fn with_retry_fence(mut self, retry_fence: Arc<AtomicBool>) -> Self {
        self.retry_fence = Some(retry_fence);
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
    close_cancel_tx: watch::Sender<bool>,
    subscriptions: Vec<SubscriptionHandle>,
}

enum SubscriptionHandle {
    Notification(&'static str, Subscription),
    ServerRequest(&'static str, Subscription),
    Close(Subscription),
}

struct LoadSessionGuard<'a> {
    state: &'a StdMutex<SessionRuntimeState>,
    previous_session_id: Option<String>,
    committed: bool,
}

impl Drop for LoadSessionGuard<'_> {
    fn drop(&mut self) {
        let mut guard = self.state.lock().expect("session state lock");
        guard.active_bridge = None;
        if !self.committed {
            guard.session_id = self.previous_session_id.take();
        }
    }
}

struct ActiveTurnGuard<'a> {
    state: &'a StdMutex<SessionRuntimeState>,
    transport: &'a AcpTransport,
    perm_cancel_tx: watch::Sender<bool>,
    completed_cleanly: bool,
}

impl Drop for ActiveTurnGuard<'_> {
    fn drop(&mut self) {
        let _ = self.perm_cancel_tx.send(true);
        let mut guard = self.state.lock().expect("session state lock");
        guard.active_bridge = None;
        guard.active_permission_cancel = None;
        if self.completed_cleanly {
            if !self.transport.is_closed() && guard.lifecycle != AcpSessionLifecycle::Closed {
                guard.lifecycle = AcpSessionLifecycle::Ready;
            }
        } else {
            // Dropped mid-turn (e.g., outer future cancellation): mark closed and tear down
            // transport asynchronously so a desynchronized subprocess is never reused.
            guard.lifecycle = AcpSessionLifecycle::Closed;
            let _ = guard.close_cancel_tx.send(true);
            let transport = self.transport.clone();
            tokio::spawn(async move {
                transport.close().await;
            });
        }
    }
}

pub struct AcpSession {
    transport: AcpTransport,
    driver: Arc<dyn AcpDriver>,
    config: AcpSessionConfig,
    permission_handler: Arc<dyn PermissionHandler>,
    state: Arc<StdMutex<SessionRuntimeState>>,
    turn_lock: Mutex<()>,
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        let guard = self.state.lock().expect("session state lock");
        if let Some(cancel_tx) = guard.active_permission_cancel.as_ref() {
            let _ = cancel_tx.send(true);
        }
        let _ = guard.close_cancel_tx.send(true);
    }
}

impl AcpSession {
    pub async fn spawn(
        driver: Arc<dyn AcpDriver>,
        launch_context: &AcpLaunchContext,
        permission_handler: Arc<dyn PermissionHandler>,
        config: AcpSessionConfig,
    ) -> AcpResult<Arc<Self>> {
        let launch_spec = driver.launch_spec(launch_context)?;
        let driver_for_stdout = Arc::clone(&driver);
        let interceptor: StdoutLineInterceptor =
            Arc::new(move |line| driver_for_stdout.intercept_non_json_stdout_line(line));
        let transport = AcpTransport::spawn_with_interceptor(
            &launch_spec,
            config.transport.clone(),
            Some(interceptor),
        )
        .await?;
        Ok(Self::from_transport(transport, driver, permission_handler, config).await)
    }

    pub async fn from_transport(
        transport: AcpTransport,
        driver: Arc<dyn AcpDriver>,
        permission_handler: Arc<dyn PermissionHandler>,
        config: AcpSessionConfig,
    ) -> Arc<Self> {
        let (close_cancel_tx, _) = watch::channel(transport.is_closed());
        let state = Arc::new(StdMutex::new(SessionRuntimeState {
            lifecycle: if transport.is_closed() {
                AcpSessionLifecycle::Closed
            } else {
                AcpSessionLifecycle::Created
            },
            initialize_response: None,
            session_id: None,
            modes: None,
            config_options: ConfigOptionsState::default(),
            available_commands: Vec::new(),
            active_bridge: None,
            active_permission_cancel: None,
            close_cancel_tx,
            subscriptions: Vec::new(),
        }));

        // All transport handlers capture only Weak<SessionRuntimeState> and never hold a
        // strong AcpTransport clone, avoiding reference cycles so Drop always works.
        let update_state = Arc::downgrade(&state);
        let update_driver = Arc::clone(&driver);
        let update_sub = transport
            .on_notification("session/update", move |params, _| {
                if let Some(state) = update_state.upgrade() {
                    handle_session_update(&state, update_driver.as_ref(), params);
                }
            })
            .await;

        let perm_state = Arc::downgrade(&state);
        let perm_handler = Arc::clone(&permission_handler);
        let perm_sub = transport
            .on_server_request("session/request_permission", move |params, _, rpc_id| {
                let perm_state = perm_state.clone();
                let perm_handler = Arc::clone(&perm_handler);
                async move {
                    let parsed: RequestPermissionParams =
                        serde_json::from_value(params).map_err(|error| {
                            AcpError::InvalidResponse {
                                method: "session/request_permission".to_string(),
                                message: error.to_string(),
                            }
                        })?;
                    let Some(state) = perm_state.upgrade() else {
                        let response = RequestPermissionResponse {
                            outcome: PermissionOutcome::Cancelled,
                        };
                        return serde_json::to_value(response).map_err(|error| {
                            AcpError::InvalidResponse {
                                method: "session/request_permission".to_string(),
                                message: error.to_string(),
                            }
                        });
                    };
                    let cancel_rx = {
                        let guard = state.lock().expect("session state lock");
                        if let Some(tx) = guard.active_permission_cancel.as_ref() {
                            tx.subscribe()
                        } else {
                            guard.close_cancel_tx.subscribe()
                        }
                    };
                    let options = parsed.options.clone();
                    let request = PendingPermissionRequest {
                        request_id: format!("acp-perm-{rpc_id}-{}", uuid::Uuid::new_v4().simple()),
                        session_id: parsed.session_id,
                        tool_call: parsed.tool_call,
                        options: parsed.options,
                    };
                    let outcome: PermissionOutcome =
                        perm_handler.request_permission(request, cancel_rx).await;
                    let approved = match &outcome {
                        PermissionOutcome::Selected { option_id } => options
                            .iter()
                            .find(|option| option.option_id == *option_id)
                            .is_none_or(|option| {
                                matches!(
                                    option.kind,
                                    PermissionOptionKind::AllowOnce
                                        | PermissionOptionKind::AllowAlways
                                )
                            }),
                        PermissionOutcome::Cancelled => false,
                    };
                    if approved {
                        let guard = state.lock().expect("session state lock");
                        if let Some(bridge) = guard.active_bridge.as_ref() {
                            bridge.lock().expect("turn bridge lock").mark_retry_unsafe();
                        }
                    }
                    let response = RequestPermissionResponse { outcome };
                    serde_json::to_value(response).map_err(|error| AcpError::InvalidResponse {
                        method: "session/request_permission".to_string(),
                        message: error.to_string(),
                    })
                }
            })
            .await;

        let close_state = Arc::downgrade(&state);
        let close_sub = transport
            .on_close(move |_| {
                if let Some(state) = close_state.upgrade() {
                    let mut guard = state.lock().expect("session state lock");
                    guard.lifecycle = AcpSessionLifecycle::Closed;
                    if let Some(cancel_tx) = guard.active_permission_cancel.as_ref() {
                        let _ = cancel_tx.send(true);
                    }
                    let _ = guard.close_cancel_tx.send(true);
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
        let guard = self.state.lock().expect("session state lock");
        guard
            .modes
            .as_ref()
            .map(|modes| modes.current_mode_id.clone())
            .or_else(|| {
                guard
                    .config_options
                    .resolve_mode()
                    .map(|option| option.current_value.clone())
            })
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
            client_capabilities: self
                .driver
                .client_capabilities(self.config.client_capabilities.clone()),
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

    pub async fn authenticate(&self, method_id: &str) -> AcpResult<Value> {
        self.ensure_initialized()?;
        let method_id = method_id.trim();
        if method_id.is_empty() {
            return Err(AcpError::InvalidState(
                "auth method_id cannot be empty for authenticate".to_string(),
            ));
        }
        self.rpc_request("authenticate", json!({ "methodId": method_id }), None)
            .await
    }

    pub async fn new_session(&self, context: &AcpSessionContext) -> AcpResult<SessionNewResponse> {
        self.ensure_initialized()?;
        let initialize = self.initialize_response();
        let cwd = resolve_session_cwd(context);
        let request = SessionNewRequest {
            cwd,
            mcp_servers: context.mcp_servers.clone(),
            extra: self
                .driver
                .extra_session_new_params(context, initialize.as_ref()),
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
        let response: SessionResumeResponse = if value.is_null() {
            SessionResumeResponse::default()
        } else {
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "session/resume".to_string(),
                message: error.to_string(),
            })?
        };
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
        let previous_session_id = {
            let mut guard = self.state.lock().expect("session state lock");
            let prev = guard.session_id.replace(session_id.to_string());
            guard.active_bridge = Some(Arc::clone(&bridge));
            prev
        };
        let mut load_guard = LoadSessionGuard {
            state: &self.state,
            previous_session_id,
            committed: false,
        };

        let cwd = resolve_session_cwd(context);
        let request = SessionLoadRequest {
            session_id: session_id.to_string(),
            cwd,
            mcp_servers: context.mcp_servers.clone(),
            extra: Map::new(),
        };
        let value = self
            .rpc_request("session/load", serde_json::to_value(request).unwrap(), None)
            .await?;

        let response: SessionLoadResponse = if value.is_null() {
            SessionLoadResponse::default()
        } else {
            serde_json::from_value(value).map_err(|error| AcpError::InvalidResponse {
                method: "session/load".to_string(),
                message: error.to_string(),
            })?
        };
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
        load_guard.committed = true;
        drop(load_guard);

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
        // Per ACP v1, if the agent exposes mode via `configOptions` (`category: "mode"`)
        // without legacy `modes`, route through `session/set_config_option`.
        let mode_config_id = {
            let guard = self.state.lock().expect("session state lock");
            if guard.modes.is_none() {
                guard
                    .config_options
                    .resolve_mode()
                    .map(|option| option.id.clone())
            } else {
                None
            }
        };
        if let Some(config_id) = mode_config_id {
            return self.set_config_option(&config_id, &target_mode_id).await;
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
        let response: SessionSetModeResponse = if value.is_null() {
            SessionSetModeResponse::default()
        } else {
            serde_json::from_value(value).unwrap_or_default()
        };
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
        let response: SessionSetConfigOptionResponse = if raw.is_null() {
            SessionSetConfigOptionResponse::default()
        } else {
            serde_json::from_value(raw).map_err(|error| AcpError::InvalidResponse {
                method: "session/set_config_option".to_string(),
                message: error.to_string(),
            })?
        };
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
        let initial_desired = {
            let guard = self.state.lock().expect("session state lock");
            self.driver.resolve_alignment(
                &guard.config_options,
                guard.modes.as_ref(),
                desired.clone(),
            )
        };
        let mut report = ConfigAlignmentReport::default();
        if let Some(mode) = initial_desired.mode.as_ref() {
            report.mode_changed = self.set_mode(mode).await?;
        }

        if let Some(desired_model) = initial_desired
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

        // Re-resolve after `model` alignment so updated `configOptions` returned by
        // `session/set_config_option` govern `thought_level` validation and mapping.
        let post_model_desired = {
            let guard = self.state.lock().expect("session state lock");
            let mut post_input = desired.clone();
            if initial_desired.thought_level.is_some()
                && post_input
                    .thought_level
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
            {
                post_input.thought_level = initial_desired.thought_level.clone();
            }
            self.driver
                .resolve_alignment(&guard.config_options, guard.modes.as_ref(), post_input)
        };

        if let Some(desired_thought) = post_model_desired
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

        for (config_id, value) in &initial_desired.extra_options {
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
            return Err(self.transport.closed_error());
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

        // Re-check cancellation after alignment so we never send `session/prompt`
        // (or race `session/cancel` before `session/prompt`) if already cancelled.
        if request
            .cancel
            .as_ref()
            .is_some_and(|cancel| *cancel.borrow())
        {
            return Err(AcpError::Cancelled);
        }

        let mut event_bridge =
            AcpEventBridge::new(request.client_message_id.clone(), request.context.clone());
        if let Some(retry_fence) = request.retry_fence.clone() {
            event_bridge = event_bridge.with_retry_fence(retry_fence);
        }
        let bridge = Arc::new(StdMutex::new(event_bridge));
        let (perm_cancel_tx, _perm_cancel_rx) = watch::channel(false);
        {
            let mut guard = self.state.lock().expect("session state lock");
            guard.lifecycle = AcpSessionLifecycle::Prompting;
            guard.active_bridge = Some(Arc::clone(&bridge));
            guard.active_permission_cancel = Some(perm_cancel_tx.clone());
        }
        let mut active_guard = ActiveTurnGuard {
            state: &self.state,
            transport: &self.transport,
            perm_cancel_tx: perm_cancel_tx.clone(),
            completed_cleanly: false,
        };

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

        let settled_cleanly = match &prompt_result {
            Ok(_) => true,
            Err(error) => !error.is_timeout(),
        };
        if !settled_cleanly {
            // A timed-out prompt or cancel-drain leaves the subprocess potentially mid-turn.
            // Close the transport so callers/supervisors never reuse a desynchronized session.
            self.transport.close().await;
            self.state.lock().expect("session state lock").lifecycle = AcpSessionLifecycle::Closed;
        }
        active_guard.completed_cleanly = true;
        drop(active_guard);

        let (config_options, available_commands) = {
            let guard = self.state.lock().expect("session state lock");
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
            let _ = guard.close_cancel_tx.send(true);
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
        // Phase 1: Write and flush `session/prompt` BEFORE racing with cancellation so
        // `session/cancel` can never be written to stdin ahead of `session/prompt`.
        let pending = self
            .transport
            .start_request("session/prompt", params)
            .await
            .map_err(|error| self.map_error(error))?;
        let mut wait_fut = Box::pin(async move {
            pending
                .wait(Some(prompt_timeout))
                .await
                .map_err(|error| self.map_error(error))
        });

        let Some(mut cancel_rx) = cancel else {
            let result = wait_fut.await;
            if matches!(result, Err(AcpError::Timeout { .. })) {
                let _ = perm_cancel_tx.send(true);
                let _ = self.send_cancel().await;
            }
            return result;
        };

        tokio::select! {
            result = &mut wait_fut => {
                if matches!(result, Err(AcpError::Timeout { .. })) {
                    let _ = perm_cancel_tx.send(true);
                    let _ = self.send_cancel().await;
                }
                result
            }
            _ = wait_for_cancel(&mut cancel_rx) => {
                let _ = perm_cancel_tx.send(true);
                let _ = self.send_cancel().await;
                // Continue draining trailing `session/update` notifications until
                // `session/prompt` resolves or the bounded cancel drain timeout expires.
                match tokio::time::timeout(self.config.cancel_drain_timeout, &mut wait_fut).await {
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
        self.transport
            .request(method, params, timeout)
            .await
            .map_err(|error| self.map_error(error))
    }

    fn map_error(&self, error: AcpError) -> AcpError {
        match error {
            AcpError::Rpc(details) => self.driver.map_rpc_error(
                &details.method,
                details.code,
                &details.message,
                details.data,
            ),
            other => other,
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

fn handle_session_update(
    state: &StdMutex<SessionRuntimeState>,
    driver: &dyn AcpDriver,
    params: Value,
) {
    let Ok(mut notification) = SessionUpdateNotification::from_params(params) else {
        return;
    };
    let Some(update) =
        driver.normalize_session_update(&notification.session_id, notification.update)
    else {
        return;
    };
    notification.update = update;
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
