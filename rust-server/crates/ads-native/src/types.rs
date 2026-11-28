use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type NativeTextDelta = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireApi {
    Chat,
    Responses,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeContentPart {
    Text { text: String },
    ImageUrl { image_url: NativeImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeImageUrl {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum NativeMessageContent {
    Text(String),
    Parts(Vec<NativeContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: NativeFunctionCall,
}

impl NativeToolCall {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            call_type: "function".to_string(),
            function: NativeFunctionCall {
                name: name.into(),
                arguments: arguments.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeChatMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<NativeMessageContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<NativeToolCall>>,
    #[serde(
        default,
        rename = "nativeResponses",
        skip_serializing_if = "Option::is_none"
    )]
    pub native_responses: Option<Value>,
    #[serde(
        default,
        rename = "nativeToolOutcome",
        skip_serializing_if = "Option::is_none"
    )]
    pub native_tool_outcome: Option<String>,
}

impl NativeChatMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self::text("system", text)
    }

    pub fn user(content: NativeMessageContent) -> Self {
        Self {
            role: "user".to_string(),
            content: Some(content),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            native_responses: None,
            native_tool_outcome: None,
        }
    }

    pub fn text(role: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: Some(NativeMessageContent::Text(text.into())),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            native_responses: None,
            native_tool_outcome: None,
        }
    }

    pub fn assistant(text: impl Into<String>, tool_calls: Vec<NativeToolCall>) -> Self {
        let text = text.into();
        Self {
            role: "assistant".to_string(),
            content: (!text.is_empty()).then_some(NativeMessageContent::Text(text)),
            name: None,
            tool_call_id: None,
            tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
            native_responses: None,
            native_tool_outcome: None,
        }
    }

    pub fn tool(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            content: Some(NativeMessageContent::Text(content.into())),
            name: None,
            tool_call_id: Some(call_id.into()),
            tool_calls: None,
            native_responses: None,
            native_tool_outcome: None,
        }
    }

    pub fn tool_unknown(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        let mut message = Self::tool(call_id, content);
        message.native_tool_outcome = Some("unknown".to_string());
        message
    }

    pub fn text_content(&self) -> String {
        match self.content.as_ref() {
            Some(NativeMessageContent::Text(text)) => text.clone(),
            Some(NativeMessageContent::Parts(parts)) => parts
                .iter()
                .filter_map(|part| match part {
                    NativeContentPart::Text { text } => Some(text.as_str()),
                    NativeContentPart::ImageUrl { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
            None => String::new(),
        }
    }

    pub fn has_image(&self) -> bool {
        matches!(
            self.content.as_ref(),
            Some(NativeMessageContent::Parts(parts))
                if parts
                    .iter()
                    .any(|part| matches!(part, NativeContentPart::ImageUrl { .. }))
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeToolFunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: NativeToolFunctionDefinition,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NativeRequestOptions {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub parallel_tool_calls: Option<bool>,
    pub include_usage: bool,
    /// Optional per-chunk stream inactivity timeout override.
    /// `None` uses `resolve_native_stream_idle_timeout()`; `Some(Duration::ZERO)` disables it.
    pub stream_idle_timeout: Option<Duration>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NativeUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

impl NativeUsage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none() && self.output_tokens.is_none() && self.total_tokens.is_none()
    }

    pub fn merge(&mut self, other: &Self) {
        merge_counter(&mut self.input_tokens, other.input_tokens);
        merge_counter(&mut self.output_tokens, other.output_tokens);
        merge_counter(&mut self.total_tokens, other.total_tokens);
    }
}

fn merge_counter(target: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *target = Some(target.unwrap_or(0).saturating_add(value));
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeCompletion {
    pub text: String,
    pub tool_calls: Vec<NativeToolCall>,
    pub finish_reason: Option<String>,
    pub usage: Option<NativeUsage>,
    pub native_responses: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct NativeCompletionRequest {
    pub wire_api: WireApi,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<NativeChatMessage>,
    pub tools: Vec<NativeToolDefinition>,
    pub streaming: bool,
    pub output_schema: Option<Value>,
    pub options: NativeRequestOptions,
}
