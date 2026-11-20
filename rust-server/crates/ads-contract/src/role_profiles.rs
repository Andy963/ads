use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleProfile {
    pub id: String,
    pub role: String,
    pub name: String,
    pub model_id: String,
    pub reasoning_effort: String,
    pub system_prompt: String,
    pub is_enabled: i64,
    pub is_default: i64,
    pub version: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateRoleProfileRequest {
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub name: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub model_id: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub reasoning_effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub system_prompt: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub is_enabled: Option<Option<bool>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_support::deserialize_present_option"
    )]
    pub is_default: Option<Option<bool>>,
}
