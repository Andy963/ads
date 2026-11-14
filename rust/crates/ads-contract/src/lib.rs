pub mod attachments;
pub mod auth;
pub mod models;
pub mod native_transcript;
pub mod projects;
pub mod role_profiles;
pub mod schedule;
pub mod serde_support;
pub mod sync;
pub mod time;
pub mod ws;

pub const SESSION_COOKIE_NAME: &str = "ads_session";
pub const DEFAULT_SESSION_TTL_SECONDS: i64 = 604_800;
pub const MIN_SESSION_TTL_SECONDS: i64 = 60;
