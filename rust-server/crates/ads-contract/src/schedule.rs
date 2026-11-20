use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SCHEDULE_SPEC_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSpec {
    pub version: u32,
    pub name: String,
    pub enabled: bool,
    pub schedule: ScheduleCron,
    pub instruction: String,
    pub delivery: ScheduleDelivery,
    pub policy: SchedulePolicy,
    pub compiled_task: CompiledScheduleTask,
    pub questions: Vec<String>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleCron {
    #[serde(rename = "type")]
    pub kind: String,
    pub cron: String,
    pub timezone: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleDelivery {
    pub channels: Vec<DeliveryChannel>,
    pub web: WebDelivery,
    pub telegram: TelegramDelivery,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeliveryChannel {
    Web,
    Telegram,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebDelivery {
    pub audience: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDelivery {
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub chat_id: Option<Option<String>>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePolicy {
    pub workspace_write: bool,
    pub network: ScheduleNetworkPolicy,
    pub max_duration_ms: i64,
    pub max_retries: i64,
    pub concurrency_key: String,
    pub idempotency_key_template: String,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleNetworkPolicy {
    Deny,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledScheduleTask {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub expected_result_schema: Value,
    pub verification: ScheduleVerification,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleVerification {
    pub commands: Vec<String>,
    #[serde(flatten, default)]
    pub extra: Map<String, Value>,
}

impl ScheduleSpec {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != SCHEDULE_SPEC_VERSION {
            return Err("version must be 1".to_string());
        }
        if self.name.is_empty() {
            return Err("name is required".to_string());
        }
        if self.schedule.kind != "cron" {
            return Err("schedule.type must be cron".to_string());
        }
        if self.schedule.cron.is_empty() {
            return Err("schedule.cron is required".to_string());
        }
        if self.schedule.timezone.is_empty() {
            return Err("schedule.timezone is required".to_string());
        }
        if self.delivery.channels.is_empty() {
            return Err("delivery.channels must not be empty".to_string());
        }
        if self.delivery.web.audience.is_empty() {
            return Err("delivery.web.audience is required".to_string());
        }
        match &self.delivery.telegram.chat_id {
            None => return Err("delivery.telegram.chatId is required".to_string()),
            Some(Some(chat_id)) if chat_id.is_empty() => {
                return Err("delivery.telegram.chatId must not be empty".to_string());
            }
            Some(_) => {}
        }
        if self.policy.max_duration_ms <= 0 {
            return Err("policy.maxDurationMs must be positive".to_string());
        }
        if self.policy.max_retries < 0 {
            return Err("policy.maxRetries must be non-negative".to_string());
        }
        if self.policy.concurrency_key.is_empty() {
            return Err("policy.concurrencyKey is required".to_string());
        }
        if self.policy.idempotency_key_template.is_empty() {
            return Err("policy.idempotencyKeyTemplate is required".to_string());
        }
        if self.compiled_task.title.is_empty() {
            return Err("compiledTask.title is required".to_string());
        }
        if self.compiled_task.prompt.is_empty() {
            return Err("compiledTask.prompt is required".to_string());
        }
        Ok(())
    }
}
