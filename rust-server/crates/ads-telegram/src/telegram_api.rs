use std::time::Duration;

use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{ConnectorError, ConnectorResult};

pub const DEFAULT_TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";

#[derive(Debug, Clone)]
pub struct TelegramApiOptions {
    pub token: String,
    pub base_url: String,
    pub proxy_url: Option<String>,
}

impl TelegramApiOptions {
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            base_url: DEFAULT_TELEGRAM_API_BASE_URL.to_string(),
            proxy_url: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<TelegramMessage>,
    #[serde(default)]
    pub callback_query: Option<TelegramCallbackQuery>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramMessage {
    pub message_id: i64,
    #[serde(default)]
    pub text: Option<String>,
    pub chat: TelegramChat,
    #[serde(default)]
    pub from: Option<TelegramUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChat {
    pub id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramCallbackQuery {
    pub id: String,
    #[serde(default)]
    pub data: Option<String>,
    pub from: TelegramUser,
    #[serde(default)]
    pub message: Option<TelegramMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelegramBotCommand {
    pub command: String,
    pub description: String,
}

#[derive(Clone)]
pub struct TelegramApi {
    token: String,
    base_url: String,
    client: Client,
}

impl TelegramApi {
    pub fn new(options: TelegramApiOptions) -> ConnectorResult<Self> {
        let mut builder = Client::builder().timeout(Duration::from_secs(65));
        if let Some(proxy_url) = options.proxy_url.as_deref() {
            let proxy = Proxy::all(proxy_url)?;
            builder = builder.proxy(proxy);
        }
        Ok(Self {
            token: options.token,
            base_url: options.base_url.trim_end_matches('/').to_string(),
            client: builder.build()?,
        })
    }

    pub async fn get_updates(
        &self,
        offset: Option<i64>,
        timeout_seconds: u64,
    ) -> ConnectorResult<Vec<TelegramUpdate>> {
        let mut payload = Map::new();
        payload.insert("timeout".to_string(), json!(timeout_seconds));
        payload.insert(
            "allowed_updates".to_string(),
            json!(["message", "callback_query"]),
        );
        if let Some(offset) = offset {
            payload.insert("offset".to_string(), json!(offset));
        }
        let result = self.call("getUpdates", Value::Object(payload)).await?;
        serde_json::from_value(result).map_err(ConnectorError::Json)
    }

    pub async fn send_message(
        &self,
        chat_id: &str,
        text: &str,
        parse_mode: Option<&str>,
        disable_notification: bool,
        reply_markup: Option<Value>,
    ) -> ConnectorResult<i64> {
        let mut payload = Map::from_iter([
            ("chat_id".to_string(), json!(chat_id)),
            ("text".to_string(), json!(text)),
            (
                "disable_notification".to_string(),
                json!(disable_notification),
            ),
        ]);
        if let Some(parse_mode) = parse_mode {
            payload.insert("parse_mode".to_string(), json!(parse_mode));
        }
        if let Some(reply_markup) = reply_markup {
            payload.insert("reply_markup".to_string(), reply_markup);
        }
        let result = self.call("sendMessage", Value::Object(payload)).await?;
        result
            .get("message_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ConnectorError::Telegram("sendMessage returned no message_id".to_string())
            })
    }

    pub async fn edit_message_text(
        &self,
        chat_id: &str,
        message_id: i64,
        text: &str,
        parse_mode: Option<&str>,
        reply_markup: Option<Value>,
    ) -> ConnectorResult<()> {
        let mut payload = Map::from_iter([
            ("chat_id".to_string(), json!(chat_id)),
            ("message_id".to_string(), json!(message_id)),
            ("text".to_string(), json!(text)),
        ]);
        if let Some(parse_mode) = parse_mode {
            payload.insert("parse_mode".to_string(), json!(parse_mode));
        }
        if let Some(reply_markup) = reply_markup {
            payload.insert("reply_markup".to_string(), reply_markup);
        }
        self.call("editMessageText", Value::Object(payload)).await?;
        Ok(())
    }

    pub async fn delete_message(&self, chat_id: &str, message_id: i64) -> ConnectorResult<()> {
        self.call(
            "deleteMessage",
            json!({ "chat_id": chat_id, "message_id": message_id }),
        )
        .await?;
        Ok(())
    }

    pub async fn send_chat_action(&self, chat_id: &str, action: &str) -> ConnectorResult<()> {
        self.call(
            "sendChatAction",
            json!({ "chat_id": chat_id, "action": action }),
        )
        .await?;
        Ok(())
    }

    pub async fn set_my_commands(&self, commands: &[TelegramBotCommand]) -> ConnectorResult<()> {
        self.call("setMyCommands", json!({ "commands": commands }))
            .await?;
        Ok(())
    }

    pub async fn answer_callback_query(
        &self,
        callback_query_id: &str,
        text: &str,
        show_alert: bool,
    ) -> ConnectorResult<()> {
        self.call(
            "answerCallbackQuery",
            json!({
                "callback_query_id": callback_query_id,
                "text": text,
                "show_alert": show_alert,
            }),
        )
        .await?;
        Ok(())
    }

    async fn call(&self, method: &str, payload: Value) -> ConnectorResult<Value> {
        let url = format!("{}/bot{}/{method}", self.base_url, self.token);
        let response = self.client.post(url).json(&payload).send().await?;
        let status = response.status();
        let body = response.json::<Value>().await?;
        if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
            let description = body
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("Telegram Bot API request failed");
            return Err(ConnectorError::Telegram(format!(
                "{method}: {description} ({status})"
            )));
        }
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_base_url_is_telegram() {
        assert_eq!(
            TelegramApiOptions::new("token").base_url,
            DEFAULT_TELEGRAM_API_BASE_URL
        );
    }
}
