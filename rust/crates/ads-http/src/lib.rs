mod command;
mod command_snapshot;
pub mod cookies;
mod delta_stream;
pub mod error;
mod images;
mod multipart;
pub mod origin;
pub mod paths;
pub mod static_files;
mod ws;

mod routes;
mod skills;
mod state;
mod task_notifications;

pub use command::{
    AdsCommandOptions, CommandLineResult, run_ads_command_line, run_ads_command_line_with_options,
};
pub use cookies::CookieSecureMode;
pub use error::ApiError;
pub use origin::{is_origin_allowed_for_request, parse_allowed_origins};
pub use paths::{
    PathValidationFailure, ValidatedWorkspacePath, WorkspacePathError, detect_workspace_root,
    resolve_allowed_dirs, validate_workspace_path, validate_workspace_path_detailed,
};
pub use routes::{RouterConfig, build_router};
pub use skills::{
    SkillEntrypoint, SkillMetadata, SkillPaths, SkillRequiredEnv, SkillSource, SkillTriggers,
    render_compact_skills, render_skill_meta_instruction,
};
pub use state::AppState;
pub use static_files::resolve_client_dir;
pub use task_notifications::WebSocketScheduleNotifier;
pub use ws::{
    AcopilotWakeEvent, ActionsLaneMessage, WebSocketConfig, WebSocketHub, publish_acopilot_wake,
    publish_actions_lane_message,
};
