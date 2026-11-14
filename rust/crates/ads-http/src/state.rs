use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use ads_actions::ReviewQueue;
use ads_auth::AuthService;
use ads_runtime::PromptQueueService;
use ads_runtime::scheduler::{ScheduleCompiler, SchedulerRuntime};
use ads_state::WorkspaceDb;

use crate::CookieSecureMode;
use crate::ws::WebSocketHub;

#[derive(Clone)]
pub struct AppState {
    pub auth: Arc<AuthService>,
    pub cookie_secure: CookieSecureMode,
    pub allowed_dirs: Arc<Vec<PathBuf>>,
    pub allowed_origins: Arc<HashSet<String>>,
    pub client_dir: Option<Arc<PathBuf>>,
    pub workspace_db: Arc<WorkspaceDb>,
    pub default_workspace_root: Arc<PathBuf>,
    pub workspace_state_dir: Arc<PathBuf>,
    pub ws: Arc<WebSocketHub>,
    pub prompt_queue: Option<Arc<PromptQueueService>>,
    pub schedule_compiler: Option<Arc<dyn ScheduleCompiler>>,
    pub scheduler: Option<Arc<SchedulerRuntime>>,
    pub review_queue: Option<Arc<ReviewQueue>>,
}
