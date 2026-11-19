use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Notify, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use uuid::Uuid;

use crate::config::{DEFAULT_PROMPT_IDLE_TIMEOUT_MS, DEFAULT_PROMPT_MAX_DURATION_MS};
use crate::error::{ConnectorError, ConnectorResult};

pub const DEFAULT_RECONNECT_INTERVAL_MS: u64 = 5_000;

pub type AdsEvent = Value;
type CoreSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type CoreSink = SplitSink<CoreSocket, Message>;

#[derive(Clone)]
pub struct AdsCoreClientOptions {
    pub core_url: String,
    pub core_ws_url: String,
    pub token: Option<String>,
    pub session_id: String,
    pub chat_session_id: String,
    pub auto_reconnect: bool,
    pub reconnect_interval: Duration,
    pub prompt_idle_timeout: Duration,
    pub prompt_max_duration: Duration,
    pub on_prompt_idle: Option<Arc<dyn Fn(PromptIdleNotice) + Send + Sync>>,
}

impl AdsCoreClientOptions {
    pub fn new(core_url: impl Into<String>, core_ws_url: impl Into<String>) -> Self {
        Self {
            core_url: core_url.into(),
            core_ws_url: core_ws_url.into(),
            token: None,
            session_id: "telegram".to_string(),
            chat_session_id: "main".to_string(),
            auto_reconnect: true,
            reconnect_interval: Duration::from_millis(DEFAULT_RECONNECT_INTERVAL_MS),
            prompt_idle_timeout: Duration::from_millis(DEFAULT_PROMPT_IDLE_TIMEOUT_MS),
            prompt_max_duration: Duration::from_millis(DEFAULT_PROMPT_MAX_DURATION_MS),
            on_prompt_idle: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptIdleNotice {
    pub client_message_id: String,
    pub idle_timeout: Duration,
    pub max_duration: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct PromptTurnOptions {
    pub text: String,
    pub images: Vec<Value>,
    pub channel: String,
    pub metadata: Map<String, Value>,
    pub client_message_id: Option<String>,
    pub idle_timeout: Option<Duration>,
    pub max_duration: Option<Duration>,
}

pub struct PromptStart {
    pub client_message_id: String,
    response: oneshot::Receiver<Result<String, String>>,
}

impl PromptStart {
    pub async fn wait(self) -> ConnectorResult<String> {
        self.response
            .await
            .map_err(|_| ConnectorError::Core("Prompt response channel closed".to_string()))?
            .map_err(ConnectorError::Core)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub model_id: String,
    pub display_name: String,
    pub provider: String,
    pub is_enabled: bool,
    pub is_default: bool,
    pub config_json: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelState {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

struct PendingPrompt {
    response: oneshot::Sender<Result<String, String>>,
    accumulated_text: String,
    idle_notified: bool,
    idle_timeout: Duration,
    max_duration: Duration,
    idle_timer: Option<JoinHandle<()>>,
    max_timer: JoinHandle<()>,
}

struct PendingControl {
    response: oneshot::Sender<Result<ModelState, String>>,
    timer: JoinHandle<()>,
}

type EventListener = Arc<dyn Fn(AdsEvent) + Send + Sync>;

struct CoreInner {
    options: AdsCoreClientOptions,
    write: Mutex<Option<CoreSink>>,
    connect_lock: Mutex<()>,
    closed: AtomicBool,
    welcome_received: AtomicBool,
    welcome_notify: Notify,
    event_listeners: Mutex<Vec<EventListener>>,
    pending_prompts: Mutex<HashMap<String, PendingPrompt>>,
    pending_controls: Mutex<HashMap<String, PendingControl>>,
    model_state: Mutex<ModelState>,
}

#[derive(Clone)]
pub struct AdsCoreClient {
    inner: Arc<CoreInner>,
}

impl AdsCoreClient {
    pub fn new(options: AdsCoreClientOptions) -> Self {
        Self {
            inner: Arc::new(CoreInner {
                options,
                write: Mutex::new(None),
                connect_lock: Mutex::new(()),
                closed: AtomicBool::new(false),
                welcome_received: AtomicBool::new(false),
                welcome_notify: Notify::new(),
                event_listeners: Mutex::new(Vec::new()),
                pending_prompts: Mutex::new(HashMap::new()),
                pending_controls: Mutex::new(HashMap::new()),
                model_state: Mutex::new(ModelState::default()),
            }),
        }
    }

    pub async fn connect(&self) -> ConnectorResult<()> {
        if self.inner.write.lock().await.is_some() {
            return Ok(());
        }
        let _guard = self.inner.connect_lock.lock().await;
        if self.inner.write.lock().await.is_some() {
            return Ok(());
        }
        self.inner.closed.store(false, Ordering::SeqCst);
        self.inner.welcome_received.store(false, Ordering::SeqCst);

        let mut request = self
            .inner
            .options
            .core_ws_url
            .clone()
            .into_client_request()?;
        if let Some(token) = self.inner.options.token.as_deref() {
            request.headers_mut().insert(
                "authorization",
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|error| ConnectorError::Core(error.to_string()))?,
            );
        }
        let protocols = format!(
            "ads-v1, ads-session.{}, ads-chat.{}",
            self.inner.options.session_id, self.inner.options.chat_session_id
        );
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(&protocols)
                .map_err(|error| ConnectorError::Core(error.to_string()))?,
        );

        let (socket, _) = connect_async(request).await?;
        let (write, read) = socket.split();
        *self.inner.write.lock().await = Some(write);
        self.spawn_reader(read);
        Ok(())
    }

    pub async fn send_prompt(&self, options: PromptTurnOptions) -> ConnectorResult<PromptStart> {
        self.ensure_connected().await?;
        let client_message_id = options
            .client_message_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("tg-{}-{}", now_millis(), short_uuid()));
        let max_duration =
            normalize_duration(options.max_duration, self.inner.options.prompt_max_duration);
        let idle_timeout =
            normalize_duration(options.idle_timeout, self.inner.options.prompt_idle_timeout)
                .min(max_duration);
        let (response_tx, response_rx) = oneshot::channel();
        let max_timer = self.spawn_max_duration_timer(client_message_id.clone(), max_duration);
        self.inner.pending_prompts.lock().await.insert(
            client_message_id.clone(),
            PendingPrompt {
                response: response_tx,
                accumulated_text: String::new(),
                idle_notified: false,
                idle_timeout,
                max_duration,
                idle_timer: None,
                max_timer,
            },
        );
        self.arm_idle_timer(&client_message_id).await;

        let message = json!({
            "type": "prompt",
            "client_message_id": client_message_id,
            "payload": {
                "text": options.text,
                "images": options.images,
                "channel": if options.channel.trim().is_empty() { "telegram" } else { &options.channel },
                "metadata": Value::Object(options.metadata),
            }
        });
        if let Err(error) = self.send_json(message).await {
            if let Some(mut pending) = self
                .inner
                .pending_prompts
                .lock()
                .await
                .remove(&client_message_id)
            {
                abort_timers(&mut pending);
                let _ = pending.response.send(Err(error.clone()));
            }
            return Err(ConnectorError::Core(error));
        }
        Ok(PromptStart {
            client_message_id,
            response: response_rx,
        })
    }

    pub async fn send_interrupt(&self) -> ConnectorResult<()> {
        self.send_control("interrupt").await
    }

    pub async fn clear_history(&self) -> ConnectorResult<()> {
        self.send_control("clear_history").await
    }

    pub async fn get_models(&self) -> ConnectorResult<Vec<ModelOption>> {
        let url = format!(
            "{}/api/models",
            self.inner.options.core_url.trim_end_matches('/')
        );
        let mut request = reqwest::Client::new().get(url);
        if let Some(token) = self.inner.options.token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(ConnectorError::Core(format!(
                "Failed to load models ({status})"
            )));
        }
        let payload = response.json::<Value>().await?;
        let values = payload
            .as_array()
            .ok_or_else(|| ConnectorError::Core("Invalid model list from ADS Core".to_string()))?;
        let mut models = Vec::new();
        for value in values.iter().filter_map(Value::as_object) {
            let model_id = string_field(value, "modelId").unwrap_or_default();
            if model_id.is_empty() {
                continue;
            }
            let is_enabled = value
                .get("isEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !is_enabled {
                continue;
            }
            models.push(ModelOption {
                id: string_field(value, "id").unwrap_or_default(),
                display_name: string_field(value, "displayName")
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| model_id.clone()),
                model_id,
                provider: string_field(value, "provider").unwrap_or_default(),
                is_enabled,
                is_default: value
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                config_json: value
                    .get("configJson")
                    .filter(|value| value.is_object())
                    .cloned(),
            });
        }
        Ok(models)
    }

    pub async fn model_state(&self) -> ModelState {
        self.inner.model_state.lock().await.clone()
    }

    pub async fn wait_for_welcome(&self, timeout: Duration) {
        let notified = self.inner.welcome_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.inner.welcome_received.load(Ordering::SeqCst) {
            return;
        }
        let _ = tokio::time::timeout(timeout.max(Duration::from_millis(1)), notified).await;
    }

    pub async fn set_model(
        &self,
        model: &str,
        reasoning_effort: Option<&str>,
    ) -> ConnectorResult<ModelState> {
        self.ensure_connected().await?;
        let client_message_id = format!("tg-model-{}-{}", now_millis(), short_uuid());
        let (response_tx, response_rx) = oneshot::channel();
        let timer_client = self.clone();
        let timer_id = client_message_id.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            if let Some(control) = timer_client
                .inner
                .pending_controls
                .lock()
                .await
                .remove(&timer_id)
            {
                let _ = control
                    .response
                    .send(Err("Model switch timed out".to_string()));
            }
        });
        self.inner.pending_controls.lock().await.insert(
            client_message_id.clone(),
            PendingControl {
                response: response_tx,
                timer,
            },
        );
        let mut payload = json!({ "model": model });
        if let Some(effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
            payload["model_reasoning_effort"] = json!(effort);
        }
        if let Err(error) = self
            .send_json(json!({
                "type": "model_override",
                "client_message_id": client_message_id,
                "payload": payload,
            }))
            .await
        {
            if let Some(control) = self
                .inner
                .pending_controls
                .lock()
                .await
                .remove(&client_message_id)
            {
                control.timer.abort();
                let _ = control.response.send(Err(error.clone()));
            }
            return Err(ConnectorError::Core(error));
        }
        response_rx
            .await
            .map_err(|_| ConnectorError::Core("Model switch response channel closed".to_string()))?
            .map_err(ConnectorError::Core)
    }

    pub async fn on_event<F>(&self, listener: F)
    where
        F: Fn(AdsEvent) + Send + Sync + 'static,
    {
        self.inner
            .event_listeners
            .lock()
            .await
            .push(Arc::new(listener));
    }

    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        if let Some(mut sink) = self.inner.write.lock().await.take() {
            let _ = sink.close().await;
        }
        let mut prompts = self.inner.pending_prompts.lock().await;
        for (_, mut pending) in prompts.drain() {
            abort_timers(&mut pending);
            let _ = pending.response.send(Err("Client closed".to_string()));
        }
        let mut controls = self.inner.pending_controls.lock().await;
        for (_, control) in controls.drain() {
            control.timer.abort();
            let _ = control.response.send(Err("Client closed".to_string()));
        }
    }

    async fn ensure_connected(&self) -> ConnectorResult<()> {
        if self.inner.write.lock().await.is_none() || self.inner.closed.load(Ordering::SeqCst) {
            self.connect().await?;
        }
        Ok(())
    }

    async fn send_control(&self, control_type: &str) -> ConnectorResult<()> {
        self.ensure_connected().await?;
        self.send_json(json!({ "type": control_type }))
            .await
            .map_err(ConnectorError::Core)
    }

    async fn send_json(&self, value: Value) -> Result<(), String> {
        for attempt in 0..2 {
            let mut write = self.inner.write.lock().await;
            let Some(sink) = write.as_mut() else {
                drop(write);
                if attempt == 0 {
                    self.connect().await.map_err(|error| error.to_string())?;
                    continue;
                }
                return Err("ADS Core WebSocket is not connected".to_string());
            };
            match sink.send(Message::Text(value.to_string().into())).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    *write = None;
                    drop(write);
                    if attempt == 0 {
                        self.connect()
                            .await
                            .map_err(|connect_error| connect_error.to_string())?;
                        continue;
                    }
                    return Err(error.to_string());
                }
            }
        }
        Err("ADS Core WebSocket send failed".to_string())
    }

    fn spawn_reader(&self, mut read: SplitStream<CoreSocket>) {
        let client = self.clone();
        tokio::spawn(async move {
            while let Some(message) = read.next().await {
                match message {
                    Ok(Message::Text(text)) => client.handle_incoming(text.as_str()).await,
                    Ok(Message::Binary(bytes)) => {
                        if let Ok(text) = std::str::from_utf8(&bytes) {
                            client.handle_incoming(text).await;
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        if let Some(sink) = client.inner.write.lock().await.as_mut() {
                            let _ = sink.send(Message::Pong(payload)).await;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            *client.inner.write.lock().await = None;
            if !client.inner.closed.load(Ordering::SeqCst) && client.inner.options.auto_reconnect {
                client.schedule_reconnect();
            }
        });
    }

    fn schedule_reconnect(&self) {
        let client = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(client.inner.options.reconnect_interval).await;
                if client.inner.closed.load(Ordering::SeqCst) {
                    break;
                }
                if client.connect().await.is_ok() {
                    break;
                }
            }
        });
    }

    async fn handle_incoming(&self, raw: &str) {
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let listeners = self.inner.event_listeners.lock().await.clone();
        for listener in listeners {
            listener(value.clone());
        }
        let frame_type = string_value(&value, "type").unwrap_or_default();
        let explicit_id = string_value(&value, "clientMessageId")
            .or_else(|| string_value(&value, "client_message_id"));
        let resolved_id = match explicit_id {
            Some(id) => Some(id),
            None => {
                let pending = self.inner.pending_prompts.lock().await;
                (pending.len() == 1)
                    .then(|| pending.keys().next().cloned())
                    .flatten()
            }
        };

        if frame_type == "welcome" {
            *self.inner.model_state.lock().await = ModelState {
                model: string_value(&value, "effectiveModel"),
                reasoning_effort: string_value(&value, "effectiveModelReasoningEffort"),
            };
            self.inner.welcome_received.store(true, Ordering::SeqCst);
            self.inner.welcome_notify.notify_waiters();
        }

        if frame_type == "result"
            && string_value(&value, "kind").as_deref() == Some("model_override")
        {
            let control_id = string_value(&value, "client_message_id")
                .or_else(|| string_value(&value, "clientMessageId"));
            if let Some(control_id) = control_id
                && let Some(control) = self.inner.pending_controls.lock().await.remove(&control_id)
            {
                control.timer.abort();
                if value.get("ok").and_then(Value::as_bool) == Some(false) {
                    let message = string_value(&value, "output")
                        .unwrap_or_else(|| "Model override failed".to_string());
                    let _ = control.response.send(Err(message));
                } else {
                    let state = ModelState {
                        model: string_value(&value, "model"),
                        reasoning_effort: string_value(&value, "model_reasoning_effort")
                            .or_else(|| string_value(&value, "modelReasoningEffort")),
                    };
                    *self.inner.model_state.lock().await = state.clone();
                    let _ = control.response.send(Ok(state));
                }
            }
        }

        let Some(client_message_id) = resolved_id else {
            return;
        };
        if !matches!(frame_type.as_str(), "result" | "error") {
            self.arm_idle_timer(&client_message_id).await;
        }

        let mut prompts = self.inner.pending_prompts.lock().await;
        let Some(pending) = prompts.get_mut(&client_message_id) else {
            return;
        };
        match frame_type.as_str() {
            "delta" => {
                if let Some(delta) = string_value(&value, "delta") {
                    pending.accumulated_text.push_str(&delta);
                }
            }
            "result" if string_value(&value, "kind").as_deref() != Some("model_override") => {
                let output = string_value(&value, "output")
                    .unwrap_or_else(|| pending.accumulated_text.clone());
                let mut pending = prompts.remove(&client_message_id).expect("pending prompt");
                abort_timers(&mut pending);
                let _ = pending.response.send(Ok(output));
            }
            "error" => {
                let message = string_value(&value, "message")
                    .or_else(|| string_value(&value, "error"))
                    .unwrap_or_else(|| "ADS Core prompt failed".to_string());
                let mut pending = prompts.remove(&client_message_id).expect("pending prompt");
                abort_timers(&mut pending);
                let _ = pending.response.send(Err(message));
            }
            _ => {}
        }
    }

    async fn arm_idle_timer(&self, client_message_id: &str) {
        let idle_timeout = {
            let mut prompts = self.inner.pending_prompts.lock().await;
            let Some(pending) = prompts.get_mut(client_message_id) else {
                return;
            };
            if let Some(timer) = pending.idle_timer.take() {
                timer.abort();
            }
            pending.idle_timeout
        };
        let client = self.clone();
        let id = client_message_id.to_string();
        let idle_timer = tokio::spawn(async move {
            tokio::time::sleep(idle_timeout).await;
            let notice = {
                let mut prompts = client.inner.pending_prompts.lock().await;
                let Some(pending) = prompts.get_mut(&id) else {
                    return;
                };
                if pending.idle_notified {
                    return;
                }
                pending.idle_notified = true;
                PromptIdleNotice {
                    client_message_id: id.clone(),
                    idle_timeout: pending.idle_timeout,
                    max_duration: pending.max_duration,
                }
            };
            if let Some(callback) = client.inner.options.on_prompt_idle.as_ref() {
                callback(notice);
            }
        });
        if let Some(pending) = self
            .inner
            .pending_prompts
            .lock()
            .await
            .get_mut(client_message_id)
        {
            pending.idle_timer = Some(idle_timer);
        }
    }

    fn spawn_max_duration_timer(
        &self,
        client_message_id: String,
        duration: Duration,
    ) -> JoinHandle<()> {
        let client = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(duration).await;
            if let Some(mut pending) = client
                .inner
                .pending_prompts
                .lock()
                .await
                .remove(&client_message_id)
            {
                if let Some(timer) = pending.idle_timer.take() {
                    timer.abort();
                }
                let _ = pending.response.send(Err(format!(
                    "Prompt exceeded maximum duration after {}ms",
                    duration.as_millis()
                )));
            }
        })
    }
}

fn abort_timers(pending: &mut PendingPrompt) {
    if let Some(timer) = pending.idle_timer.take() {
        timer.abort();
    }
    pending.max_timer.abort();
}

fn normalize_duration(value: Option<Duration>, fallback: Duration) -> Duration {
    value
        .filter(|duration| !duration.is_zero())
        .unwrap_or(fallback)
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_field(value: &Map<String, Value>, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..7].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_prompt_durations() {
        assert_eq!(
            normalize_duration(Some(Duration::ZERO), Duration::from_secs(3)),
            Duration::from_secs(3)
        );
    }
}
