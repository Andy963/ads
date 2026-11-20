use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::config::{TelegramConnectorConfig, validate_connector_config};
use crate::core_client::{
    AdsCoreClient, AdsCoreClientOptions, PromptIdleNotice, PromptTurnOptions,
};
use crate::error::{ConnectorError, ConnectorResult};
use crate::markdown::{chunk_message, escape_telegram_markdown_v2};
use crate::model_commands::{
    allowed_reasoning_efforts, build_model_keyboard, find_model, format_model_menu,
    format_model_status, parse_model_callback, parse_model_command,
};
use crate::prompt_status::{PromptStatusOptions, PromptStatusReporter, PromptStatusTarget};
use crate::rate_limit::InMemoryRateLimiter;
use crate::telegram_api::{
    TelegramApi, TelegramApiOptions, TelegramBotCommand, TelegramCallbackQuery, TelegramMessage,
    TelegramUpdate,
};

pub type CoreClientFactory = Arc<dyn Fn(AdsCoreClientOptions) -> AdsCoreClient + Send + Sync>;

#[derive(Clone)]
pub struct TelegramBotOptions {
    pub config: TelegramConnectorConfig,
    pub api: Option<TelegramApi>,
    pub notification_client: Option<Arc<AdsCoreClient>>,
    pub client_factory: Option<CoreClientFactory>,
}

impl TelegramBotOptions {
    pub fn new(config: TelegramConnectorConfig) -> Self {
        Self {
            config,
            api: None,
            notification_client: None,
            client_factory: None,
        }
    }
}

pub struct TelegramBot {
    config: TelegramConnectorConfig,
    api: TelegramApi,
    notification_client: Arc<AdsCoreClient>,
    client_factory: CoreClientFactory,
    chat_clients: StdMutex<HashMap<String, Arc<AdsCoreClient>>>,
    rate_limiter: StdMutex<InMemoryRateLimiter>,
}

impl TelegramBot {
    pub fn new(options: TelegramBotOptions) -> ConnectorResult<Self> {
        validate_connector_config(&options.config)?;
        let api = match options.api {
            Some(api) => api,
            None => TelegramApi::new(TelegramApiOptions {
                token: options.config.bot_token.clone(),
                base_url: crate::telegram_api::DEFAULT_TELEGRAM_API_BASE_URL.to_string(),
                proxy_url: options.config.proxy_url.clone(),
            })?,
        };
        let notification_options = AdsCoreClientOptions {
            core_url: options.config.core_url.clone(),
            core_ws_url: options.config.core_ws_url.clone(),
            token: options.config.connector_token.clone(),
            session_id: "telegram-notifications".to_string(),
            chat_session_id: "notifications".to_string(),
            auto_reconnect: true,
            reconnect_interval: Duration::from_secs(5),
            prompt_idle_timeout: Duration::from_millis(options.config.prompt_idle_timeout_ms),
            prompt_max_duration: Duration::from_millis(options.config.prompt_max_duration_ms),
            on_prompt_idle: None,
        };
        let notification_client = options
            .notification_client
            .unwrap_or_else(|| Arc::new(AdsCoreClient::new(notification_options)));
        let client_factory = options
            .client_factory
            .unwrap_or_else(|| Arc::new(AdsCoreClient::new));
        Ok(Self {
            rate_limiter: StdMutex::new(InMemoryRateLimiter::new(
                options.config.max_requests_per_minute.max(1) as u32,
                Duration::from_secs(60),
                Duration::from_secs(60),
            )),
            config: options.config,
            api,
            notification_client,
            client_factory,
            chat_clients: StdMutex::new(HashMap::new()),
        })
    }

    pub async fn run(self: Arc<Self>) -> ConnectorResult<()> {
        eprintln!("[telegram-connector] starting Rust connector");
        self.notification_client
            .on_event({
                let api = self.api.clone();
                let config = self.config.clone();
                move |event| {
                    if event.get("type").and_then(Value::as_str) != Some("task_terminal") {
                        return;
                    }
                    let task_event = event
                        .get("event")
                        .filter(|value| value.is_object())
                        .unwrap_or(&event);
                    let chat_id = task_event
                        .get("telegramChatId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| config.notification_chat_id.clone())
                        .unwrap_or_default();
                    if chat_id.is_empty() {
                        return;
                    }
                    let status = task_event
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let title = task_event
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| task_event.get("taskId").and_then(Value::as_str))
                        .unwrap_or("Task")
                        .to_string();
                    let detail = task_event
                        .get("error")
                        .and_then(Value::as_str)
                        .map(|error| format!("\nError: {error}"))
                        .unwrap_or_default();
                    let api = api.clone();
                    let silent = config.silent_notifications;
                    tokio::spawn(async move {
                        let _ = api
                            .send_message(
                                &chat_id,
                                &format!("ADS task {status}: {title}{detail}"),
                                None,
                                silent,
                                None,
                            )
                            .await;
                    });
                }
            })
            .await;

        if let Err(error) = self.notification_client.connect().await {
            eprintln!("[telegram-connector] Could not connect to ADS Core on startup: {error}");
        }
        if let Err(error) = self.register_commands().await {
            eprintln!("[telegram-connector] Could not register bot commands: {error}");
        }

        let mut offset = None;
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                updates = self.api.get_updates(offset, 30) => {
                    match updates {
                        Ok(updates) => {
                            for update in updates {
                                offset = Some(update.update_id.saturating_add(1));
                                if let Err(error) = self.handle_update(update).await {
                                    eprintln!("[telegram-connector] update failed: {error}");
                                }
                            }
                        }
                        Err(error) => {
                            eprintln!("[telegram-connector] getUpdates failed: {error}");
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    }
                }
            }
        }
        self.close().await;
        Ok(())
    }

    pub async fn handle_update(&self, update: TelegramUpdate) -> ConnectorResult<()> {
        if let Some(message) = update.message {
            return self.handle_message(message).await;
        }
        if let Some(callback) = update.callback_query {
            return self.handle_callback(callback).await;
        }
        Ok(())
    }

    async fn handle_message(&self, message: TelegramMessage) -> ConnectorResult<()> {
        let Some(user_id) = message.from.as_ref().map(|from| from.id) else {
            return Ok(());
        };
        if !self.authorize(user_id, message.chat.id).await? {
            return Ok(());
        }
        let Some(text) = message.text.as_deref().map(str::trim) else {
            return Ok(());
        };
        if text.is_empty() {
            return Ok(());
        }
        let chat_id = message.chat.id;
        if let Some((command, arguments)) = parse_command(text) {
            return self.handle_command(chat_id, command, arguments).await;
        }
        let bot = Arc::new(TelegramBotHandle {
            api: self.api.clone(),
            chat_client: self.chat_client(message.chat.id),
            silent_notifications: self.config.silent_notifications,
        });
        let text = text.to_string();
        tokio::spawn(async move {
            bot.run_prompt(message.chat.id, user_id, text).await;
        });
        Ok(())
    }

    async fn handle_callback(&self, callback: TelegramCallbackQuery) -> ConnectorResult<()> {
        let Some(chat) = callback.message.as_ref().map(|message| message.chat.id) else {
            return self
                .api
                .answer_callback_query(&callback.id, "This selection is not tied to a chat", true)
                .await;
        };
        if !self.authorize(callback.from.id, chat).await? {
            return Ok(());
        }
        let data = callback.data.as_deref().unwrap_or_default();
        let Some(model_id) = parse_model_callback(data) else {
            return self
                .api
                .answer_callback_query(&callback.id, "Invalid model selection", true)
                .await;
        };
        let client = self.chat_client(chat);
        let models = match client.get_models().await {
            Ok(models) => models,
            Err(error) => {
                return self
                    .api
                    .answer_callback_query(&callback.id, &error.to_string(), true)
                    .await;
            }
        };
        let Some(model) = find_model(&models, &model_id) else {
            return self
                .api
                .answer_callback_query(&callback.id, "Unknown or disabled model", true)
                .await;
        };
        match client.set_model(&model.model_id, None).await {
            Ok(next) => {
                let label = next.model.clone().unwrap_or_else(|| model.model_id.clone());
                self.api
                    .answer_callback_query(&callback.id, &format!("Switched to {label}"), false)
                    .await?;
                if let Some(message) = callback.message.as_ref() {
                    let _ = self
                        .api
                        .edit_message_text(
                            &chat.to_string(),
                            message.message_id,
                            &format_model_menu(&models, &next),
                            None,
                            Some(build_model_keyboard(&models, next.model.as_deref())),
                        )
                        .await;
                }
            }
            Err(error) => {
                self.api
                    .answer_callback_query(&callback.id, &truncate(&error.to_string(), 190), true)
                    .await?;
            }
        }
        Ok(())
    }

    async fn handle_command(
        &self,
        chat_id: i64,
        command: &str,
        arguments: &str,
    ) -> ConnectorResult<()> {
        let chat_key = chat_id.to_string();
        match command {
            "start" => {
                self.reply(
                    &chat_key,
                    "ADS Telegram Connector connected.\nSend prompts directly or use /new to clear session history.",
                )
                .await?;
            }
            "new" => {
                self.chat_client(chat_id).clear_history().await?;
                self.reply(&chat_key, "Session reset. Ready for a new topic.")
                    .await?;
            }
            "stop" => {
                self.chat_client(chat_id).send_interrupt().await?;
                self.reply(&chat_key, "Interrupted running turn.").await?;
            }
            "model" => self.handle_model_command(chat_id, arguments).await?,
            "status" => {
                let client = self.chat_client(chat_id);
                match client.connect().await {
                    Ok(()) => {
                        client.wait_for_welcome(Duration::from_secs(1)).await;
                        self.reply(&chat_key, &format_model_status(&client.model_state().await))
                            .await?;
                    }
                    Err(error) => {
                        self.reply(&chat_key, &format!("Unable to read status: {error}"))
                            .await?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_model_command(&self, chat_id: i64, arguments: &str) -> ConnectorResult<()> {
        let chat_key = chat_id.to_string();
        let client = self.chat_client(chat_id);
        if let Err(error) = client.connect().await {
            self.reply(&chat_key, &format!("Unable to switch model: {error}"))
                .await?;
            return Ok(());
        }
        client.wait_for_welcome(Duration::from_secs(1)).await;
        let models = match client.get_models().await {
            Ok(models) => models,
            Err(error) => {
                self.reply(&chat_key, &format!("Unable to switch model: {error}"))
                    .await?;
                return Ok(());
            }
        };
        let state = client.model_state().await;
        let parsed = parse_model_command(arguments);
        let Some(model_id) = parsed.model_id else {
            self.api
                .send_message(
                    &chat_key,
                    &format_model_menu(&models, &state),
                    None,
                    self.config.silent_notifications,
                    Some(build_model_keyboard(&models, state.model.as_deref())),
                )
                .await?;
            return Ok(());
        };
        let Some(model) = find_model(&models, &model_id) else {
            self.reply(&chat_key, &format!("Unknown or disabled model: {model_id}"))
                .await?;
            return Ok(());
        };
        if let Some(effort) = parsed.reasoning_effort.as_deref()
            && !allowed_reasoning_efforts(&model)
                .iter()
                .any(|value| value == effort)
        {
            self.reply(
                &chat_key,
                &format!("Invalid reasoning effort for {}: {effort}", model.model_id),
            )
            .await?;
            return Ok(());
        }
        match client
            .set_model(&model.model_id, parsed.reasoning_effort.as_deref())
            .await
        {
            Ok(next) => {
                let effort = next
                    .reasoning_effort
                    .as_deref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default();
                self.reply(
                    &chat_key,
                    &format!(
                        "Model switched to {}{effort}.",
                        next.model.as_deref().unwrap_or(&model.model_id)
                    ),
                )
                .await?;
            }
            Err(error) => {
                self.reply(&chat_key, &format!("Unable to switch model: {error}"))
                    .await?;
            }
        }
        Ok(())
    }

    async fn authorize(&self, user_id: i64, chat_id: i64) -> ConnectorResult<bool> {
        if !self.config.allowed_users.contains(&user_id) {
            let _ = self
                .api
                .send_message(
                    &chat_id.to_string(),
                    "You are not authorized to use this bot",
                    None,
                    true,
                    None,
                )
                .await;
            return Ok(false);
        }
        let allowed = self
            .rate_limiter
            .lock()
            .map_err(|_| ConnectorError::Config("rate limiter lock poisoned".to_string()))?
            .consume(user_id, std::time::Instant::now())
            .allowed;
        if !allowed {
            let _ = self
                .api
                .send_message(
                    &chat_id.to_string(),
                    "Too many requests. Please try again later.",
                    None,
                    true,
                    None,
                )
                .await;
        }
        Ok(allowed)
    }

    async fn reply(&self, chat_id: &str, text: &str) -> ConnectorResult<()> {
        self.api
            .send_message(chat_id, text, None, self.config.silent_notifications, None)
            .await?;
        Ok(())
    }

    fn chat_client(&self, chat_id: i64) -> Arc<AdsCoreClient> {
        let key = chat_id.to_string();
        let mut clients = self.chat_clients.lock().expect("chat client lock");
        if let Some(client) = clients.get(&key) {
            return Arc::clone(client);
        }
        let api = self.api.clone();
        let silent = self.config.silent_notifications;
        let idle_chat_id = key.clone();
        let options = AdsCoreClientOptions {
            core_url: self.config.core_url.clone(),
            core_ws_url: self.config.core_ws_url.clone(),
            token: self.config.connector_token.clone(),
            session_id: "telegram".to_string(),
            chat_session_id: format!("chat-{key}"),
            auto_reconnect: true,
            reconnect_interval: Duration::from_secs(5),
            prompt_idle_timeout: Duration::from_millis(self.config.prompt_idle_timeout_ms),
            prompt_max_duration: Duration::from_millis(self.config.prompt_max_duration_ms),
            on_prompt_idle: Some(Arc::new(move |_notice: PromptIdleNotice| {
                let api = api.clone();
                let chat_id = idle_chat_id.clone();
                tokio::spawn(async move {
                    let _ = api
                        .send_message(
                            &chat_id,
                            "Still working on this request. I will send the result when it finishes.",
                            None,
                            silent,
                            None,
                        )
                        .await;
                });
            })),
        };
        let client = Arc::new((self.client_factory)(options));
        clients.insert(key, Arc::clone(&client));
        client
    }

    async fn register_commands(&self) -> ConnectorResult<()> {
        self.api
            .set_my_commands(&[
                TelegramBotCommand {
                    command: "start".to_string(),
                    description: "Connect to ADS".to_string(),
                },
                TelegramBotCommand {
                    command: "model".to_string(),
                    description: "Select the active model".to_string(),
                },
                TelegramBotCommand {
                    command: "status".to_string(),
                    description: "Show model status".to_string(),
                },
                TelegramBotCommand {
                    command: "new".to_string(),
                    description: "Clear session history".to_string(),
                },
                TelegramBotCommand {
                    command: "stop".to_string(),
                    description: "Interrupt the current turn".to_string(),
                },
            ])
            .await
    }

    pub async fn close(&self) {
        self.notification_client.close().await;
        let clients = self
            .chat_clients
            .lock()
            .map(|clients| clients.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for client in clients {
            client.close().await;
        }
    }
}

struct TelegramBotHandle {
    api: TelegramApi,
    chat_client: Arc<AdsCoreClient>,
    silent_notifications: bool,
}

impl TelegramBotHandle {
    async fn run_prompt(&self, chat_id: i64, user_id: i64, text: String) {
        let target = Arc::new(ChatStatusTarget {
            api: self.api.clone(),
            chat_id: chat_id.to_string(),
            silent_notifications: self.silent_notifications,
        });
        let status = PromptStatusReporter::new(Arc::clone(&target), PromptStatusOptions::default());
        status.start().await;
        let result = async {
            let prompt = self
                .chat_client
                .send_prompt(PromptTurnOptions {
                    text,
                    channel: "telegram".to_string(),
                    metadata: Map::from_iter([
                        ("telegramChatId".to_string(), json!(chat_id.to_string())),
                        ("telegramUserId".to_string(), json!(user_id)),
                    ]),
                    ..PromptTurnOptions::default()
                })
                .await?;
            prompt.wait().await
        }
        .await;
        match result {
            Ok(response) => {
                status.complete().await;
                self.send_response(chat_id, &response).await;
            }
            Err(error) => {
                status.fail().await;
                let _ = self
                    .api
                    .send_message(
                        &chat_id.to_string(),
                        &format!("Error executing prompt: {error}"),
                        None,
                        self.silent_notifications,
                        None,
                    )
                    .await;
            }
        }
        status.stop().await;
    }

    async fn send_response(&self, chat_id: i64, response: &str) {
        let markdown = escape_telegram_markdown_v2(response);
        for chunk in chunk_message(&markdown, 3900) {
            if self
                .api
                .send_message(
                    &chat_id.to_string(),
                    &chunk,
                    Some("MarkdownV2"),
                    self.silent_notifications,
                    None,
                )
                .await
                .is_err()
            {
                let _ = self
                    .api
                    .send_message(
                        &chat_id.to_string(),
                        &chunk,
                        None,
                        self.silent_notifications,
                        None,
                    )
                    .await;
            }
        }
    }
}

struct ChatStatusTarget {
    api: TelegramApi,
    chat_id: String,
    silent_notifications: bool,
}

#[async_trait]
impl PromptStatusTarget for ChatStatusTarget {
    async fn send_message(&self, text: String) -> Result<Option<i64>, String> {
        self.api
            .send_message(&self.chat_id, &text, None, self.silent_notifications, None)
            .await
            .map(Some)
            .map_err(|error| error.to_string())
    }

    async fn edit_message(&self, message_id: i64, text: String) -> Result<(), String> {
        self.api
            .edit_message_text(&self.chat_id, message_id, &text, None, None)
            .await
            .map_err(|error| error.to_string())
    }

    async fn delete_message(&self, message_id: i64) -> Result<(), String> {
        self.api
            .delete_message(&self.chat_id, message_id)
            .await
            .map_err(|error| error.to_string())
    }

    async fn send_typing(&self) -> Result<(), String> {
        self.api
            .send_chat_action(&self.chat_id, "typing")
            .await
            .map_err(|error| error.to_string())
    }
}

fn parse_command(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim();
    let command = trimmed.strip_prefix('/')?;
    let end = command.find(char::is_whitespace).unwrap_or(command.len());
    let name = command[..end].split('@').next().unwrap_or_default();
    let arguments = command[end..].trim();
    Some((name, arguments))
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bot_commands_with_optional_mentions() {
        assert_eq!(
            parse_command("/model@ads_bot gpt-test high"),
            Some(("model", "gpt-test high"))
        );
        assert_eq!(parse_command("plain text"), None);
    }
}
