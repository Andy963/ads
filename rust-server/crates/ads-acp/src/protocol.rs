use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

pub const ACP_PROTOCOL_VERSION: u32 = 1;

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(u64),
    String(String),
}

impl std::fmt::Display for JsonRpcId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Number(value) => write!(f, "{value}"),
            Self::String(value) => write!(f, "{value}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCapabilities {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub read_text_file: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub write_text_file: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs: Option<FileSystemCapabilities>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub terminal: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub image: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub audio: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub embedded_context: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilities {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub http: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub sse: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub load_session: bool,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub prompt_capabilities: PromptCapabilities,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub mcp_capabilities: McpCapabilities,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub session_capabilities: SessionCapabilities,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl AgentCapabilities {
    pub fn supports_load_session(&self) -> bool {
        self.load_session
    }

    pub fn supports_resume(&self) -> bool {
        match self.session_capabilities.resume.as_ref() {
            Some(Value::Bool(enabled)) => *enabled,
            Some(Value::Null) | None => self
                .extra
                .get("resumeSession")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            Some(_) => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    pub protocol_version: u32,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub client_capabilities: ClientCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_info: Option<ImplementationInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub protocol_version: u32,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub agent_capabilities: AgentCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<ImplementationInfo>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub auth_methods: Vec<AuthMethod>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SessionMode {
    Default,
    AcceptEdits,
    Plan,
    Custom(String),
}

impl SessionMode {
    pub fn as_wire_str(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "accept-edits",
            Self::Plan => "plan",
            Self::Custom(value) => value.as_str(),
        }
    }

    pub fn from_wire_str(value: &str) -> Self {
        match value.trim() {
            "default" => Self::Default,
            "accept-edits" => Self::AcceptEdits,
            "plan" => Self::Plan,
            other => Self::Custom(other.to_string()),
        }
    }
}

impl Serialize for SessionMode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_wire_str())
    }
}

impl<'de> Deserialize<'de> for SessionMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_wire_str(&value))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModeInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModeState {
    pub current_mode_id: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub available_modes: Vec<SessionModeInfo>,
}

fn default_select_option_type() -> String {
    "select".to_string()
}

fn deserialize_select_option_type<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(default_select_option_type))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptionValue {
    pub value: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOptionGroup {
    pub group: String,
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub options: Vec<ConfigOptionValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigOptionChoice {
    Group(ConfigOptionGroup),
    Value(ConfigOptionValue),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(
        rename = "type",
        default = "default_select_option_type",
        deserialize_with = "deserialize_select_option_type"
    )]
    pub option_type: String,
    pub current_value: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub options: Vec<ConfigOptionChoice>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ConfigOption {
    pub fn flattened_values(&self) -> Vec<&ConfigOptionValue> {
        let mut values = Vec::new();
        for choice in &self.options {
            match choice {
                ConfigOptionChoice::Value(value) => values.push(value),
                ConfigOptionChoice::Group(group) => values.extend(group.options.iter()),
            }
        }
        values
    }

    pub fn supports_value(&self, candidate: &str) -> bool {
        let values = self.flattened_values();
        values.is_empty() || values.iter().any(|entry| entry.value == candidate)
    }
}

/// Session configuration option table keyed by `configId` (and queryable by `category`),
/// never relying on array index stability across updates.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConfigOptionsState {
    by_id: BTreeMap<String, ConfigOption>,
    category_to_id: BTreeMap<String, String>,
}

impl ConfigOptionsState {
    pub fn from_vec(options: Vec<ConfigOption>) -> Self {
        let mut state = Self::default();
        state.replace_all(options);
        state
    }

    pub fn replace_all(&mut self, options: Vec<ConfigOption>) {
        self.by_id.clear();
        self.category_to_id.clear();
        for option in options {
            if let Some(category) = option
                .category
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                self.category_to_id
                    .insert(category.to_string(), option.id.clone());
            }
            self.by_id.insert(option.id.clone(), option);
        }
    }

    pub fn get_by_id(&self, id: &str) -> Option<&ConfigOption> {
        self.by_id.get(id)
    }

    pub fn get_by_category(&self, category: &str) -> Option<&ConfigOption> {
        self.category_to_id
            .get(category)
            .and_then(|id| self.by_id.get(id))
            .or_else(|| self.by_id.get(category))
    }

    pub fn resolve_model(&self) -> Option<&ConfigOption> {
        self.get_by_category("model")
    }

    pub fn resolve_thought_level(&self) -> Option<&ConfigOption> {
        self.get_by_category("thought_level")
            .or_else(|| self.get_by_category("reasoning_effort"))
            .or_else(|| self.get_by_id("thought_level"))
            .or_else(|| self.get_by_id("reasoning_effort"))
    }

    pub fn resolve_mode(&self) -> Option<&ConfigOption> {
        self.get_by_category("mode")
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn snapshot(&self) -> Vec<ConfigOption> {
        self.by_id.values().cloned().collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNewRequest {
    pub cwd: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub mcp_servers: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNewResponse {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub config_options: Vec<ConfigOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeRequest {
    pub session_id: String,
    pub cwd: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub mcp_servers: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub config_options: Vec<ConfigOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadRequest {
    pub session_id: String,
    pub cwd: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub mcp_servers: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub config_options: Vec<ConfigOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetConfigOptionRequest {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetConfigOptionResponse {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub config_options: Vec<ConfigOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedResource {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentBlock {
    Text {
        text: String,
        annotations: Option<Value>,
    },
    Resource {
        resource: EmbeddedResource,
        annotations: Option<Value>,
    },
    ResourceLink {
        uri: String,
        name: String,
        title: Option<String>,
        description: Option<String>,
        mime_type: Option<String>,
    },
    Image {
        data: String,
        mime_type: String,
        uri: Option<String>,
    },
    Audio {
        data: String,
        mime_type: String,
    },
    Unknown(Value),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum KnownContentBlock {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annotations: Option<Value>,
    },
    Resource {
        resource: EmbeddedResource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        annotations: Option<Value>,
    },
    ResourceLink {
        uri: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "mimeType")]
        mime_type: Option<String>,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    Audio {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

impl Serialize for ContentBlock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text { text, annotations } => KnownContentBlock::Text {
                text: text.clone(),
                annotations: annotations.clone(),
            }
            .serialize(serializer),
            Self::Resource {
                resource,
                annotations,
            } => KnownContentBlock::Resource {
                resource: resource.clone(),
                annotations: annotations.clone(),
            }
            .serialize(serializer),
            Self::ResourceLink {
                uri,
                name,
                title,
                description,
                mime_type,
            } => KnownContentBlock::ResourceLink {
                uri: uri.clone(),
                name: name.clone(),
                title: title.clone(),
                description: description.clone(),
                mime_type: mime_type.clone(),
            }
            .serialize(serializer),
            Self::Image {
                data,
                mime_type,
                uri,
            } => KnownContentBlock::Image {
                data: data.clone(),
                mime_type: mime_type.clone(),
                uri: uri.clone(),
            }
            .serialize(serializer),
            Self::Audio { data, mime_type } => KnownContentBlock::Audio {
                data: data.clone(),
                mime_type: mime_type.clone(),
            }
            .serialize(serializer),
            Self::Unknown(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        match serde_json::from_value::<KnownContentBlock>(value.clone()) {
            Ok(KnownContentBlock::Text { text, annotations }) => {
                Ok(Self::Text { text, annotations })
            }
            Ok(KnownContentBlock::Resource {
                resource,
                annotations,
            }) => Ok(Self::Resource {
                resource,
                annotations,
            }),
            Ok(KnownContentBlock::ResourceLink {
                uri,
                name,
                title,
                description,
                mime_type,
            }) => Ok(Self::ResourceLink {
                uri,
                name,
                title,
                description,
                mime_type,
            }),
            Ok(KnownContentBlock::Image {
                data,
                mime_type,
                uri,
            }) => Ok(Self::Image {
                data,
                mime_type,
                uri,
            }),
            Ok(KnownContentBlock::Audio { data, mime_type }) => Ok(Self::Audio { data, mime_type }),
            Err(_) => Ok(Self::Unknown(value)),
        }
    }
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            annotations: None,
        }
    }

    pub fn text_resource(
        uri: impl Into<String>,
        mime_type: Option<String>,
        text: impl Into<String>,
    ) -> Self {
        Self::Resource {
            resource: EmbeddedResource {
                uri: uri.into(),
                mime_type,
                text: Some(text.into()),
                blob: None,
            },
            annotations: None,
        }
    }

    pub fn blob_resource(
        uri: impl Into<String>,
        mime_type: Option<String>,
        blob: impl Into<String>,
    ) -> Self {
        Self::Resource {
            resource: EmbeddedResource {
                uri: uri.into(),
                mime_type,
                text: None,
                blob: Some(blob.into()),
            },
            annotations: None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text, .. } => Some(text.as_str()),
            Self::Resource { resource, .. } => resource.text.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptRequest {
    pub session_id: String,
    pub prompt: Vec<ContentBlock>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Other(String),
}

impl StopReason {
    pub fn as_wire_str(&self) -> &str {
        match self {
            Self::EndTurn => "end_turn",
            Self::MaxTokens => "max_tokens",
            Self::MaxTurnRequests => "max_turn_requests",
            Self::Refusal => "refusal",
            Self::Cancelled => "cancelled",
            Self::Other(other) => other.as_str(),
        }
    }

    pub fn from_wire_str(value: &str) -> Self {
        match value.trim() {
            "end_turn" => Self::EndTurn,
            "max_tokens" => Self::MaxTokens,
            "max_turn_requests" => Self::MaxTurnRequests,
            "refusal" => Self::Refusal,
            "cancelled" => Self::Cancelled,
            other => Self::Other(other.to_string()),
        }
    }
}

impl Serialize for StopReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_wire_str())
    }
}

impl<'de> Deserialize<'de> for StopReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_wire_str(&value))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptResponse {
    pub stop_reason: StopReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallLocation {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInfo {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub content: Vec<Value>,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub locations: Vec<ToolCallLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommand {
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUpdateInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionUpdateInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionUpdate {
    AgentMessageChunk {
        content: ContentBlock,
    },
    UserMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    ToolCall(ToolCallInfo),
    ToolCallUpdate(ToolCallInfo),
    Plan {
        entries: Vec<PlanEntry>,
    },
    AvailableCommandsUpdate {
        available_commands: Vec<AvailableCommand>,
    },
    CurrentModeUpdate {
        current_mode_id: String,
    },
    ConfigOptionUpdate {
        config_options: Vec<ConfigOption>,
    },
    UsageUpdate(UsageUpdateInfo),
    CompactionUpdate(CompactionUpdateInfo),
    Unknown(Value),
}

impl SessionUpdate {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let Some(kind) = value.get("sessionUpdate").and_then(Value::as_str) else {
            return Err("session/update payload missing string \"sessionUpdate\"".to_string());
        };
        match kind {
            "agent_message_chunk" => {
                let content = extract_content_block(&value)?;
                Ok(Self::AgentMessageChunk { content })
            }
            "user_message_chunk" => {
                let content = extract_content_block(&value)?;
                Ok(Self::UserMessageChunk { content })
            }
            "agent_thought_chunk" => {
                let content = extract_content_block(&value)?;
                Ok(Self::AgentThoughtChunk { content })
            }
            "tool_call" => serde_json::from_value(value)
                .map(Self::ToolCall)
                .map_err(|error| format!("invalid tool_call update: {error}")),
            "tool_call_update" => serde_json::from_value(value)
                .map(Self::ToolCallUpdate)
                .map_err(|error| format!("invalid tool_call_update: {error}")),
            "plan" => {
                #[derive(Deserialize)]
                struct PlanPayload {
                    #[serde(default, deserialize_with = "deserialize_null_default")]
                    entries: Vec<PlanEntry>,
                }
                let payload: PlanPayload = serde_json::from_value(value)
                    .map_err(|error| format!("invalid plan update: {error}"))?;
                Ok(Self::Plan {
                    entries: payload.entries,
                })
            }
            "available_commands_update" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct CommandsPayload {
                    #[serde(default, deserialize_with = "deserialize_null_default")]
                    available_commands: Vec<AvailableCommand>,
                }
                let payload: CommandsPayload = serde_json::from_value(value)
                    .map_err(|error| format!("invalid available_commands_update: {error}"))?;
                Ok(Self::AvailableCommandsUpdate {
                    available_commands: payload.available_commands,
                })
            }
            "current_mode_update" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ModePayload {
                    current_mode_id: String,
                }
                let payload: ModePayload = serde_json::from_value(value)
                    .map_err(|error| format!("invalid current_mode_update: {error}"))?;
                Ok(Self::CurrentModeUpdate {
                    current_mode_id: payload.current_mode_id,
                })
            }
            "config_option_update" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ConfigPayload {
                    #[serde(default, deserialize_with = "deserialize_null_default")]
                    config_options: Vec<ConfigOption>,
                }
                let payload: ConfigPayload = serde_json::from_value(value)
                    .map_err(|error| format!("invalid config_option_update: {error}"))?;
                Ok(Self::ConfigOptionUpdate {
                    config_options: payload.config_options,
                })
            }
            "usage_update" => serde_json::from_value(value)
                .map(Self::UsageUpdate)
                .map_err(|error| format!("invalid usage_update: {error}")),
            "compaction_update" | "context_compaction" => serde_json::from_value(value)
                .map(Self::CompactionUpdate)
                .map_err(|error| format!("invalid compaction_update: {error}")),
            _ => Ok(Self::Unknown(value)),
        }
    }
}

fn extract_content_block(value: &Value) -> Result<ContentBlock, String> {
    let content = value
        .get("content")
        .cloned()
        .ok_or_else(|| "chunk update missing \"content\"".to_string())?;
    serde_json::from_value(content).map_err(|error| format!("invalid content block: {error}"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionUpdateNotification {
    pub session_id: String,
    pub update: SessionUpdate,
}

impl SessionUpdateNotification {
    pub fn from_params(params: Value) -> Result<Self, String> {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "session/update missing \"sessionId\"".to_string())?;
        let update_value = params
            .get("update")
            .cloned()
            .ok_or_else(|| "session/update missing \"update\"".to_string())?;
        let update = SessionUpdate::from_value(update_value)?;
        Ok(Self { session_id, update })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    Other(String),
}

impl PermissionOptionKind {
    pub fn as_wire_str(&self) -> &str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::RejectOnce => "reject_once",
            Self::RejectAlways => "reject_always",
            Self::Other(other) => other.as_str(),
        }
    }

    pub fn from_wire_str(value: &str) -> Self {
        match value.trim() {
            "allow_once" => Self::AllowOnce,
            "allow_always" => Self::AllowAlways,
            "reject_once" => Self::RejectOnce,
            "reject_always" => Self::RejectAlways,
            other => Self::Other(other.to_string()),
        }
    }
}

impl Serialize for PermissionOptionKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_wire_str())
    }
}

impl<'de> Deserialize<'de> for PermissionOptionKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_wire_str(&value))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: PermissionOptionKind,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionParams {
    pub session_id: String,
    pub tool_call: ToolCallInfo,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub options: Vec<PermissionOption>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PermissionOutcome {
    Selected {
        #[serde(rename = "optionId")]
        option_id: String,
    },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionResponse {
    pub outcome: PermissionOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_options_state_indexes_by_id_and_category_regardless_of_order() {
        let first = ConfigOption {
            id: "opt_thought".to_string(),
            name: "Thought Level".to_string(),
            description: None,
            category: Some("thought_level".to_string()),
            option_type: "select".to_string(),
            current_value: "medium".to_string(),
            options: vec![],
            extra: Map::new(),
        };
        let second = ConfigOption {
            id: "opt_model".to_string(),
            name: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            option_type: "select".to_string(),
            current_value: "model-a".to_string(),
            options: vec![],
            extra: Map::new(),
        };
        let state = ConfigOptionsState::from_vec(vec![first.clone(), second.clone()]);
        assert_eq!(
            state.resolve_model().map(|o| o.id.as_str()),
            Some("opt_model")
        );
        assert_eq!(
            state.resolve_thought_level().map(|o| o.id.as_str()),
            Some("opt_thought")
        );
        assert_eq!(state.get_by_id("opt_model"), Some(&second));
    }

    #[test]
    fn parses_session_update_variants_null_fields_and_unknown_safely() {
        let chunk = SessionUpdateNotification::from_params(json!({
            "sessionId": "sess-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            }
        }))
        .expect("parse chunk");
        assert_eq!(chunk.session_id, "sess-1");
        assert!(matches!(
            chunk.update,
            SessionUpdate::AgentMessageChunk {
                content: ContentBlock::Text { ref text, .. }
            } if text == "hello"
        ));

        let tool_update_with_nulls = SessionUpdateNotification::from_params(json!({
            "sessionId": "sess-1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "tc-null",
                "status": "completed",
                "content": null,
                "locations": null
            }
        }))
        .expect("parse tool_call_update with nulls");
        assert!(matches!(
            tool_update_with_nulls.update,
            SessionUpdate::ToolCallUpdate(ref info)
                if info.tool_call_id == "tc-null" && info.content.is_empty() && info.locations.is_empty()
        ));

        let unknown = SessionUpdateNotification::from_params(json!({
            "sessionId": "sess-1",
            "update": {
                "sessionUpdate": "future_extension_event",
                "foo": "bar"
            }
        }))
        .expect("parse unknown");
        assert!(matches!(unknown.update, SessionUpdate::Unknown(_)));

        let audio_chunk = SessionUpdateNotification::from_params(json!({
            "sessionId": "sess-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "audio", "data": "AA==", "mimeType": "audio/wav" }
            }
        }))
        .expect("parse audio block");
        assert!(matches!(
            audio_chunk.update,
            SessionUpdate::AgentMessageChunk {
                content: ContentBlock::Audio { .. }
            }
        ));
    }
}
