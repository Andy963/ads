use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, Command};
use tokio::sync::{Mutex, Notify, oneshot};

use crate::driver::AcpLaunchSpec;
use crate::error::{AcpError, AcpResult};
use crate::protocol::JsonRpcId;

pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEFAULT_GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_TERM_EXIT_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_STDERR_TAIL_LINES: usize = 32;
const MAX_MALFORMED_LINE_LEN: usize = 512;

pub type ServerRequestFuture = Pin<Box<dyn Future<Output = AcpResult<Value>> + Send>>;
pub type ServerRequestHandler =
    Arc<dyn Fn(Value, String, JsonRpcId) -> ServerRequestFuture + Send + Sync>;
type NotificationHandler = Arc<dyn Fn(Value, String) + Send + Sync>;
type CloseHandler = Arc<dyn Fn(AcpError) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpTransportConfig {
    pub rpc_timeout: Duration,
    pub graceful_exit_timeout: Duration,
    pub term_exit_timeout: Duration,
}

impl Default for AcpTransportConfig {
    fn default() -> Self {
        Self {
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
            graceful_exit_timeout: DEFAULT_GRACEFUL_EXIT_TIMEOUT,
            term_exit_timeout: DEFAULT_TERM_EXIT_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Subscription {
    id: u64,
}

#[derive(Clone)]
pub struct AcpTransport {
    id: String,
    inner: Arc<TransportInner>,
}

impl std::fmt::Debug for AcpTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AcpTransport")
            .field("id", &self.id)
            .field("pid", &self.inner.pid)
            .field("closed", &self.is_closed())
            .finish()
    }
}

struct PendingRequest {
    method: String,
    sender: oneshot::Sender<AcpResult<Value>>,
}

struct TransportInner {
    writer: Mutex<Option<Box<dyn AsyncWrite + Send + Unpin>>>,
    pid: Option<u32>,
    config: AcpTransportConfig,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    notification_handlers: Mutex<HashMap<String, HashMap<u64, NotificationHandler>>>,
    any_notification_handlers: Mutex<HashMap<u64, NotificationHandler>>,
    server_request_handlers: Mutex<HashMap<String, HashMap<u64, ServerRequestHandler>>>,
    close_handlers: Mutex<HashMap<u64, CloseHandler>>,
    next_handler_id: AtomicU64,
    closed: AtomicBool,
    close_reported: AtomicBool,
    graceful_close_requested: AtomicBool,
    child_exited: AtomicBool,
    group_killed: AtomicBool,
    exit_code: std::sync::Mutex<Option<i32>>,
    fatal_error: std::sync::Mutex<Option<AcpError>>,
    stderr_tail: std::sync::Mutex<VecDeque<String>>,
    closed_notify: Notify,
    exit_notify: Notify,
}

impl Drop for TransportInner {
    fn drop(&mut self) {
        if self.pid.is_some() && !self.child_exited.load(Ordering::Acquire) {
            self.kill_process_group_once();
        }
    }
}

impl AcpTransport {
    pub async fn spawn(spec: &AcpLaunchSpec, config: AcpTransportConfig) -> AcpResult<Self> {
        let mut command = Command::new(&spec.binary);
        command.args(&spec.args);
        if let Some(cwd) = spec.cwd.as_ref() {
            command.current_dir(cwd);
        }
        if spec.clear_env {
            command.env_clear();
        }
        command.envs(&spec.env);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(false);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command
            .spawn()
            .map_err(|error| AcpError::Spawn(format!("{}: {error}", spec.binary)))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AcpError::Spawn("missing ACP subprocess stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AcpError::Spawn("missing ACP subprocess stdout".to_string()))?;
        let stderr = child.stderr.take();

        let transport = Self::from_parts(stdout, stdin, pid, config);
        if let Some(stderr) = stderr {
            drain_stderr(Arc::downgrade(&transport.inner), stderr);
        }
        let monitor = transport.clone();
        tokio::spawn(async move {
            let exit_code = child.wait().await.ok().and_then(|status| status.code());
            monitor.inner.record_child_exit(exit_code);
            // If the leader exited while descendants still hold open pipes, reap the group.
            monitor.inner.kill_process_group_once();
            monitor.inner.mark_closed(exit_code, None).await;
        });
        Ok(transport)
    }

    pub fn from_io<R, W>(reader: R, writer: W, config: AcpTransportConfig) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::from_parts(reader, writer, None, config)
    }

    fn from_parts<R, W>(reader: R, writer: W, pid: Option<u32>, config: AcpTransportConfig) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let inner = Arc::new(TransportInner {
            writer: Mutex::new(Some(Box::new(writer))),
            pid,
            config,
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
            child_exited: AtomicBool::new(pid.is_none()),
            group_killed: AtomicBool::new(false),
            exit_code: std::sync::Mutex::new(None),
            fatal_error: std::sync::Mutex::new(None),
            stderr_tail: std::sync::Mutex::new(VecDeque::new()),
            closed_notify: Notify::new(),
            exit_notify: Notify::new(),
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

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    pub fn is_gracefully_closed(&self) -> bool {
        self.inner.graceful_close_requested.load(Ordering::Acquire)
    }

    pub fn stderr_tail(&self) -> Option<String> {
        self.inner.stderr_tail_string()
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> AcpResult<Value> {
        if self.is_closed() {
            return Err(self.inner.closed_error());
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::AcqRel);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(
            id,
            PendingRequest {
                method: method.to_string(),
                sender,
            },
        );
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.inner.write_json(&frame).await {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }

        let effective_timeout = timeout.unwrap_or(self.inner.config.rpc_timeout);
        if effective_timeout.is_zero() {
            return receiver.await.map_err(|_| self.inner.closed_error())?;
        }
        match tokio::time::timeout(effective_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.inner.closed_error()),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(AcpError::Timeout {
                    method: method.to_string(),
                    timeout: effective_timeout,
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> AcpResult<()> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.inner.write_json(&frame).await
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

    pub async fn off_notification(&self, method: &str, subscription: Subscription) {
        let mut handlers = self.inner.notification_handlers.lock().await;
        if let Some(method_handlers) = handlers.get_mut(method) {
            method_handlers.remove(&subscription.id);
            if method_handlers.is_empty() {
                handlers.remove(method);
            }
        }
    }

    pub async fn off_any_notification(&self, subscription: Subscription) {
        self.inner
            .any_notification_handlers
            .lock()
            .await
            .remove(&subscription.id);
    }

    pub async fn on_server_request<F, Fut>(&self, method: &str, handler: F) -> Subscription
    where
        F: Fn(Value, String, JsonRpcId) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = AcpResult<Value>> + Send + 'static,
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
            .insert(id, handler);
        Subscription { id }
    }

    pub async fn off_server_request(&self, method: &str, subscription: Subscription) {
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
        F: Fn(AcpError) + Send + Sync + 'static,
    {
        let id = self.inner.next_handler_id.fetch_add(1, Ordering::AcqRel);
        self.inner
            .close_handlers
            .lock()
            .await
            .insert(id, Arc::new(handler));
        Subscription { id }
    }

    pub async fn off_close(&self, subscription: Subscription) {
        self.inner
            .close_handlers
            .lock()
            .await
            .remove(&subscription.id);
    }

    /// Gracefully shuts down the subprocess by closing `stdin` first to allow state
    /// flushing, waiting for clean exit, and escalating to process-group `SIGTERM`
    /// and finally `SIGKILL` if the process does not terminate.
    pub async fn close(&self) {
        self.inner
            .graceful_close_requested
            .store(true, Ordering::Release);
        self.inner.close_stdin().await;

        if self.inner.pid.is_some()
            && !self
                .inner
                .wait_for_child_exit(self.inner.config.graceful_exit_timeout)
                .await
        {
            self.inner.signal_process_group(libc::SIGTERM);
            if !self
                .inner
                .wait_for_child_exit(self.inner.config.term_exit_timeout)
                .await
            {
                self.inner.kill_process_group_once();
                let _ = self
                    .inner
                    .wait_for_child_exit(Duration::from_millis(500))
                    .await;
            }
        }
        let exit_code = *self.inner.exit_code.lock().expect("exit code lock");
        self.inner.mark_closed(exit_code, None).await;
    }

    async fn respond_result(&self, id: JsonRpcId, result: Value) -> AcpResult<()> {
        self.inner
            .write_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            }))
            .await
    }

    async fn respond_error(
        &self,
        id: JsonRpcId,
        code: i64,
        message: String,
        data: Option<Value>,
    ) -> AcpResult<()> {
        let mut error = json!({ "code": code, "message": message });
        if let Some(data) = data {
            error["data"] = data;
        }
        self.inner
            .write_json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": error,
            }))
            .await
    }
}

impl TransportInner {
    async fn close_stdin(&self) {
        let writer = self.writer.lock().await.take();
        if let Some(mut writer) = writer {
            let _ = writer.flush().await;
            let _ = writer.shutdown().await;
            drop(writer);
        }
    }

    async fn write_json(&self, value: &Value) -> AcpResult<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(self.closed_error());
        }
        let mut line =
            serde_json::to_vec(value).map_err(|error| AcpError::Transport(error.to_string()))?;
        line.push(b'\n');

        let result = {
            let mut guard = self.writer.lock().await;
            let Some(writer) = guard.as_mut() else {
                return Err(self.closed_error());
            };
            match writer.write_all(&line).await {
                Ok(()) => writer.flush().await,
                Err(error) => Err(error),
            }
        };
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let transport_error = AcpError::Transport(error.to_string());
                self.mark_closed(None, Some(transport_error.clone())).await;
                Err(transport_error)
            }
        }
    }

    fn record_child_exit(&self, exit_code: Option<i32>) {
        *self.exit_code.lock().expect("exit code lock") = exit_code;
        self.child_exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
    }

    async fn wait_for_child_exit(&self, timeout: Duration) -> bool {
        if self.child_exited.load(Ordering::Acquire) {
            return true;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        while !self.child_exited.load(Ordering::Acquire) {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let remaining = (deadline - now).min(Duration::from_millis(25));
            let notified = self.exit_notify.notified();
            let _ = tokio::time::timeout(remaining, notified).await;
        }
        true
    }

    fn signal_process_group(&self, signal: i32) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.and_then(|pid| i32::try_from(pid).ok()) {
            unsafe {
                libc::kill(-pid, signal);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
        }
    }

    fn kill_process_group_once(&self) {
        if self.group_killed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.signal_process_group(libc::SIGKILL);
    }

    fn stderr_tail_string(&self) -> Option<String> {
        let guard = self.stderr_tail.lock().expect("stderr tail lock");
        if guard.is_empty() {
            None
        } else {
            Some(guard.iter().cloned().collect::<Vec<_>>().join("\n"))
        }
    }

    async fn fail_with_malformed_frame(&self, line: &str, reason: impl Into<String>) {
        let error = AcpError::MalformedFrame {
            line: truncate_for_error(line),
            reason: reason.into(),
        };
        // Record the structured error and fail pending callers BEFORE tearing down
        // the subprocess so child exit cannot race and mask the MalformedFrame error.
        self.mark_closed(None, Some(error)).await;
        self.close_stdin().await;
        if self.pid.is_some() && !self.child_exited.load(Ordering::Acquire) {
            self.signal_process_group(libc::SIGTERM);
            if !self.wait_for_child_exit(Duration::from_millis(200)).await {
                self.kill_process_group_once();
            }
        }
    }

    async fn mark_closed(&self, exit_code: Option<i32>, explicit_error: Option<AcpError>) {
        if let Some(code) = exit_code {
            *self.exit_code.lock().expect("exit code lock") = Some(code);
        }
        if let Some(error) = explicit_error.as_ref() {
            let mut fatal = self.fatal_error.lock().expect("fatal error lock");
            if fatal.is_none() {
                *fatal = Some(error.clone());
            }
        }
        self.closed.store(true, Ordering::Release);
        self.closed_notify.notify_waiters();
        if self.close_reported.swap(true, Ordering::AcqRel) {
            return;
        }
        let close_error = explicit_error.unwrap_or_else(|| self.closed_error());
        let mut pending = self.pending.lock().await;
        for (_, request) in pending.drain() {
            let _ = request.sender.send(Err(close_error.clone()));
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
            handler(close_error.clone());
        }
    }

    fn closed_error(&self) -> AcpError {
        if let Some(error) = self.fatal_error.lock().expect("fatal error lock").clone() {
            return error;
        }
        AcpError::Closed {
            exit_code: *self.exit_code.lock().expect("exit code lock"),
            graceful: self.graceful_close_requested.load(Ordering::Acquire),
            stderr_tail: self.stderr_tail_string(),
        }
    }
}

async fn read_stdout<R>(inner: Weak<TransportInner>, reader: R)
where
    R: AsyncRead + Send + Unpin + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                if let Some(inner) = inner.upgrade() {
                    inner
                        .mark_closed(None, Some(AcpError::Transport(error.to_string())))
                        .await;
                }
                return;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(inner) = inner.upgrade() else {
            return;
        };
        if !dispatch_line(&inner, &line).await {
            return;
        }
    }
    if let Some(inner) = inner.upgrade() {
        // Give the child wait task a brief chance to record exit_code on process crash.
        if inner.pid.is_some() && !inner.child_exited.load(Ordering::Acquire) {
            let _ = inner.wait_for_child_exit(Duration::from_millis(100)).await;
        }
        let exit_code = *inner.exit_code.lock().expect("exit code lock");
        inner.mark_closed(exit_code, None).await;
    }
}

/// Returns `false` if the frame was malformed and the transport has been terminated.
async fn dispatch_line(inner: &Arc<TransportInner>, line: &str) -> bool {
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => value,
        Err(error) => {
            inner
                .fail_with_malformed_frame(line, format!("invalid JSON: {error}"))
                .await;
            return false;
        }
    };
    let Some(object) = value.as_object() else {
        inner
            .fail_with_malformed_frame(line, "JSON-RPC frame must be a JSON object")
            .await;
        return false;
    };

    if let Some(method_value) = object.get("method") {
        let Some(method) = method_value.as_str() else {
            inner
                .fail_with_malformed_frame(line, "\"method\" must be a string")
                .await;
            return false;
        };
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id_value) = object.get("id") {
            let Some(id) = parse_server_request_id(id_value) else {
                inner
                    .fail_with_malformed_frame(line, "invalid JSON-RPC request \"id\"")
                    .await;
                return false;
            };
            dispatch_server_request(inner, id, method.to_string(), params);
        } else {
            dispatch_notification(inner, method.to_string(), params).await;
        }
        return true;
    }

    if let Some(id_value) = object.get("id") {
        if !object.contains_key("result") && !object.contains_key("error") {
            inner
                .fail_with_malformed_frame(
                    line,
                    "JSON-RPC response must include \"result\" or \"error\"",
                )
                .await;
            return false;
        }
        let Some(id) = parse_response_id(id_value) else {
            inner
                .fail_with_malformed_frame(line, "invalid JSON-RPC response \"id\"")
                .await;
            return false;
        };
        dispatch_response(inner, id, object).await;
        return true;
    }

    inner
        .fail_with_malformed_frame(line, "JSON-RPC frame missing both \"method\" and \"id\"")
        .await;
    false
}

fn parse_response_id(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    }
}

fn parse_server_request_id(value: &Value) -> Option<JsonRpcId> {
    match value {
        Value::Number(number) => number.as_u64().map(JsonRpcId::Number),
        Value::String(text) => Some(JsonRpcId::String(text.clone())),
        _ => None,
    }
}

async fn dispatch_response(
    inner: &Arc<TransportInner>,
    id: u64,
    object: &serde_json::Map<String, Value>,
) {
    let Some(request) = inner.pending.lock().await.remove(&id) else {
        return;
    };
    let result = if let Some(error) = object.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("ACP request failed")
            .to_string();
        Err(AcpError::rpc(
            request.method,
            code,
            message,
            error.get("data").cloned(),
        ))
    } else {
        Ok(object.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = request.sender.send(result);
}

async fn dispatch_notification(inner: &Arc<TransportInner>, method: String, params: Value) {
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

fn dispatch_server_request(
    inner: &Arc<TransportInner>,
    id: JsonRpcId,
    method: String,
    params: Value,
) {
    let transport = AcpTransport {
        id: String::new(),
        inner: Arc::clone(inner),
    };
    tokio::spawn(async move {
        let handler = {
            let handlers = transport.inner.server_request_handlers.lock().await;
            handlers
                .get(&method)
                .and_then(|entries| entries.values().next().cloned())
        };
        let Some(handler) = handler else {
            let _ = transport
                .respond_error(
                    id,
                    -32601,
                    format!("Unsupported ACP client request: {method}"),
                    None,
                )
                .await;
            return;
        };
        match handler(params, method, id.clone()).await {
            Ok(result) => {
                let _ = transport.respond_result(id, result).await;
            }
            Err(error) => {
                let _ = transport
                    .respond_error(id, -32603, error.to_string(), None)
                    .await;
            }
        }
    });
}

fn drain_stderr(inner: Weak<TransportInner>, stderr: ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Some(inner) = inner.upgrade() else {
                return;
            };
            let mut tail = inner.stderr_tail.lock().expect("stderr tail lock");
            if tail.len() >= MAX_STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

fn truncate_for_error(line: &str) -> String {
    if line.chars().count() <= MAX_MALFORMED_LINE_LEN {
        line.to_string()
    } else {
        let prefix: String = line.chars().take(MAX_MALFORMED_LINE_LEN).collect();
        format!("{prefix}...")
    }
}
