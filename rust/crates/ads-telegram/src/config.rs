use std::collections::HashMap;

use url::Url;

use crate::error::{ConnectorError, ConnectorResult};

pub const DEFAULT_PROMPT_IDLE_TIMEOUT_MS: u64 = 180_000;
pub const DEFAULT_PROMPT_MAX_DURATION_MS: u64 = 1_800_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramConnectorConfig {
    pub bot_token: String,
    pub allowed_users: Vec<i64>,
    pub core_url: String,
    pub core_ws_url: String,
    pub connector_token: Option<String>,
    pub notification_chat_id: Option<String>,
    pub proxy_url: Option<String>,
    pub max_requests_per_minute: i64,
    pub silent_notifications: bool,
    pub prompt_idle_timeout_ms: u64,
    pub prompt_max_duration_ms: u64,
}

pub fn load_connector_config(env: &HashMap<String, String>) -> TelegramConnectorConfig {
    let bot_token = env
        .get("TELEGRAM_BOT_TOKEN")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let allowed_users = parse_allowed_users(env);
    let core_url = env
        .get("ADS_CORE_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:8787".to_string());
    let core_ws_url = env
        .get("ADS_CORE_WS_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| resolve_ws_url(&core_url));
    let connector_token = env
        .get("ADS_CONNECTOR_TOKEN")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let notification_chat_id = env
        .get("TELEGRAM_NOTIFICATION_CHAT_ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let proxy_url = ["HTTPS_PROXY", "HTTP_PROXY", "TELEGRAM_PROXY_URL"]
        .iter()
        .find_map(|key| env.get(*key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let max_requests_per_minute = ["TELEGRAM_MAX_REQUESTS_PER_MINUTE", "TELEGRAM_MAX_RPM"]
        .iter()
        .find_map(|key| env.get(*key))
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value != 0)
        .unwrap_or(30);
    let silent_notifications = env
        .get("TELEGRAM_SILENT_NOTIFICATIONS")
        .map(|value| value.trim().to_ascii_lowercase())
        .is_none_or(|value| value != "false" && value != "0");
    let prompt_idle_timeout_ms = env
        .get("TELEGRAM_PROMPT_IDLE_TIMEOUT_MS")
        .and_then(|value| parse_positive_u64(value))
        .unwrap_or(DEFAULT_PROMPT_IDLE_TIMEOUT_MS);
    let prompt_max_duration_ms = env
        .get("TELEGRAM_PROMPT_MAX_DURATION_MS")
        .and_then(|value| parse_positive_u64(value))
        .unwrap_or(DEFAULT_PROMPT_MAX_DURATION_MS);

    TelegramConnectorConfig {
        bot_token,
        allowed_users,
        core_url,
        core_ws_url,
        connector_token,
        notification_chat_id,
        proxy_url,
        max_requests_per_minute,
        silent_notifications,
        prompt_idle_timeout_ms,
        prompt_max_duration_ms,
    }
}

pub fn validate_connector_config(config: &TelegramConnectorConfig) -> ConnectorResult<()> {
    if config.bot_token.is_empty() {
        return Err(ConnectorError::Config(
            "TELEGRAM_BOT_TOKEN is required".to_string(),
        ));
    }
    if config.allowed_users.is_empty() {
        return Err(ConnectorError::Config(
            "TELEGRAM_ALLOWED_USER_ID is required".to_string(),
        ));
    }
    if config.connector_token.as_deref().is_none_or(str::is_empty) {
        return Err(ConnectorError::Config(
            "ADS_CONNECTOR_TOKEN is required".to_string(),
        ));
    }
    if config.prompt_max_duration_ms < config.prompt_idle_timeout_ms {
        return Err(ConnectorError::Config(
            "TELEGRAM_PROMPT_MAX_DURATION_MS must be greater than or equal to TELEGRAM_PROMPT_IDLE_TIMEOUT_MS"
                .to_string(),
        ));
    }
    Ok(())
}

fn parse_allowed_users(env: &HashMap<String, String>) -> Vec<i64> {
    if let Some(value) = env.get("TELEGRAM_ALLOWED_USER_ID")
        && let Ok(id) = value.trim().parse::<i64>()
    {
        return vec![id];
    }
    env.get("TELEGRAM_ALLOWED_USERS")
        .map(|value| {
            value
                .split(',')
                .filter_map(|entry| entry.trim().parse::<i64>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_ws_url(core_url: &str) -> String {
    Url::parse(core_url).map_or_else(
        |_| "ws://127.0.0.1:8787/ws".to_string(),
        |url| {
            let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
            format!(
                "{scheme}://{}{}",
                url.host_str().unwrap_or("127.0.0.1"),
                url.port()
                    .map_or_else(String::new, |port| format!(":{port}"))
            ) + "/ws"
        },
    )
}

fn parse_positive_u64(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(values: &[(&str, &str)]) -> HashMap<String, String> {
        values
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn loads_config_and_derives_websocket_url() {
        let config = load_connector_config(&env(&[
            ("TELEGRAM_BOT_TOKEN", "1234:token"),
            ("TELEGRAM_ALLOWED_USER_ID", "987654"),
            ("ADS_CORE_URL", "https://10.0.0.1:8443"),
            ("ADS_CONNECTOR_TOKEN", "connector"),
        ]));
        assert_eq!(config.allowed_users, vec![987654]);
        assert_eq!(config.core_ws_url, "wss://10.0.0.1:8443/ws");
        assert_eq!(config.prompt_idle_timeout_ms, 180_000);
        assert_eq!(config.prompt_max_duration_ms, 1_800_000);
        validate_connector_config(&config).expect("valid config");
    }

    #[test]
    fn validates_required_credentials_and_timeouts() {
        let missing = load_connector_config(&HashMap::new());
        assert!(validate_connector_config(&missing).is_err());
        let invalid_timeout = load_connector_config(&env(&[
            ("TELEGRAM_BOT_TOKEN", "1234:token"),
            ("TELEGRAM_ALLOWED_USER_ID", "1"),
            ("ADS_CONNECTOR_TOKEN", "connector"),
            ("TELEGRAM_PROMPT_IDLE_TIMEOUT_MS", "600000"),
            ("TELEGRAM_PROMPT_MAX_DURATION_MS", "1000"),
        ]));
        assert!(validate_connector_config(&invalid_timeout).is_err());
    }

    #[test]
    fn accepts_the_legacy_rate_limit_name() {
        let config = load_connector_config(&env(&[
            ("TELEGRAM_BOT_TOKEN", "1234:token"),
            ("TELEGRAM_ALLOWED_USER_ID", "1"),
            ("ADS_CONNECTOR_TOKEN", "connector"),
            ("TELEGRAM_MAX_RPM", "12"),
        ]));
        assert_eq!(config.max_requests_per_minute, 12);
    }
}
