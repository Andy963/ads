use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{Mutex, oneshot, watch};

use crate::daemon_registry::{CodexAppServerDaemonRegistry, get_shared_daemon_registry};
use crate::{CodexAppServerClient, RpcError, SpawnOptions, Subscription};

const CODEX_AGENT_ID: &str = "codex";
const DEFAULT_REASONING_EFFORT: &str = "high";
const REVIEW_ACTION_DESCRIPTION: &str = "Enqueue a read-only Reviewer job for the current Issue-backed pull request and return immediately. The verdict is published as a comment on the backing Issue (marker: ads:review-verdict) and the Acopilot lane is woken to read it.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SandboxMode {
    fn thread_value(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
        }
    }

    fn turn_policy(self) -> Value {
        match self {
            Self::ReadOnly => json!({"type": "readOnly", "networkAccess": false}),
            Self::WorkspaceWrite => json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": false,
                "excludeTmpdirEnvVar": false,
                "excludeSlashTmp": false
            }),
            Self::DangerFullAccess => json!({"type": "dangerFullAccess"}),
        }
    }
}

#[derive(Clone)]
pub struct CodexAppServerAgentOptions {
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub working_directory: Option<PathBuf>,
    pub model: Option<String>,
    pub resume_thread_id: Option<String>,
    pub reasoning_effort: String,
    pub sandbox_mode: SandboxMode,
    pub developer_instructions: Option<String>,
    pub dynamic_tools: Vec<Value>,
    pub daemon_options: SpawnOptions,
    pub registry: Option<Arc<CodexAppServerDaemonRegistry>>,
    pub turn_timeout: Option<Duration>,
    pub auto_compact: AutoCompactConfig,
    pub retry: RetryConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoCompactConfig {
    pub enabled: bool,
    pub threshold_percent: u8,
    pub timeout: Duration,
}

impl Default for AutoCompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_percent: 80,
            timeout: Duration::from_secs(120),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryConfig {
    pub max_attempts: usize,
    pub backoff_ms: Option<Vec<u64>>,
}

impl Default for RetryConfig {
    fn default() -> Self {
        let retries = std::env::var("ADS_UPSTREAM_RETRY_COUNT")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(1);
        Self {
            max_attempts: retries.saturating_add(1),
            backoff_ms: None,
        }
    }
}

impl CodexAppServerAgentOptions {
    pub fn new(project_id: impl Into<String>, workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            project_id: project_id.into(),
            workspace_root: workspace_root.into(),
            working_directory: None,
            model: None,
            resume_thread_id: None,
            reasoning_effort: DEFAULT_REASONING_EFFORT.to_string(),
            sandbox_mode: SandboxMode::WorkspaceWrite,
            developer_instructions: None,
            dynamic_tools: Vec::new(),
            daemon_options: SpawnOptions::default(),
            registry: None,
            turn_timeout: None,
            auto_compact: AutoCompactConfig::default(),
            retry: RetryConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum AgentInputPart {
    #[serde(rename = "text")]
    Text {
        text: String,
        text_elements: Vec<Value>,
    },
    #[serde(rename = "localImage")]
    LocalImage { path: String },
}

impl AgentInputPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            text_elements: Vec::new(),
        }
    }

    pub fn local_image(path: impl Into<String>) -> Self {
        Self::LocalImage { path: path.into() }
    }
}

#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub phase: String,
    pub title: String,
    pub detail: Option<String>,
    pub delta: Option<String>,
    pub timestamp: i64,
    pub raw: Value,
    pub session_fallback: Option<AgentSessionFallback>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionFallback {
    pub reason: String,
    pub previous_session_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunResult {
    pub response: String,
    pub usage: Option<Value>,
    pub agent_id: String,
}

pub type ActionToolFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

#[derive(Clone)]
pub struct AgentActionTools {
    review_action: Arc<dyn Fn() -> ActionToolFuture + Send + Sync>,
}

impl AgentActionTools {
    pub fn new<F, Fut>(review_action: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        Self {
            review_action: Arc::new(move || Box::pin(review_action())),
        }
    }

    async fn review_action(&self) -> Result<Value, String> {
        (self.review_action)().await
    }
}

#[derive(Clone, Default)]
pub struct AgentSendOptions {
    pub abort: Option<watch::Receiver<bool>>,
    pub action_tools: Option<AgentActionTools>,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Rpc(#[from] RpcError),
    #[error("codex app-server turn failed: {0}")]
    TurnFailed(String),
    #[error("codex app-server turn timed out after {}ms", timeout.as_millis())]
    TimedOut { timeout: Duration },
    #[error("codex app-server compaction failed: {0}")]
    CompactionFailed(String),
    #[error("用户中断了请求")]
    Aborted,
    #[error("codex app-server did not return a thread id")]
    MissingThreadId,
    #[error("failed to serialize codex app-server input: {0}")]
    Json(#[from] serde_json::Error),
}

type EventHandler = Arc<dyn Fn(AgentEvent) + Send + Sync>;
type TurnCompletionSender = oneshot::Sender<Result<(), String>>;
type SharedTurnCompletion = Arc<std::sync::Mutex<Option<TurnCompletionSender>>>;
type SharedTurnState = Arc<std::sync::Mutex<TurnState>>;

enum TurnSubscription {
    Notification(&'static str, Subscription),
    ServerRequest(&'static str, Subscription),
    Close(Subscription),
}

#[derive(Clone)]
pub struct CodexAppServerAgent {
    inner: Arc<AgentInner>,
}

struct AgentInner {
    options: CodexAppServerAgentOptions,
    registry: Arc<CodexAppServerDaemonRegistry>,
    thread_id: Mutex<Option<String>>,
    loaded_thread: Mutex<Option<(String, String)>>,
    thread_has_builtin_tools: Mutex<Option<bool>>,
    configured_policy: Mutex<Option<TurnPolicy>>,
    latest_context_usage: std::sync::Mutex<Option<ContextUsage>>,
    listeners: std::sync::Mutex<HashMap<u64, EventHandler>>,
    next_listener_id: AtomicU64,
}

#[derive(Clone)]
struct TurnPolicy {
    sandbox_policy: Value,
    approval_policy: Value,
}

#[derive(Debug, Clone)]
struct ContextUsage {
    thread_id: String,
    total_tokens: u64,
    model_context_window: u64,
}

#[derive(Default)]
struct TurnState {
    response_text: String,
    agent_message_buffers: HashMap<String, Vec<String>>,
    agent_message_phases: HashMap<String, Option<String>>,
    agent_message_streamed: HashMap<String, String>,
    usage: Option<Value>,
    thread_id_from_started: Option<String>,
    turn_id: Option<String>,
    failed: Option<String>,
    blocked_command_ids: HashSet<String>,
    side_effect_observed: bool,
}

#[derive(Clone)]
struct BuiltinCall {
    tool: String,
    arguments: Value,
    response: Value,
}

struct MappedItemEvent {
    phase: &'static str,
    title: &'static str,
    detail: Option<String>,
    raw: Value,
}

impl MappedItemEvent {
    fn into_agent_event(self) -> AgentEvent {
        AgentEvent {
            phase: self.phase.to_string(),
            title: self.title.to_string(),
            detail: self.detail,
            delta: None,
            timestamp: now_ms(),
            raw: self.raw,
            session_fallback: None,
        }
    }
}

impl CodexAppServerAgent {
    pub fn new(options: CodexAppServerAgentOptions) -> Self {
        let registry = options
            .registry
            .clone()
            .unwrap_or_else(get_shared_daemon_registry);
        let resume_thread_id = options
            .resume_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        Self {
            inner: Arc::new(AgentInner {
                options,
                registry,
                thread_id: Mutex::new(resume_thread_id.clone()),
                loaded_thread: Mutex::new(None),
                thread_has_builtin_tools: Mutex::new(resume_thread_id.is_some().then_some(false)),
                configured_policy: Mutex::new(None),
                latest_context_usage: std::sync::Mutex::new(None),
                listeners: std::sync::Mutex::new(HashMap::new()),
                next_listener_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn id(&self) -> &'static str {
        CODEX_AGENT_ID
    }

    pub fn workspace_root(&self) -> &PathBuf {
        &self.inner.options.workspace_root
    }

    fn command_execution_cwd(&self, item: &Value) -> PathBuf {
        let base = self
            .inner
            .options
            .working_directory
            .as_ref()
            .unwrap_or(&self.inner.options.workspace_root);
        match item.get("cwd").and_then(Value::as_str).map(str::trim) {
            Some(cwd) if !cwd.is_empty() => {
                let cwd = PathBuf::from(cwd);
                if cwd.is_absolute() {
                    cwd
                } else {
                    base.join(cwd)
                }
            }
            _ => base.clone(),
        }
    }

    fn emit_agent_message_delta(&self, params: &Value, item_id: &Value, text: &str) {
        if text.is_empty() {
            return;
        }
        self.emit(AgentEvent {
            phase: "responding".to_string(),
            title: "生成回复".to_string(),
            detail: None,
            delta: Some(text.to_string()),
            timestamp: now_ms(),
            raw: json!({
                "threadId": params.get("threadId").cloned().unwrap_or(Value::Null),
                "turnId": params.get("turnId").cloned().unwrap_or(Value::Null),
                "itemId": item_id
            }),
            session_fallback: None,
        });
    }

    pub async fn thread_id(&self) -> Option<String> {
        self.inner.thread_id.lock().await.clone()
    }

    pub async fn restore_thread(&self, thread_id: &str, has_builtin_tools: bool) {
        *self.inner.thread_id.lock().await = Some(thread_id.to_string());
        *self.inner.loaded_thread.lock().await = None;
        *self.inner.thread_has_builtin_tools.lock().await = Some(has_builtin_tools);
    }

    pub fn on_event<F>(&self, handler: F) -> u64
    where
        F: Fn(AgentEvent) + Send + Sync + 'static,
    {
        let id = self.inner.next_listener_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .listeners
            .lock()
            .expect("agent event listener lock")
            .insert(id, Arc::new(handler));
        id
    }

    pub fn off_event(&self, id: u64) {
        self.inner
            .listeners
            .lock()
            .expect("agent event listener lock")
            .remove(&id);
    }

    pub async fn send(
        &self,
        parts: Vec<AgentInputPart>,
        abort: Option<watch::Receiver<bool>>,
    ) -> Result<AgentRunResult, AgentError> {
        self.send_with_options(
            parts,
            AgentSendOptions {
                abort,
                action_tools: None,
            },
        )
        .await
    }

    pub async fn send_with_options(
        &self,
        parts: Vec<AgentInputPart>,
        options: AgentSendOptions,
    ) -> Result<AgentRunResult, AgentError> {
        if options
            .abort
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
        {
            return Err(AgentError::Aborted);
        }
        let client = self
            .inner
            .registry
            .get_or_start(&self.inner.options.project_id, self.daemon_options())
            .await?;
        let max_attempts = self.inner.options.retry.max_attempts.max(1);
        for attempt in 1..=max_attempts {
            let state = Arc::new(std::sync::Mutex::new(TurnState::default()));
            let thread_subscriptions = self
                .subscribe_thread_notifications(&client, Arc::clone(&state))
                .await;
            let run_result = self
                .run_turn(
                    &client,
                    parts.clone(),
                    options.abort.clone(),
                    state.clone(),
                    options.action_tools.clone(),
                )
                .await;
            self.cleanup_subscriptions(&client, thread_subscriptions)
                .await;
            let error = match run_result {
                Ok(result) => return Ok(result),
                Err(error) => error,
            };
            let side_effect_observed = state.lock().expect("turn state lock").side_effect_observed;
            if attempt >= max_attempts || side_effect_observed || !is_retryable_agent_error(&error)
            {
                return Err(error);
            }
            let message = error.to_string();
            let delay_ms = retry_delay_ms(&self.inner.options.retry, attempt, &message);
            self.emit(AgentEvent {
                phase: "connection".to_string(),
                title: "模型请求重试".to_string(),
                detail: Some(message.clone()),
                delta: None,
                timestamp: now_ms(),
                raw: json!({
                    "type": "error",
                    "message": message,
                    "retry": {
                        "source": "external",
                        "retryCount": attempt,
                        "nextAttempt": attempt + 1,
                        "maxAttempts": max_attempts,
                        "delayMs": delay_ms
                    }
                }),
                session_fallback: None,
            });
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
        unreachable!("retry loop always returns")
    }

    async fn run_turn(
        &self,
        client: &CodexAppServerClient,
        parts: Vec<AgentInputPart>,
        abort: Option<watch::Receiver<bool>>,
        state: Arc<std::sync::Mutex<TurnState>>,
        action_tools: Option<AgentActionTools>,
    ) -> Result<AgentRunResult, AgentError> {
        let saved_thread_id = self.inner.thread_id.lock().await.clone();
        let mut thread_id = self.ensure_thread(client, &state).await?;
        self.remember_turn_thread(&state, &thread_id);
        if let Some(message) = self
            .maybe_compact_thread(client, &thread_id, abort.clone())
            .await?
        {
            self.clear_thread().await;
            {
                let mut current = state.lock().expect("turn state lock");
                current.thread_id_from_started = None;
                current.turn_id = None;
                current.failed = None;
            }
            self.emit_session_fallback(&thread_id, &message);
            thread_id = self.ensure_thread(client, &state).await?;
            self.remember_turn_thread(&state, &thread_id);
        }
        let (done_tx, done_rx) = oneshot::channel();
        let done_tx = Arc::new(std::sync::Mutex::new(Some(done_tx)));
        let subscriptions = self
            .subscribe_turn_notifications(client, Arc::clone(&state), done_tx, action_tools)
            .await;
        let result = async {
            if let Err(error) = self.start_turn(client, &thread_id, &parts).await {
                let recover = saved_thread_id
                    .as_ref()
                    .is_some_and(|saved| saved == &thread_id)
                    && is_missing_provider_session(&error.to_string());
                if !recover {
                    return Err(error);
                }
                self.clear_thread().await;
                {
                    let mut current = state.lock().expect("turn state lock");
                    current.thread_id_from_started = None;
                    current.turn_id = None;
                    current.failed = None;
                }
                self.emit_session_fallback(&thread_id, &error.to_string());
                thread_id = self.ensure_thread(client, &state).await?;
                self.remember_turn_thread(&state, &thread_id);
                self.start_turn(client, &thread_id, &parts).await?;
            }
            let turn_id = state.lock().expect("turn state lock").turn_id.clone();

            let wait = async {
                match done_rx.await {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(message)) => Err(AgentError::TurnFailed(message)),
                    Err(_) => Err(AgentError::TurnFailed(
                        "turn completion channel closed".to_string(),
                    )),
                }
            };
            let result = self.wait_for_turn(wait, abort).await;
            if matches!(result, Err(AgentError::Aborted))
                && let Some(turn_id) = turn_id
            {
                let _ = client
                    .request(
                        "turn/interrupt",
                        json!({"threadId": thread_id, "turnId": turn_id}),
                        Some(Duration::from_secs(5)),
                    )
                    .await;
            }
            result?;

            let state = state.lock().expect("turn state lock");
            if let Some(message) = state.failed.clone() {
                return Err(AgentError::TurnFailed(message));
            }
            Ok(AgentRunResult {
                response: state.response_text.trim().to_string(),
                usage: state.usage.clone(),
                agent_id: CODEX_AGENT_ID.to_string(),
            })
        }
        .await;
        self.cleanup_subscriptions(client, subscriptions).await;
        result
    }

    async fn subscribe_turn_notifications(
        &self,
        client: &CodexAppServerClient,
        state: SharedTurnState,
        done: SharedTurnCompletion,
        action_tools: Option<AgentActionTools>,
    ) -> Vec<TurnSubscription> {
        let mut subscriptions = Vec::new();
        let builtin_calls = Arc::new(std::sync::Mutex::new(HashMap::new()));
        for method in [
            "turn/started",
            "turn/completed",
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
            "error",
        ] {
            let agent = self.clone();
            let state = Arc::clone(&state);
            let done = Arc::clone(&done);
            let subscription = client
                .on_notification(method, move |params, _| {
                    agent.handle_notification(method, params, &state, &done);
                })
                .await;
            subscriptions.push(TurnSubscription::Notification(method, subscription));
        }
        let request_handler = |method: &'static str| {
            let agent = self.clone();
            let state = Arc::clone(&state);
            let matcher_state = Arc::clone(&state);
            let action_tools = action_tools.clone();
            let builtin_calls = Arc::clone(&builtin_calls);
            async move {
                let matcher: crate::ServerRequestMatcher =
                    Arc::new(move |params, _, _| is_active_server_request(params, &matcher_state));
                let subscription = client
                    .on_server_request(
                        method,
                        move |params, _, _| {
                            let agent = agent.clone();
                            let state = Arc::clone(&state);
                            let action_tools = action_tools.clone();
                            let builtin_calls = Arc::clone(&builtin_calls);
                            async move {
                                match method {
                                    "item/commandExecution/requestApproval" => {
                                        Ok(agent.handle_command_approval(params, &state).await)
                                    }
                                    "item/fileChange/requestApproval" => {
                                        Ok(json!({"decision": "accept"}))
                                    }
                                    "item/tool/call" => Ok(agent
                                        .handle_builtin_tool_call(
                                            params,
                                            &state,
                                            action_tools,
                                            &builtin_calls,
                                        )
                                        .await),
                                    _ => Ok(failure_builtin_response(
                                        "Unknown ADS built-in tool request.",
                                    )),
                                }
                            }
                        },
                        Some(matcher),
                    )
                    .await;
                TurnSubscription::ServerRequest(method, subscription)
            }
        };
        subscriptions.push(request_handler("item/commandExecution/requestApproval").await);
        subscriptions.push(request_handler("item/fileChange/requestApproval").await);
        subscriptions.push(request_handler("item/tool/call").await);
        let close_subscription = {
            let done = Arc::clone(&done);
            client
                .on_close(move |code| {
                    let message = match code {
                        Some(code) => {
                            format!("codex app-server closed unexpectedly (exit={code})")
                        }
                        None => "codex app-server closed unexpectedly (exit=null)".to_string(),
                    };
                    if let Some(sender) = done.lock().expect("turn completion lock").take() {
                        let _ = sender.send(Err(message));
                    }
                })
                .await
        };
        subscriptions.push(TurnSubscription::Close(close_subscription));
        subscriptions
    }

    async fn subscribe_thread_notifications(
        &self,
        client: &CodexAppServerClient,
        state: SharedTurnState,
    ) -> Vec<TurnSubscription> {
        let mut subscriptions = Vec::new();
        for method in [
            "thread/started",
            "thread/tokenUsage/updated",
            "thread/compacted",
        ] {
            let agent = self.clone();
            let state = Arc::clone(&state);
            let subscription = client
                .on_notification(method, move |params, _| {
                    agent.handle_thread_notification(method, params, &state);
                })
                .await;
            subscriptions.push(TurnSubscription::Notification(method, subscription));
        }
        subscriptions
    }

    async fn cleanup_subscriptions(
        &self,
        client: &CodexAppServerClient,
        subscriptions: Vec<TurnSubscription>,
    ) {
        for subscription in subscriptions {
            match subscription {
                TurnSubscription::Notification(method, subscription) => {
                    client.off_notification(method, &subscription).await;
                }
                TurnSubscription::ServerRequest(method, subscription) => {
                    client.off_server_request(method, &subscription).await;
                }
                TurnSubscription::Close(subscription) => {
                    client.off_close(&subscription).await;
                }
            }
        }
    }

    fn handle_thread_notification(&self, method: &str, params: Value, state: &SharedTurnState) {
        let notification_thread = extract_thread_id(&params);
        let expected_thread = state
            .lock()
            .expect("turn state lock")
            .thread_id_from_started
            .clone();
        if notification_thread.is_some()
            && expected_thread.is_some()
            && notification_thread != expected_thread
        {
            return;
        }
        match method {
            "thread/started" => {
                let Some(thread_id) = notification_thread else {
                    return;
                };
                state
                    .lock()
                    .expect("turn state lock")
                    .thread_id_from_started = Some(thread_id.clone());
                self.emit(AgentEvent {
                    phase: "boot".to_string(),
                    title: "初始化 Codex 线程".to_string(),
                    detail: Some(format!("thread#{thread_id}")),
                    delta: None,
                    timestamp: now_ms(),
                    raw: params,
                    session_fallback: None,
                });
            }
            "thread/tokenUsage/updated" => {
                if let Some(usage) = extract_usage_from_token_usage(&params) {
                    state.lock().expect("turn state lock").usage = Some(usage);
                }
                if let Some(context) = extract_context_usage(&params) {
                    *self
                        .inner
                        .latest_context_usage
                        .lock()
                        .expect("context usage lock") = Some(context);
                }
            }
            "thread/compacted" => {
                self.emit(AgentEvent {
                    phase: "context".to_string(),
                    title: "Context ready".to_string(),
                    detail: None,
                    delta: None,
                    timestamp: now_ms(),
                    raw: json!({
                        "type": "item.completed",
                        "item": {"type": "context", "id": "codex-context-compacted", "text": ""}
                    }),
                    session_fallback: None,
                });
            }
            _ => {}
        }
    }

    fn handle_notification(
        &self,
        method: &str,
        params: Value,
        state: &SharedTurnState,
        done: &SharedTurnCompletion,
    ) {
        if !belongs_to_turn(&params, state) {
            return;
        }
        match method {
            "thread/started" => {
                let Some(thread_id) = extract_thread_id(&params) else {
                    return;
                };
                state
                    .lock()
                    .expect("turn state lock")
                    .thread_id_from_started = Some(thread_id.clone());
                self.emit(AgentEvent {
                    phase: "boot".to_string(),
                    title: "初始化 Codex 线程".to_string(),
                    detail: Some(format!("thread#{thread_id}")),
                    delta: None,
                    timestamp: now_ms(),
                    raw: params,
                    session_fallback: None,
                });
            }
            "turn/started" => {
                if let Some(turn_id) = extract_turn_id(&params) {
                    state.lock().expect("turn state lock").turn_id = Some(turn_id);
                }
                self.emit(AgentEvent {
                    phase: "analysis".to_string(),
                    title: "开始处理请求".to_string(),
                    detail: None,
                    delta: None,
                    timestamp: now_ms(),
                    raw: params,
                    session_fallback: None,
                });
            }
            "turn/completed" => {
                let mut current = state.lock().expect("turn state lock");
                if let Some(usage) = params.get("usage").filter(|usage| usage.is_object()) {
                    current.usage = Some(usage.clone());
                }
                drop(current);
                self.emit(AgentEvent {
                    phase: "completed".to_string(),
                    title: "处理完成".to_string(),
                    detail: None,
                    delta: None,
                    timestamp: now_ms(),
                    raw: params,
                    session_fallback: None,
                });
                signal_done(done, Ok(()));
            }
            "item/agentMessage/delta" => {
                let item_id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("__current__")
                    .to_string();
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let snapshot = {
                    let mut current = state.lock().expect("turn state lock");
                    current
                        .agent_message_buffers
                        .entry(item_id.clone())
                        .or_default()
                        .push(delta.to_string());
                    current
                        .agent_message_phases
                        .get(&item_id)
                        .is_some_and(|phase| {
                            phase.as_deref().is_none_or(|phase| phase == "final_answer")
                        })
                        .then(|| {
                            let snapshot = {
                                let cumulative = current
                                    .agent_message_streamed
                                    .entry(item_id.clone())
                                    .or_default();
                                cumulative.push_str(delta);
                                cumulative.clone()
                            };
                            current.response_text = snapshot.clone();
                            snapshot
                        })
                };
                if let Some(snapshot) = snapshot {
                    self.emit_agent_message_delta(
                        &params,
                        &params.get("itemId").cloned().unwrap_or(Value::Null),
                        &snapshot,
                    );
                }
            }
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let item_type = item.get("type").and_then(Value::as_str);
                if item_may_have_side_effect(item_type) {
                    state.lock().expect("turn state lock").side_effect_observed = true;
                }
                if item_type == Some("agentMessage") {
                    let item_id = item.get("id").cloned().unwrap_or(Value::Null);
                    let item_text = item
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let mut current = state.lock().expect("turn state lock");
                    let item_phase = item.get("phase").and_then(Value::as_str);
                    let stored_phase = item_id
                        .as_str()
                        .and_then(|item_id| current.agent_message_phases.remove(item_id));
                    let phase = item_phase
                        .map(str::to_string)
                        .or_else(|| stored_phase.flatten());
                    let visible = phase.as_deref().is_none_or(|phase| phase == "final_answer");
                    let buffered = item_id
                        .as_str()
                        .and_then(|item_id| current.agent_message_buffers.remove(item_id))
                        .unwrap_or_default();
                    let streamed = item_id
                        .as_str()
                        .and_then(|item_id| current.agent_message_streamed.remove(item_id))
                        .unwrap_or_default();
                    let buffered_text = buffered.concat();
                    let text = if item_text.is_empty() {
                        if buffered_text.is_empty() {
                            streamed.clone()
                        } else {
                            buffered_text
                        }
                    } else {
                        item_text
                    };
                    if visible {
                        current.response_text = text.clone();
                    }
                    drop(current);
                    if !visible {
                        return;
                    }
                    if !text.is_empty() && text != streamed {
                        self.emit_agent_message_delta(&params, &item_id, &text);
                    }
                }
                if item_type == Some("commandExecution")
                    && item
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|item_id| {
                            state
                                .lock()
                                .expect("turn state lock")
                                .blocked_command_ids
                                .contains(item_id)
                        })
                {
                    return;
                }
                let command_cwd = self.command_execution_cwd(&item);
                if let Some(mapped) = map_item_event("item.completed", &item, &command_cwd) {
                    self.emit(mapped.into_agent_event());
                }
            }
            "item/started" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if item_may_have_side_effect(item.get("type").and_then(Value::as_str)) {
                    state.lock().expect("turn state lock").side_effect_observed = true;
                }
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    let item_id = item.get("id").cloned().unwrap_or(Value::Null);
                    let snapshot = {
                        let mut current = state.lock().expect("turn state lock");
                        let Some(item_id) = item_id.as_str() else {
                            return;
                        };
                        let phase = item.get("phase").and_then(Value::as_str);
                        current
                            .agent_message_phases
                            .insert(item_id.to_string(), phase.map(str::to_string));
                        if phase.is_some_and(|phase| phase != "final_answer") {
                            current.agent_message_buffers.remove(item_id);
                            None
                        } else {
                            let buffered = current
                                .agent_message_buffers
                                .remove(item_id)
                                .unwrap_or_default()
                                .concat();
                            if buffered.is_empty() {
                                None
                            } else {
                                current
                                    .agent_message_streamed
                                    .insert(item_id.to_string(), buffered.clone());
                                current.response_text = buffered.clone();
                                Some(buffered)
                            }
                        }
                    };
                    if let Some(snapshot) = snapshot {
                        self.emit_agent_message_delta(&params, &item_id, &snapshot);
                    }
                }
                let command_cwd = self.command_execution_cwd(&item);
                if let Some(mapped) = map_item_event("item.started", &item, &command_cwd) {
                    self.emit(mapped.into_agent_event());
                }
            }
            "error" => {
                let will_retry = params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let message = extract_error_message(&params);
                if will_retry {
                    self.emit(AgentEvent {
                        phase: "connection".to_string(),
                        title: "尝试重连".to_string(),
                        detail: Some(message),
                        delta: None,
                        timestamp: now_ms(),
                        raw: params,
                        session_fallback: None,
                    });
                    return;
                }
                state.lock().expect("turn state lock").failed = Some(message.clone());
                self.emit(AgentEvent {
                    phase: "error".to_string(),
                    title: "执行失败".to_string(),
                    detail: Some(message.clone()),
                    delta: None,
                    timestamp: now_ms(),
                    raw: params,
                    session_fallback: None,
                });
                signal_done(done, Err(message));
            }
            _ => {}
        }
    }

    async fn handle_command_approval(&self, params: Value, state: &SharedTurnState) -> Value {
        if !is_active_server_request(&params, state) {
            return json!({"decision": "decline"});
        }
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        state.lock().expect("turn state lock").side_effect_observed = true;
        let Some(violation) = ads_native::find_security_violation(command) else {
            return json!({"decision": "accept"});
        };
        let item_id = params
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or("command-approval")
            .to_string();
        let message = format!("Command blocked by security rule: {violation}");
        let command_is_frame =
            ads_native::command_has_executable(command, &self.command_execution_cwd(&params));
        let first = state
            .lock()
            .expect("turn state lock")
            .blocked_command_ids
            .insert(item_id.clone());
        if first {
            if command_is_frame {
                self.emit(AgentEvent {
                    phase: "command".to_string(),
                    title: "命令失败".to_string(),
                    detail: Some(format!("{command} | 退出码 126")),
                    delta: None,
                    timestamp: now_ms(),
                    raw: json!({
                        "type": "item.completed",
                        "item": {
                            "type": "command_execution",
                            "id": item_id,
                            "command": command,
                            "status": "failed",
                            "exit_code": 126,
                            "aggregated_output": message
                        }
                    }),
                    session_fallback: None,
                });
            } else {
                self.emit(AgentEvent {
                    phase: "error".to_string(),
                    title: "命令审批被拒绝".to_string(),
                    detail: Some(message),
                    delta: None,
                    timestamp: now_ms(),
                    raw: json!({
                        "type": "commandApproval",
                        "itemId": item_id,
                        "decision": "decline"
                    }),
                    session_fallback: None,
                });
            }
        }
        json!({"decision": "decline"})
    }

    async fn handle_builtin_tool_call(
        &self,
        params: Value,
        state: &SharedTurnState,
        action_tools: Option<AgentActionTools>,
        completed: &Arc<std::sync::Mutex<HashMap<String, BuiltinCall>>>,
    ) -> Value {
        if !is_active_server_request(&params, state) {
            return failure_builtin_response(
                "Built-in tool request does not belong to an active turn.",
            );
        }
        state.lock().expect("turn state lock").side_effect_observed = true;
        let call_id = params
            .get("callId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if call_id.is_empty() {
            return failure_builtin_response("Built-in tool call requires a callId.");
        }
        if params
            .get("namespace")
            .is_some_and(|value| !value.is_null())
        {
            return failure_builtin_response("Unsupported ADS built-in tool namespace.");
        }
        let tool = params
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
        if tool != "review_action" {
            return failure_builtin_response("Unknown ADS built-in tool.");
        }
        if let Some(previous) = completed
            .lock()
            .expect("builtin call cache lock")
            .get(&call_id)
            .cloned()
        {
            return if previous.tool == tool && previous.arguments == arguments {
                previous.response
            } else {
                failure_builtin_response(
                    "Built-in tool callId was reused with different arguments.",
                )
            };
        }
        if !arguments.as_object().is_some_and(serde_json::Map::is_empty) {
            return failure_builtin_response(
                "Reviewer tools accept an empty argument object only.",
            );
        }
        let Some(action_tools) = action_tools else {
            return failure_builtin_response(
                "review_action is unavailable without an authenticated Acopilot project context.",
            );
        };
        let response = match action_tools.review_action().await {
            Ok(result) => builtin_response(&tool, &result),
            Err(error) => failure_builtin_response(&error),
        };
        completed.lock().expect("builtin call cache lock").insert(
            call_id,
            BuiltinCall {
                tool,
                arguments,
                response: response.clone(),
            },
        );
        response
    }

    async fn maybe_compact_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
        abort: Option<watch::Receiver<bool>>,
    ) -> Result<Option<String>, AgentError> {
        let config = self.inner.options.auto_compact.clone();
        if !config.enabled {
            return Ok(None);
        }
        let threshold_percent = if (1..100).contains(&config.threshold_percent) {
            config.threshold_percent
        } else {
            AutoCompactConfig::default().threshold_percent
        };
        let compact_timeout = if config.timeout.is_zero() {
            AutoCompactConfig::default().timeout
        } else {
            config.timeout
        };
        let usage = self
            .inner
            .latest_context_usage
            .lock()
            .expect("context usage lock")
            .clone();
        let Some(usage) = usage.filter(|usage| usage.thread_id == thread_id) else {
            return Ok(None);
        };
        if usage.model_context_window == 0
            || usage.total_tokens.saturating_mul(100)
                < usage.model_context_window * u64::from(threshold_percent)
        {
            return Ok(None);
        }
        let percent = ((usage.total_tokens as f64 / usage.model_context_window as f64) * 100.0)
            .round() as u64;
        self.emit(AgentEvent {
            phase: "analysis".to_string(),
            title: "自动压缩上下文".to_string(),
            detail: Some(format!("上下文已使用 {percent}%，正在压缩后继续")),
            delta: None,
            timestamp: now_ms(),
            raw: json!({"type": "turn.started"}),
            session_fallback: None,
        });
        if let Err(error) = self
            .compact_thread(client, thread_id, compact_timeout, abort)
            .await
        {
            if is_missing_provider_session(&error.to_string()) {
                *self
                    .inner
                    .latest_context_usage
                    .lock()
                    .expect("context usage lock") = None;
                return Ok(Some(error.to_string()));
            }
            return Err(error);
        }
        *self
            .inner
            .latest_context_usage
            .lock()
            .expect("context usage lock") = None;
        self.emit(AgentEvent {
            phase: "analysis".to_string(),
            title: "上下文压缩完成".to_string(),
            detail: Some("将继续处理当前请求".to_string()),
            delta: None,
            timestamp: now_ms(),
            raw: json!({"type": "turn.completed"}),
            session_fallback: None,
        });
        Ok(None)
    }

    async fn compact_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
        timeout: Duration,
        abort: Option<watch::Receiver<bool>>,
    ) -> Result<(), AgentError> {
        let (done_tx, done_rx) = oneshot::channel::<Result<(), String>>();
        let done = Arc::new(std::sync::Mutex::new(Some(done_tx)));
        let compact_turn_id = Arc::new(std::sync::Mutex::new(None::<String>));
        let mut subscriptions = Vec::new();
        for method in ["turn/started", "item/started", "turn/completed", "error"] {
            let done = Arc::clone(&done);
            let compact_turn_id = Arc::clone(&compact_turn_id);
            let thread_id = thread_id.to_string();
            let subscription = client
                .on_notification(method, move |params, _| {
                    if extract_thread_id(&params).as_deref() != Some(thread_id.as_str()) {
                        return;
                    }
                    match method {
                        "turn/started" => {
                            if let Some(turn_id) = extract_turn_id(&params) {
                                *compact_turn_id.lock().expect("compact turn lock") = Some(turn_id);
                            }
                        }
                        "item/started" => {
                            if params.pointer("/item/type").and_then(Value::as_str)
                                == Some("contextCompaction")
                                && let Some(turn_id) = extract_turn_id(&params)
                            {
                                *compact_turn_id.lock().expect("compact turn lock") = Some(turn_id);
                            }
                        }
                        "turn/completed" => {
                            let expected =
                                compact_turn_id.lock().expect("compact turn lock").clone();
                            let actual = extract_turn_id(&params);
                            if expected.is_some() && actual.is_some() && expected != actual {
                                return;
                            }
                            let status = params.pointer("/turn/status").and_then(Value::as_str);
                            if status.is_none() || status == Some("completed") {
                                signal_done(&done, Ok(()));
                            } else {
                                signal_done(
                                    &done,
                                    Err(format!(
                                        "compact turn ended with status {}",
                                        status.unwrap_or("unknown")
                                    )),
                                );
                            }
                        }
                        "error"
                            if params.get("willRetry").and_then(Value::as_bool) != Some(true) =>
                        {
                            signal_done(&done, Err(extract_error_message(&params)));
                        }
                        _ => {}
                    }
                })
                .await;
            subscriptions.push(TurnSubscription::Notification(method, subscription));
        }
        let close_subscription = {
            let done = Arc::clone(&done);
            client
                .on_close(move |code| {
                    signal_done(
                        &done,
                        Err(format!(
                            "codex app-server closed during compact (exit={code:?})"
                        )),
                    );
                })
                .await
        };
        subscriptions.push(TurnSubscription::Close(close_subscription));

        let request = client
            .request(
                "thread/compact/start",
                json!({"threadId": thread_id}),
                Some(timeout),
            )
            .await;
        let result = match request {
            Ok(_) => {
                let wait = async {
                    match done_rx.await {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(message)) => Err(AgentError::CompactionFailed(message)),
                        Err(_) => Err(AgentError::CompactionFailed(
                            "compact completion channel closed".to_string(),
                        )),
                    }
                };
                let timed = async {
                    tokio::time::timeout(timeout, wait).await.map_err(|_| {
                        AgentError::CompactionFailed(format!(
                            "compact turn timed out after {}ms",
                            timeout.as_millis()
                        ))
                    })?
                };
                if let Some(abort) = abort {
                    tokio::select! {
                        result = timed => result,
                        _ = wait_for_abort(abort) => Err(AgentError::CompactionFailed(
                            "用户中断了请求".to_string(),
                        )),
                    }
                } else {
                    timed.await
                }
            }
            Err(error) => Err(error.into()),
        };
        let active_compact_turn = compact_turn_id.lock().expect("compact turn lock").clone();
        if result.is_err()
            && let Some(turn_id) = active_compact_turn
        {
            let _ = client
                .request(
                    "turn/interrupt",
                    json!({"threadId": thread_id, "turnId": turn_id}),
                    Some(Duration::from_secs(5)),
                )
                .await;
        }
        self.cleanup_subscriptions(client, subscriptions).await;
        result
    }

    fn remember_turn_thread(&self, state: &SharedTurnState, thread_id: &str) {
        state
            .lock()
            .expect("turn state lock")
            .thread_id_from_started
            .get_or_insert_with(|| thread_id.to_string());
    }

    async fn clear_thread(&self) {
        *self.inner.thread_id.lock().await = None;
        *self.inner.loaded_thread.lock().await = None;
        *self.inner.thread_has_builtin_tools.lock().await = None;
    }

    fn emit_session_fallback(&self, previous_thread_id: &str, message: &str) {
        let detail = format!("原会话 {previous_thread_id} 已不存在，已改用新会话继续（{message}）");
        self.emit(AgentEvent {
            phase: "connection".to_string(),
            title: "会话已失效，改用新会话".to_string(),
            detail: Some(detail.clone()),
            delta: None,
            timestamp: now_ms(),
            raw: json!({"type": "error", "message": detail}),
            session_fallback: Some(AgentSessionFallback {
                reason: "missing_provider_session".to_string(),
                previous_session_id: previous_thread_id.to_string(),
            }),
        });
    }

    async fn ensure_thread(
        &self,
        client: &CodexAppServerClient,
        state: &Arc<std::sync::Mutex<TurnState>>,
    ) -> Result<String, AgentError> {
        let mut current = self.inner.thread_id.lock().await.clone();
        if current.is_some() && *self.inner.thread_has_builtin_tools.lock().await != Some(true) {
            *self.inner.thread_id.lock().await = None;
            *self.inner.loaded_thread.lock().await = None;
            *self.inner.thread_has_builtin_tools.lock().await = None;
            current = None;
        }
        if let Some(thread_id) = current {
            let loaded = self.inner.loaded_thread.lock().await.clone();
            if loaded.as_ref().is_some_and(|(client_id, loaded_thread)| {
                client_id == client.instance_id() && loaded_thread == &thread_id
            }) {
                return Ok(thread_id);
            }
            match self
                .request_with_timeout(
                    client,
                    "thread/resume",
                    self.thread_resume_params(&thread_id),
                )
                .await
            {
                Ok(result) => {
                    let resumed = result
                        .pointer("/thread/id")
                        .and_then(Value::as_str)
                        .unwrap_or(&thread_id)
                        .to_string();
                    self.remember_loaded_thread(client, &resumed).await;
                    self.remember_policy(&result).await;
                    return Ok(resumed);
                }
                Err(error) if is_missing_provider_session(&error.to_string()) => {
                    self.clear_thread().await;
                    self.emit_session_fallback(&thread_id, &error.to_string());
                }
                Err(error) => return Err(error),
            }
        }

        let result = self
            .request_with_timeout(client, "thread/start", self.thread_start_params())
            .await?;
        self.remember_policy(&result).await;
        let thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                state
                    .lock()
                    .expect("turn state lock")
                    .thread_id_from_started
                    .clone()
            })
            .ok_or(AgentError::MissingThreadId)?;
        self.remember_builtin_thread(client, &thread_id).await;
        Ok(thread_id)
    }

    async fn start_turn(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
        parts: &[AgentInputPart],
    ) -> Result<(), AgentError> {
        let policy = self
            .inner
            .configured_policy
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| TurnPolicy {
                sandbox_policy: self.inner.options.sandbox_mode.turn_policy(),
                approval_policy: json!("untrusted"),
            });
        let mut params = serde_json::Map::from_iter([
            ("threadId".to_string(), json!(thread_id)),
            ("input".to_string(), serde_json::to_value(parts)?),
            ("sandboxPolicy".to_string(), policy.sandbox_policy),
            ("approvalPolicy".to_string(), policy.approval_policy),
            (
                "effort".to_string(),
                json!(self.inner.options.reasoning_effort),
            ),
        ]);
        if let Some(model) = self.inner.options.model.as_ref() {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(cwd) = self.inner.options.working_directory.as_ref() {
            params.insert("cwd".to_string(), json!(cwd.to_string_lossy().to_string()));
        }
        self.request_with_timeout(client, "turn/start", Value::Object(params))
            .await?;
        Ok(())
    }

    async fn wait_for_turn(
        &self,
        wait: impl Future<Output = Result<(), AgentError>>,
        abort: Option<watch::Receiver<bool>>,
    ) -> Result<(), AgentError> {
        let wait = async {
            if let Some(timeout) = self.inner.options.turn_timeout {
                tokio::time::timeout(timeout, wait)
                    .await
                    .map_err(|_| AgentError::TimedOut { timeout })?
            } else {
                wait.await
            }
        };
        let Some(abort) = abort else {
            return wait.await;
        };
        tokio::select! {
            result = wait => result,
            _ = wait_for_abort(abort) => Err(AgentError::Aborted),
        }
    }

    fn daemon_options(&self) -> SpawnOptions {
        let mut options = self.inner.options.daemon_options.clone();
        if options.cwd.is_none() {
            options.cwd = self.inner.options.working_directory.clone();
        }
        options
    }

    fn thread_start_params(&self) -> Value {
        let mut params = serde_json::Map::from_iter([
            ("experimentalRawEvents".to_string(), json!(false)),
            ("persistExtendedHistory".to_string(), json!(false)),
            ("approvalPolicy".to_string(), json!("untrusted")),
            (
                "dynamicTools".to_string(),
                Value::Array(self.dynamic_tools()),
            ),
            (
                "sandbox".to_string(),
                json!(self.inner.options.sandbox_mode.thread_value()),
            ),
        ]);
        self.insert_thread_overrides(&mut params);
        Value::Object(params)
    }

    fn thread_resume_params(&self, thread_id: &str) -> Value {
        let mut params = serde_json::Map::from_iter([
            ("threadId".to_string(), json!(thread_id)),
            ("persistExtendedHistory".to_string(), json!(false)),
            ("approvalPolicy".to_string(), json!("untrusted")),
            (
                "sandbox".to_string(),
                json!(self.inner.options.sandbox_mode.thread_value()),
            ),
        ]);
        self.insert_thread_overrides(&mut params);
        Value::Object(params)
    }

    fn insert_thread_overrides(&self, params: &mut serde_json::Map<String, Value>) {
        if let Some(cwd) = self.inner.options.working_directory.as_ref() {
            params.insert("cwd".to_string(), json!(cwd.to_string_lossy().to_string()));
        }
        if let Some(model) = self.inner.options.model.as_ref() {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(instructions) = self.inner.options.developer_instructions.as_ref() {
            params.insert("developerInstructions".to_string(), json!(instructions));
        }
    }

    fn dynamic_tools(&self) -> Vec<Value> {
        let mut tools = self.inner.options.dynamic_tools.clone();
        if !tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some("review_action"))
        {
            tools.insert(
                0,
                json!({
                    "type": "function",
                    "name": "review_action",
                    "description": REVIEW_ACTION_DESCRIPTION,
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": false
                    },
                    "deferLoading": false
                }),
            );
        }
        tools
    }

    async fn request_with_timeout(
        &self,
        client: &CodexAppServerClient,
        method: &str,
        params: Value,
    ) -> Result<Value, AgentError> {
        Ok(client
            .request(method, params, self.inner.options.turn_timeout)
            .await?)
    }

    async fn remember_loaded_thread(&self, client: &CodexAppServerClient, thread_id: &str) {
        *self.inner.thread_id.lock().await = Some(thread_id.to_string());
        *self.inner.loaded_thread.lock().await =
            Some((client.instance_id().to_string(), thread_id.to_string()));
    }

    async fn remember_builtin_thread(&self, client: &CodexAppServerClient, thread_id: &str) {
        self.remember_loaded_thread(client, thread_id).await;
        *self.inner.thread_has_builtin_tools.lock().await = Some(true);
    }

    async fn remember_policy(&self, result: &Value) {
        let sandbox_policy = result
            .get("sandbox")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| self.inner.options.sandbox_mode.turn_policy());
        let approval_policy = result
            .get("approvalPolicy")
            .cloned()
            .unwrap_or_else(|| json!("untrusted"));
        *self.inner.configured_policy.lock().await = Some(TurnPolicy {
            sandbox_policy,
            approval_policy,
        });
    }

    fn emit(&self, event: AgentEvent) {
        let handlers = self
            .inner
            .listeners
            .lock()
            .expect("agent event listener lock")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handler in handlers {
            handler(event.clone());
        }
    }
}

fn belongs_to_turn(params: &Value, state: &SharedTurnState) -> bool {
    let current = state.lock().expect("turn state lock");
    if let (Some(notification), Some(expected)) =
        (extract_turn_id(params), current.turn_id.as_ref())
        && &notification != expected
    {
        return false;
    }
    if let Some(notification_thread) = extract_thread_id(params)
        && let Some(expected) = current.thread_id_from_started.as_ref()
        && &notification_thread != expected
    {
        return false;
    }
    true
}

fn is_active_server_request(params: &Value, state: &SharedTurnState) -> bool {
    let current = state.lock().expect("turn state lock");
    if current.failed.is_some() {
        return false;
    }
    let Some(expected_thread) = current.thread_id_from_started.as_ref() else {
        return false;
    };
    let Some(expected_turn) = current.turn_id.as_ref() else {
        return false;
    };
    params.get("threadId").and_then(Value::as_str) == Some(expected_thread)
        && params.get("turnId").and_then(Value::as_str) == Some(expected_turn)
}

fn failure_builtin_response(message: &str) -> Value {
    json!({
        "success": false,
        "contentItems": [{
            "type": "inputText",
            "text": format!("Built-in tool failed: {message}")
        }]
    })
}

fn builtin_response(tool: &str, result: &Value) -> Value {
    let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut lines = vec![format!(
        "{tool} {}.",
        if ok { "completed" } else { "failed" }
    )];
    if let Some(job_id) = non_empty_string(result.get("jobId")) {
        lines.push(format!("Actions job: {job_id}."));
    }
    if tool == "review_action" {
        if let Some(status) = non_empty_string(result.get("status")) {
            lines.push(format!("Status: {status}."));
        }
        if let Some(issue_id) = result.get("issueId").and_then(Value::as_i64) {
            lines.push(format!("Issue: #{issue_id}."));
        }
        if let Some(note) = non_empty_string(result.get("note")) {
            lines.push(note.to_string());
        }
    }
    if let Some(error) = non_empty_string(result.get("error")) {
        lines.push(format!("Reason: {error}"));
    }
    json!({
        "success": ok,
        "contentItems": [{"type": "inputText", "text": lines.join("\n")}]
    })
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn map_item_event(event_type: &str, item: &Value, command_cwd: &Path) -> Option<MappedItemEvent> {
    match item.get("type").and_then(Value::as_str)? {
        "agentMessage" if event_type == "item.completed" => Some(MappedItemEvent {
            phase: "responding",
            title: "生成回复",
            detail: None,
            raw: json!({"type": event_type, "item": item}),
        }),
        "commandExecution" => {
            let status = item.get("status").and_then(Value::as_str);
            let title = match status {
                Some("completed") => "命令完成",
                Some("failed" | "declined") => "命令失败",
                _ => "执行命令",
            };
            let command = item
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !ads_native::command_has_executable(command, command_cwd) {
                return None;
            }
            let mut detail = command.to_string();
            if let Some(exit_code) = item.get("exitCode").and_then(Value::as_i64) {
                detail.push_str(&format!(" | 退出码 {exit_code}"));
            }
            Some(MappedItemEvent {
                phase: "command",
                title,
                detail: Some(truncate_detail(&detail, 180)),
                raw: json!({
                    "type": event_type,
                    "item": {
                        "type": "command_execution",
                        "id": item.get("id").cloned().unwrap_or(Value::Null),
                        "command": command,
                        "status": status,
                        "exit_code": item.get("exitCode").cloned().unwrap_or(Value::Null),
                        "aggregated_output": item.get("aggregatedOutput").cloned().unwrap_or(Value::Null)
                    }
                }),
            })
        }
        "fileChange" => Some(MappedItemEvent {
            phase: "editing",
            title: if event_type == "item.completed" {
                "应用文件修改完成"
            } else {
                "准备文件修改"
            },
            detail: None,
            raw: json!({"type": event_type, "item": item}),
        }),
        "webSearch" => Some(MappedItemEvent {
            phase: "tool",
            title: if event_type == "item.completed" {
                "搜索完成"
            } else {
                "发起搜索"
            },
            detail: item
                .get("query")
                .and_then(Value::as_str)
                .map(|query| truncate_detail(query, 180)),
            raw: json!({"type": event_type, "item": item}),
        }),
        "contextCompaction" => Some(MappedItemEvent {
            phase: "context",
            title: if event_type == "item.completed" {
                "Context ready"
            } else {
                "Loading context"
            },
            detail: None,
            raw: json!({
                "type": event_type,
                "item": {
                    "type": "context",
                    "id": item.get("id").cloned().unwrap_or(Value::Null),
                    "text": ""
                }
            }),
        }),
        "mcpToolCall" | "dynamicToolCall" => Some(MappedItemEvent {
            phase: "tool",
            title: match item.get("status").and_then(Value::as_str) {
                Some("completed") if event_type == "item.completed" => "工具调用完成",
                Some("failed") => "工具调用失败",
                _ => "调用工具",
            },
            detail: join_tool_name(item),
            raw: json!({"type": event_type, "item": item}),
        }),
        _ => None,
    }
}

fn truncate_detail(value: &str, limit: usize) -> String {
    if value.encode_utf16().count() <= limit {
        return value.to_string();
    }
    let mut output = String::new();
    let mut units = 0usize;
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width >= limit {
            break;
        }
        output.push(character);
        units += width;
    }
    output.push('…');
    output
}

fn join_tool_name(item: &Value) -> Option<String> {
    let joined = ["server", "tool"]
        .iter()
        .filter_map(|key| item.get(*key).and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(".");
    (!joined.is_empty()).then_some(joined)
}

fn item_may_have_side_effect(item_type: Option<&str>) -> bool {
    matches!(
        item_type,
        Some(
            "commandExecution"
                | "fileChange"
                | "webSearch"
                | "mcpToolCall"
                | "dynamicToolCall"
                | "collabAgentToolCall"
        )
    )
}

fn signal_done(done: &SharedTurnCompletion, result: Result<(), String>) {
    if let Some(sender) = done.lock().expect("turn completion lock").take() {
        let _ = sender.send(result);
    }
}

async fn wait_for_abort(mut abort: watch::Receiver<bool>) {
    if *abort.borrow() {
        return;
    }
    while abort.changed().await.is_ok() {
        if *abort.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

fn extract_thread_id(params: &Value) -> Option<String> {
    params
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("threadId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn extract_turn_id(params: &Value) -> Option<String> {
    params
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("turnId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn extract_error_message(params: &Value) -> String {
    params
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| params.get("error").and_then(Value::as_str))
        .or_else(|| params.pointer("/error/message").and_then(Value::as_str))
        .unwrap_or("codex app-server reported an error")
        .to_string()
}

fn extract_usage_from_token_usage(params: &Value) -> Option<Value> {
    let last = params.pointer("/tokenUsage/last")?;
    let mut usage = serde_json::Map::new();
    for (source, destination) in [
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("totalTokens", "total_tokens"),
    ] {
        if let Some(value) = last.get(source).and_then(Value::as_u64) {
            usage.insert(destination.to_string(), json!(value));
        }
    }
    (!usage.is_empty()).then_some(Value::Object(usage))
}

fn extract_context_usage(params: &Value) -> Option<ContextUsage> {
    let thread_id = extract_thread_id(params)?;
    let total_tokens = params
        .pointer("/tokenUsage/last/totalTokens")
        .and_then(Value::as_u64)?;
    let model_context_window = params
        .pointer("/tokenUsage/modelContextWindow")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)?;
    Some(ContextUsage {
        thread_id,
        total_tokens,
        model_context_window,
    })
}

fn is_missing_provider_session(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("no rollout found")
        || normalized.contains("no conversation found")
        || (normalized.contains("not found")
            && (normalized.contains("thread")
                || normalized.contains("session")
                || normalized.contains("conversation")))
}

fn is_retryable_agent_error(error: &AgentError) -> bool {
    let message = error.to_string();
    let eligible = matches!(
        error,
        AgentError::TurnFailed(_)
            | AgentError::Rpc(RpcError::Transport(_))
            | AgentError::Rpc(RpcError::Closed { .. })
            | AgentError::Rpc(RpcError::Timeout { .. })
            | AgentError::Rpc(RpcError::Remote { .. })
    );
    eligible && is_transient_upstream_model_error(&message)
}

fn is_transient_upstream_model_error(message: &str) -> bool {
    let normalized = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    normalized.contains("we're currently experiencing high demand")
        || normalized.contains("we are currently experiencing high demand")
        || (normalized.contains("high demand") && normalized.contains("temporary errors"))
        || contains_http_status(&normalized, "429")
        || (contains_http_status(&normalized, "503") && normalized.contains("service unavailable"))
        || ["520", "521", "522", "523", "524"]
            .iter()
            .any(|status| contains_http_status(&normalized, status))
        || normalized.contains("bad_response_status_code")
        || normalized.contains("stream disconnected")
        || normalized.contains("stream closed before response.completed")
        || normalized.contains("econnreset")
        || normalized.contains("etimedout")
        || normalized.contains("econnrefused")
        || normalized.contains("socket hang up")
        || normalized.contains("premature close")
        || normalized.contains("fetch failed")
}

fn contains_http_status(message: &str, status: &str) -> bool {
    message.match_indices(status).any(|(index, _)| {
        let before = message[..index].chars().next_back();
        let after = message[index + status.len()..].chars().next();
        !before.is_some_and(|value| value.is_ascii_digit())
            && !after.is_some_and(|value| value.is_ascii_digit())
    })
}

fn retry_delay_ms(config: &RetryConfig, attempt: usize, _message: &str) -> u64 {
    if let Some(backoff) = config.backoff_ms.as_ref()
        && !backoff.is_empty()
    {
        return backoff[(attempt - 1).min(backoff.len() - 1)];
    }
    let exponent = attempt.saturating_sub(1).min(4) as u32;
    2_000_u64
        .saturating_mul(2_u64.saturating_pow(exponent))
        .min(30_000)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn command_items_require_an_executable_in_the_effective_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let script = directory.path().join("script.sh");
        std::fs::write(&script, "#!/bin/sh\n").expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        let item = json!({
            "type": "commandExecution",
            "id": "command-1",
            "command": "./script.sh",
            "status": "completed"
        });
        assert!(map_item_event("item.completed", &item, directory.path()).is_some());

        let reasoning = json!({
            "type": "commandExecution",
            "id": "command-2",
            "command": "Please inspect the logs",
            "status": "completed"
        });
        assert!(map_item_event("item.completed", &reasoning, directory.path()).is_none());
    }
}
