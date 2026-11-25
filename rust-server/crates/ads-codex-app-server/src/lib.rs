use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, Command};
use tokio::sync::{Mutex, Notify, oneshot};

mod agent;
mod daemon_registry;
mod prompt_runner;
mod provider_injection;
mod reviewer;

pub use agent::{
    ActionToolFuture, AgentActionTools, AgentError, AgentEvent, AgentInputPart, AgentRunResult,
    AgentSendOptions, AgentSessionFallback, AutoCompactConfig, CodexAppServerAgent,
    CodexAppServerAgentOptions, RetryConfig, SandboxMode,
};
pub use daemon_registry::{
    ClientFactory, ClientFuture, CodexAppServerDaemonRegistry, get_shared_daemon_registry,
};
pub use prompt_runner::{
    CodexActionToolsFactory, CodexAppServerPromptRunner, CodexAppServerPromptRunnerOptions,
};
pub use reviewer::{
    CodexReviewRequest, augment_path_with_cargo_bin, is_mutating_review_command,
    is_verification_command, run_codex_review,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRuntimeBackend {
    Native,
    CodexAppServer,
}

pub fn resolve_agent_runtime(value: Option<&str>) -> AgentRuntimeBackend {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    match value.as_str() {
        "" | "native" | "in-process" => AgentRuntimeBackend::Native,
        "codex-app-server" | "codex" | "cli" => AgentRuntimeBackend::CodexAppServer,
        _ => AgentRuntimeBackend::CodexAppServer,
    }
}

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_CLOSE_TIMEOUT: Duration = Duration::from_millis(1_500);
const CLIENT_NAME: &str = "ads-codex-appserver-adapter";
const CLIENT_VERSION: &str = "0.1.0";

pub type RpcResult<T> = Result<T, RpcError>;
pub type ServerRequestFuture = Pin<Box<dyn Future<Output = RpcResult<Value>> + Send>>;
pub type ServerRequestHandler =
    Arc<dyn Fn(Value, String, RequestId) -> ServerRequestFuture + Send + Sync>;
pub type ServerRequestMatcher = Arc<dyn Fn(&Value, &str, &RequestId) -> bool + Send + Sync>;
type NotificationHandler = Arc<dyn Fn(Value, String) + Send + Sync>;
type CloseHandler = Arc<dyn Fn(Option<i32>) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnOptions {
    pub binary: String,
    pub global_args: Vec<String>,
    pub app_server_args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub request_timeout: Duration,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            binary: std::env::var("ADS_CODEX_BIN").unwrap_or_else(|_| "codex".to_string()),
            global_args: Vec::new(),
            app_server_args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub title: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeCapabilities {
    pub experimental_api: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub user_agent: String,
    pub codex_home: String,
    pub platform_family: String,
    pub platform_os: String,
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("codex app-server request \"{method}\" timed out after {}ms", timeout.as_millis())]
    Timeout { method: String, timeout: Duration },
    #[error("codex app-server error {code}: {message}")]
    Remote {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("codex app-server closed (exit={exit_code:?}, graceful={graceful})")]
    Closed {
        exit_code: Option<i32>,
        graceful: bool,
    },
    #[error("codex app-server client is not started")]
    NotStarted,
    #[error("codex app-server transport error: {0}")]
    Transport(String),
    #[error("codex app-server returned an invalid response: {0}")]
    InvalidResponse(String),
    #[error("codex app-server spawn error: {0}")]
    Spawn(String),
}

impl RpcError {
    pub fn is_graceful_close(&self) -> bool {
        matches!(self, Self::Closed { graceful: true, .. })
    }
}

#[derive(Debug, Clone)]
pub struct Subscription {
    id: u64,
}

pub struct CodexAppServerClient {
    id: String,
    inner: Arc<ClientInner>,
}

struct ClientInner {
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pid: Option<u32>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    notification_handlers: Mutex<HashMap<String, HashMap<u64, NotificationHandler>>>,
    any_notification_handlers: Mutex<HashMap<u64, NotificationHandler>>,
    server_request_handlers: Mutex<HashMap<String, HashMap<u64, RegisteredServerRequest>>>,
    close_handlers: Mutex<HashMap<u64, CloseHandler>>,
    next_handler_id: AtomicU64,
    closed: AtomicBool,
    close_reported: AtomicBool,
    graceful_close_requested: AtomicBool,
    closed_notify: Notify,
    request_timeout: Duration,
    start_lock: Mutex<()>,
    started: AtomicBool,
    initialize_response: Mutex<Option<InitializeResponse>>,
}

struct PendingRequest {
    sender: oneshot::Sender<RpcResult<Value>>,
}

#[derive(Clone)]
struct RegisteredServerRequest {
    handler: ServerRequestHandler,
    matcher: Option<ServerRequestMatcher>,
}

impl Clone for CodexAppServerClient {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            inner: Arc::clone(&self.inner),
        }
    }
}

impl std::fmt::Debug for CodexAppServerClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexAppServerClient")
            .field("id", &self.id)
            .field("closed", &self.is_closed())
            .finish()
    }
}

impl CodexAppServerClient {
    pub async fn spawn(options: SpawnOptions) -> RpcResult<Self> {
        let mut command = Command::new(&options.binary);
        command.args(&options.global_args);
        command.arg("app-server");
        command.args(&options.app_server_args);
        if let Some(cwd) = options.cwd.as_ref() {
            command.current_dir(cwd);
        }
        command.envs(&options.env);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| RpcError::Spawn(error.to_string()))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| RpcError::Spawn("missing app-server stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RpcError::Spawn("missing app-server stdout".to_string()))?;
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(stderr);
        }
        let client = Self::from_parts(stdout, stdin, pid, options.request_timeout);
        let monitor = client.clone();
        tokio::spawn(async move {
            let exit_code = child.wait().await.ok().and_then(|status| status.code());
            monitor.inner.mark_closed(exit_code).await;
        });
        Ok(client)
    }

    pub fn from_io<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::from_parts(reader, writer, None, DEFAULT_REQUEST_TIMEOUT)
    }

    pub fn from_io_with_timeout<R, W>(reader: R, writer: W, request_timeout: Duration) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::from_parts(reader, writer, None, request_timeout)
    }

    fn from_parts<R, W>(reader: R, writer: W, pid: Option<u32>, request_timeout: Duration) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let inner = Arc::new(ClientInner {
            writer: Mutex::new(Box::new(writer)),
            pid,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            notification_handlers: Mutex::new(HashMap::new()),
            any_notification_handlers: Mutex::new(HashMap::new()),
            server_request_handlers: Mutex::new(HashMap::new()),
            close_handlers: Mutex::new(HashMap::new()),
            next_handler_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            close_reported: AtomicBool::new(false),
            graceful_close_requested: AtomicBool::new(false),
            closed_notify: Notify::new(),
            request_timeout,
            start_lock: Mutex::new(()),
            started: AtomicBool::new(false),
            initialize_response: Mutex::new(None),
        });
        let weak = Arc::downgrade(&inner);
        tokio::spawn(read_stdout(weak, reader));
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            inner,
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.id
    }

    pub async fn start(&self) -> RpcResult<InitializeResponse> {
        let _guard = self.inner.start_lock.lock().await;
        if self.inner.started.load(Ordering::Acquire) {
            return self
                .inner
                .initialize_response
                .lock()
                .await
                .clone()
                .ok_or_else(|| {
                    RpcError::InvalidResponse("missing initialize response".to_string())
                });
        }
        let result = self
            .request(
                "initialize",
                json!(InitializeParams {
                    client_info: ClientInfo {
                        name: CLIENT_NAME.to_string(),
                        title: None,
                        version: CLIENT_VERSION.to_string(),
                    },
                    capabilities: InitializeCapabilities {
                        experimental_api: true,
                    },
                }),
                Some(self.inner.request_timeout),
            )
            .await?;
        let response: InitializeResponse = serde_json::from_value(result)
            .map_err(|error| RpcError::InvalidResponse(error.to_string()))?;
        self.inner
            .write_json(&json!({ "jsonrpc": "2.0", "method": "initialized" }))
            .await?;
        *self.inner.initialize_response.lock().await = Some(response.clone());
        self.inner.started.store(true, Ordering::Release);
        Ok(response)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> RpcResult<Value> {
        if self.is_closed() {
            return Err(self.inner.closed_error());
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::AcqRel);
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id, PendingRequest { sender });
        self.inner
            .write_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .await?;
        let timeout = timeout.unwrap_or(self.inner.request_timeout);
        if timeout.is_zero() {
            return receiver.await.map_err(|_| self.inner.closed_error())?;
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.inner.closed_error()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(RpcError::Timeout {
                    method: method.to_string(),
                    timeout,
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> RpcResult<()> {
        self.inner
            .write_json(&json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }))
            .await
    }

    pub async fn on_notification<F>(&self, method: &str, handler: F) -> Subscription
    where
        F: Fn(Value, String) + Send + Sync + 'static,
    {
        let id = self.inner.next_handler_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .notification_handlers
            .lock()
            .await
            .entry(method.to_string())
            .or_default()
            .insert(id, Arc::new(handler));
        Subscription { id }
    }

    pub async fn on_any_notification<F>(&self, handler: F) -> Subscription
    where
        F: Fn(Value, String) + Send + Sync + 'static,
    {
        let id = self.inner.next_handler_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .any_notification_handlers
            .lock()
            .await
            .insert(id, Arc::new(handler));
        Subscription { id }
    }

    pub async fn off_notification(&self, method: &str, subscription: &Subscription) {
        let mut handlers = self.inner.notification_handlers.lock().await;
        if let Some(method_handlers) = handlers.get_mut(method) {
            method_handlers.remove(&subscription.id);
            if method_handlers.is_empty() {
                handlers.remove(method);
            }
        }
    }

    pub async fn off_any_notification(&self, subscription: &Subscription) {
        self.inner
            .any_notification_handlers
            .lock()
            .await
            .remove(&subscription.id);
    }

    pub async fn on_server_request<F, Fut>(
        &self,
        method: &str,
        handler: F,
        matcher: Option<ServerRequestMatcher>,
    ) -> Subscription
    where
        F: Fn(Value, String, RequestId) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = RpcResult<Value>> + Send + 'static,
    {
        let handler: ServerRequestHandler =
            Arc::new(move |params, method, id| Box::pin(handler(params, method, id)));
        let id = self.inner.next_handler_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .server_request_handlers
            .lock()
            .await
            .entry(method.to_string())
            .or_default()
            .insert(id, RegisteredServerRequest { handler, matcher });
        Subscription { id }
    }

    pub async fn off_server_request(&self, method: &str, subscription: &Subscription) {
        let mut handlers = self.inner.server_request_handlers.lock().await;
        if let Some(method_handlers) = handlers.get_mut(method) {
            method_handlers.remove(&subscription.id);
            if method_handlers.is_empty() {
                handlers.remove(method);
            }
        }
    }

    pub async fn on_close<F>(&self, handler: F) -> Subscription
    where
        F: Fn(Option<i32>) + Send + Sync + 'static,
    {
        let id = self.inner.next_handler_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .close_handlers
            .lock()
            .await
            .insert(id, Arc::new(handler));
        Subscription { id }
    }

    pub async fn off_close(&self, subscription: &Subscription) {
        self.inner
            .close_handlers
            .lock()
            .await
            .remove(&subscription.id);
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    pub fn is_gracefully_closed(&self) -> bool {
        self.inner.graceful_close_requested.load(Ordering::Acquire)
    }

    pub async fn close(&self) {
        if self.is_closed() {
            return;
        }
        self.inner
            .graceful_close_requested
            .store(true, Ordering::Release);
        {
            let mut writer = self.inner.writer.lock().await;
            let _ = writer.shutdown().await;
        }
        if self.inner.pid.is_some() && !wait_for_close(&self.inner, DEFAULT_CLOSE_TIMEOUT).await {
            signal_process(self.inner.pid, libc::SIGTERM);
            if !wait_for_close(&self.inner, DEFAULT_CLOSE_TIMEOUT).await {
                signal_process(self.inner.pid, libc::SIGKILL);
            }
        }
        self.inner.mark_closed(None).await;
    }
}

impl ClientInner {
    async fn write_json(&self, value: &Value) -> RpcResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(self.closed_error());
        }
        let mut line =
            serde_json::to_vec(value).map_err(|error| RpcError::Transport(error.to_string()))?;
        line.push(b'\n');
        let result = {
            let mut writer = self.writer.lock().await;
            match writer.write_all(&line).await {
                Ok(()) => writer.flush().await,
                Err(error) => Err(error),
            }
        };
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                self.mark_closed(None).await;
                Err(RpcError::Transport(error.to_string()))
            }
        }
    }

    async fn mark_closed(&self, exit_code: Option<i32>) {
        self.closed.store(true, Ordering::Release);
        self.closed_notify.notify_waiters();
        if self.close_reported.swap(true, Ordering::AcqRel) {
            return;
        }
        let graceful = self.graceful_close_requested.load(Ordering::Acquire);
        let error = RpcError::Closed {
            exit_code,
            graceful,
        };
        let mut pending = self.pending.lock().await;
        for (_, request) in pending.drain() {
            let _ = request.sender.send(Err(match &error {
                RpcError::Closed { .. } => RpcError::Closed {
                    exit_code,
                    graceful,
                },
                _ => RpcError::Closed {
                    exit_code,
                    graceful,
                },
            }));
        }
        drop(pending);
        let handlers = self
            .close_handlers
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for handler in handlers {
            handler(exit_code);
        }
    }

    fn closed_error(&self) -> RpcError {
        RpcError::Closed {
            exit_code: None,
            graceful: self.graceful_close_requested.load(Ordering::Acquire),
        }
    }
}

async fn read_stdout<R>(inner: Weak<ClientInner>, reader: R)
where
    R: AsyncRead + Send + Unpin + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(inner) = inner.upgrade() else {
            return;
        };
        dispatch_line(&inner, &line).await;
    }
    if let Some(inner) = inner.upgrade() {
        inner.mark_closed(None).await;
    }
}

async fn dispatch_line(inner: &Arc<ClientInner>, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let Some(object) = value.as_object() else {
        return;
    };
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = object.get("id").and_then(parse_server_request_id) {
            dispatch_server_request(inner, id, method.to_string(), params);
        } else if object.get("id").is_none() {
            dispatch_notification(inner, method.to_string(), params).await;
        }
    } else if let Some(id) = object.get("id").and_then(parse_request_id) {
        dispatch_response(inner, id, object).await;
    }
}

fn parse_request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::Number(number) => number.as_u64().map(RequestId::Number),
        Value::String(text) => text.parse::<u64>().ok().map(RequestId::Number),
        _ => None,
    }
}

fn parse_server_request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::Number(number) => number.as_u64().map(RequestId::Number),
        Value::String(text) => Some(RequestId::String(text.clone())),
        _ => None,
    }
}

async fn dispatch_response(
    inner: &Arc<ClientInner>,
    id: RequestId,
    object: &serde_json::Map<String, Value>,
) {
    let RequestId::Number(id) = id else {
        return;
    };
    let request = inner.pending.lock().await.remove(&id);
    let Some(request) = request else {
        return;
    };
    let result = if let Some(error) = object.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("codex app-server request failed")
            .to_string();
        Err(RpcError::Remote {
            code,
            message,
            data: error.get("data").cloned(),
        })
    } else {
        Ok(object.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = request.sender.send(result);
}

async fn dispatch_notification(inner: &Arc<ClientInner>, method: String, params: Value) {
    let handlers = {
        let handlers = inner.notification_handlers.lock().await;
        handlers
            .get(&method)
            .map(|entries| entries.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    for handler in handlers {
        handler(params.clone(), method.clone());
    }
    let any_handlers = inner
        .any_notification_handlers
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for handler in any_handlers {
        handler(params.clone(), method.clone());
    }
}

fn dispatch_server_request(inner: &Arc<ClientInner>, id: RequestId, method: String, params: Value) {
    let client = CodexAppServerClient {
        id: String::new(),
        inner: Arc::clone(inner),
    };
    tokio::spawn(async move {
        let registration = {
            let handlers = client.inner.server_request_handlers.lock().await;
            let entries = handlers.get(&method).cloned().unwrap_or_default();
            let mut selected = None;
            for entry in entries.values() {
                if entry
                    .matcher
                    .as_ref()
                    .is_some_and(|matcher| matcher(&params, &method, &id))
                {
                    selected = Some(entry.clone());
                    break;
                }
            }
            selected.or_else(|| {
                entries
                    .values()
                    .find(|entry| entry.matcher.is_none())
                    .cloned()
            })
        };
        let Some(registration) = registration else {
            let _ = client
                .respond_error(
                    id,
                    -32601,
                    format!("Unsupported server request: {method}"),
                    None,
                )
                .await;
            return;
        };
        match (registration.handler)(params, method, id.clone()).await {
            Ok(result) => {
                let _ = client.respond_result(id, result).await;
            }
            Err(error) => {
                let _ = client
                    .respond_error(id, -32603, error.to_string(), None)
                    .await;
            }
        }
    });
}

impl CodexAppServerClient {
    async fn respond_result(&self, id: RequestId, result: Value) -> RpcResult<()> {
        self.inner
            .write_json(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    async fn respond_error(
        &self,
        id: RequestId,
        code: i64,
        message: String,
        data: Option<Value>,
    ) -> RpcResult<()> {
        let mut error = json!({ "code": code, "message": message });
        if let Some(data) = data {
            error["data"] = data;
        }
        self.inner
            .write_json(&json!({ "jsonrpc": "2.0", "id": id, "error": error }))
            .await
    }
}

fn drain_stderr(stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    });
}

async fn wait_for_close(inner: &ClientInner, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while !inner.closed.load(Ordering::Acquire) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        let notified = inner.closed_notify.notified();
        if tokio::time::timeout(Duration::from_millis(10), notified)
            .await
            .is_err()
            && tokio::time::Instant::now() >= deadline
        {
            return false;
        }
    }
    true
}

fn signal_process(pid: Option<u32>, signal: i32) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The app-server child is owned by this client; never signal a broad process group.
        unsafe {
            libc::kill(pid as i32, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}

#[cfg(test)]
mod tests {
    use super::{AgentRuntimeBackend, resolve_agent_runtime};

    #[test]
    fn resolves_runtime_backend_like_typescript() {
        assert_eq!(resolve_agent_runtime(None), AgentRuntimeBackend::Native);
        assert_eq!(
            resolve_agent_runtime(Some("native")),
            AgentRuntimeBackend::Native
        );
        assert_eq!(
            resolve_agent_runtime(Some("in-process")),
            AgentRuntimeBackend::Native
        );
        assert_eq!(
            resolve_agent_runtime(Some("codex-app-server")),
            AgentRuntimeBackend::CodexAppServer
        );
        assert_eq!(
            resolve_agent_runtime(Some("codex")),
            AgentRuntimeBackend::CodexAppServer
        );
        assert_eq!(
            resolve_agent_runtime(Some("unknown")),
            AgentRuntimeBackend::CodexAppServer
        );
    }
}
