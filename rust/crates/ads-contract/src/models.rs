use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub model_id: String,
    pub display_name: String,
    pub provider: String,
    pub provider_id: Option<String>,
    pub is_enabled: bool,
    pub is_default: bool,
    pub config_json: Option<serde_json::Value>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub credential_profile: Option<String>,
    pub wire_api: Option<String>,
    pub is_enabled: bool,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelServiceSelection {
    pub service: String,
    pub model_ids: Vec<String>,
    pub default_model_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateModelConfigRequest {
    pub model_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub provider: String,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub provider_id: Option<Option<String>>,
    #[serde(default)]
    pub is_enabled: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub config_json: Option<Option<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateModelConfigRequest {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub provider_id: Option<Option<String>>,
    #[serde(default)]
    pub is_enabled: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub config_json: Option<Option<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelServiceRequest {
    pub model_ids: Vec<String>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub default_model_id: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderPayload {
    #[serde(flatten)]
    pub provider: ModelProvider,
    pub has_credential: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateModelProviderRequest {
    pub name: String,
    pub base_url: String,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub wire_api: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub is_enabled: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub api_key: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateModelProviderRequest {
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub base_url: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub wire_api: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub is_enabled: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub api_key: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpstreamDiscoveryRequest {
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub base_url: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub api_key: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub provider: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub credential_profile: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamDiscoveryResult {
    pub ok: bool,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamConfigResponse {
    pub base_url: String,
    pub provider: String,
    pub has_api_key: bool,
    pub source: String,
}
