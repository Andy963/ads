mod actions;
mod attachments;
mod auth;
mod models;
mod notes;
mod projects;
mod providers;
pub mod pull_requests;
mod role_profiles;
mod runtimes;
mod schedules;
mod web_push;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ads_actions::ReviewQueue;
use ads_auth::{AuthError, AuthService, RequestMetadata};
use ads_runtime::scheduler::{ScheduleCompiler, SchedulerRuntime};
use ads_runtime::{PromptQueueRunner, PromptQueueService, PromptQueueServiceOptions};
use ads_state::{StateDb, StateError, WorkspaceDb, get_lane_generation};
use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::AppState;
use crate::CookieSecureMode;
use crate::cookies::{client_ip, read_session_cookie, user_agent};
use crate::error::ApiError;
use crate::web_push::{WebPushConfig, WebPushService};
use crate::ws::{WebSocketConfig, WebSocketHub};

const JSON_BODY_LIMIT: usize = 1_000_000;
const ATTACHMENT_BODY_LIMIT: usize = 25 * 1024 * 1024 + 512 * 1024;

pub struct RouterConfig {
    pub cookie_secure: CookieSecureMode,
    pub allowed_dirs: Vec<PathBuf>,
    pub allowed_origins: HashSet<String>,
    pub client_dir: Option<PathBuf>,
    pub workspace_db: Arc<WorkspaceDb>,
    pub default_workspace_root: PathBuf,
    pub workspace_state_dir: PathBuf,
    pub prompt_queue_runner: Option<Arc<dyn PromptQueueRunner>>,
    pub schedule_compiler: Option<Arc<dyn ScheduleCompiler>>,
    pub scheduler: Option<Arc<SchedulerRuntime>>,
    pub websocket_hub: Option<Arc<WebSocketHub>>,
    pub review_queue: Option<Arc<ReviewQueue>>,
    pub gh_runner: Option<Arc<dyn pull_requests::GhRunner>>,
    pub web_push_service: Option<Arc<WebPushService>>,
    pub runtime_registry: Option<Arc<crate::runtimes::RuntimeRegistry>>,
}

impl RouterConfig {
    pub fn new(
        cookie_secure: CookieSecureMode,
        allowed_dirs: Vec<PathBuf>,
        allowed_origins: HashSet<String>,
        workspace_db: Arc<WorkspaceDb>,
        default_workspace_root: PathBuf,
    ) -> Self {
        Self {
            cookie_secure,
            allowed_dirs,
            allowed_origins,
            client_dir: None,
            workspace_db,
            default_workspace_root,
            workspace_state_dir: ads_state::resolve_ads_state_dir(),
            prompt_queue_runner: None,
            schedule_compiler: None,
            scheduler: None,
            websocket_hub: None,
            review_queue: None,
            gh_runner: None,
            web_push_service: None,
            runtime_registry: None,
        }
    }

    pub fn with_client_dir(mut self, client_dir: Option<PathBuf>) -> Self {
        self.client_dir = client_dir;
        self
    }

    pub fn with_workspace_state_dir(mut self, workspace_state_dir: impl Into<PathBuf>) -> Self {
        self.workspace_state_dir = workspace_state_dir.into();
        self
    }

    pub fn with_prompt_queue_runner(mut self, runner: Arc<dyn PromptQueueRunner>) -> Self {
        self.prompt_queue_runner = Some(runner);
        self
    }

    pub fn with_schedule_compiler(mut self, compiler: Arc<dyn ScheduleCompiler>) -> Self {
        self.schedule_compiler = Some(compiler);
        self
    }

    pub fn with_scheduler(mut self, scheduler: Arc<SchedulerRuntime>) -> Self {
        self.scheduler = Some(scheduler);
        self
    }

    pub fn with_websocket_hub(mut self, hub: Arc<WebSocketHub>) -> Self {
        self.websocket_hub = Some(hub);
        self
    }

    pub fn with_review_queue(mut self, queue: Arc<ReviewQueue>) -> Self {
        self.review_queue = Some(queue);
        self
    }

    pub fn with_gh_runner(mut self, runner: Arc<dyn pull_requests::GhRunner>) -> Self {
        self.gh_runner = Some(runner);
        self
    }

    pub fn with_web_push_service(mut self, service: Arc<WebPushService>) -> Self {
        self.web_push_service = Some(service);
        self
    }

    pub fn with_runtime_registry(
        mut self,
        registry: Arc<crate::runtimes::RuntimeRegistry>,
    ) -> Self {
        self.runtime_registry = Some(registry);
        self
    }
}

pub fn build_router(auth: Arc<AuthService>, config: RouterConfig) -> Router {
    let gh_runner: Arc<dyn pull_requests::GhRunner> = config
        .gh_runner
        .unwrap_or_else(|| Arc::new(pull_requests::DefaultGhRunner));
    let pull_request_manager = Arc::new(pull_requests::PullRequestManager::new(gh_runner));
    let web_push = config.web_push_service.unwrap_or_else(|| {
        Arc::new(WebPushService::new(
            auth.db().clone(),
            WebPushConfig::from_env(),
        ))
    });
    let ws = config
        .websocket_hub
        .unwrap_or_else(|| Arc::new(WebSocketHub::new(WebSocketConfig::from_env())));
    if let Some(registry) = config.runtime_registry.as_ref() {
        registry.attach_ws_hub(Arc::clone(&ws));
    }
    let mut state = AppState {
        auth,
        cookie_secure: config.cookie_secure,
        allowed_dirs: Arc::new(config.allowed_dirs),
        allowed_origins: Arc::new(config.allowed_origins),
        client_dir: config.client_dir.map(Arc::new),
        workspace_db: config.workspace_db,
        default_workspace_root: Arc::new(config.default_workspace_root),
        workspace_state_dir: Arc::new(config.workspace_state_dir),
        ws,
        prompt_queue: None,
        agent_messages: None,
        schedule_compiler: config.schedule_compiler,
        scheduler: config.scheduler,
        review_queue: config.review_queue,
        pull_request_manager,
        web_push,
        runtime_registry: config.runtime_registry,
    };
    if let Some(runner) = config.prompt_queue_runner {
        start_prompt_queue(&mut state, Arc::clone(&runner));
        start_agent_messages(&mut state, runner);
    }
    spawn_delta_flush_ticker(state.clone());
    let json_api = Router::new()
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/web-push/config", get(web_push::config))
        .route("/api/web-push/subscription", post(web_push::subscribe))
        .route("/api/web-push/unsubscribe", post(web_push::unsubscribe))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route("/api/projects/reorder", post(projects::reorder))
        .route("/api/projects/active", patch(projects::set_active))
        .route(
            "/api/projects/{project_id}",
            patch(projects::update).delete(projects::delete),
        )
        .route("/api/pull-requests", get(pull_requests::list))
        .route("/api/pull-requests/{number}", get(pull_requests::detail))
        .route("/api/notes", get(notes::list).post(notes::create))
        .route(
            "/api/notes/{note_id}",
            patch(notes::update).delete(notes::delete),
        )
        .route("/api/model-configs", get(models::list).post(models::create))
        .route(
            "/api/model-configs/{model_id}",
            patch(models::update).delete(models::delete),
        )
        .route("/api/model-services", get(models::list_services))
        .route("/api/model-services/{service}", put(models::save_service))
        .route("/api/models", get(models::list_conversation_models))
        .route(
            "/api/model-providers",
            get(providers::list_providers).post(providers::create_provider),
        )
        .route(
            "/api/model-providers/{provider_id}",
            patch(providers::update_provider).delete(providers::delete_provider),
        )
        .route(
            "/api/model-providers/{provider_id}/models/sync",
            post(providers::sync_provider_models),
        )
        .route(
            "/api/models/upstream/config",
            get(providers::upstream_config),
        )
        .route(
            "/api/models/upstream",
            get(providers::discover_saved_upstream).post(providers::discover_upstream),
        )
        .route(
            "/api/models/upstream/discover",
            post(providers::discover_upstream),
        )
        .route("/api/role-profiles", get(role_profiles::list))
        .route(
            "/api/role-profiles/{profile_id}",
            put(role_profiles::update),
        )
        .route("/api/runtimes", get(runtimes::list_runtimes))
        .route("/api/runtimes/refresh", post(runtimes::refresh_runtimes))
        .route(
            "/api/runtimes/agy/accounts",
            get(runtimes::list_agy_accounts).post(runtimes::upsert_agy_account),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}",
            delete(runtimes::delete_agy_account),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}/login/start",
            post(runtimes::start_agy_login),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}/login/complete",
            post(runtimes::complete_agy_login),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}/login/cancel",
            post(runtimes::cancel_agy_login),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}/logout",
            post(runtimes::logout_agy_account),
        )
        .route(
            "/api/runtimes/agy/accounts/{account_id}/refresh",
            post(runtimes::refresh_agy_account),
        )
        .route(
            "/api/schedules",
            get(schedules::list).post(schedules::create),
        )
        .route("/api/schedules/{schedule_id}", patch(schedules::update))
        .route(
            "/api/schedules/{schedule_id}/enable",
            post(schedules::enable),
        )
        .route(
            "/api/schedules/{schedule_id}/disable",
            post(schedules::disable),
        )
        .route("/api/schedules/{schedule_id}/runs", get(schedules::runs))
        .route("/api/actions/jobs", get(actions::list))
        .route("/api/actions/dispatch", post(actions::retired_dispatch))
        .route("/api/actions/queue/start", post(actions::retired_queue))
        .route("/api/actions/{*rest}", post(actions::retired))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));
    let attachment_api = Router::new()
        .route("/api/attachments/images", post(attachments::upload))
        .route(
            "/api/attachments/{attachment_id}/raw",
            get(attachments::raw),
        )
        .layer(DefaultBodyLimit::max(ATTACHMENT_BODY_LIMIT));
    let api = json_api
        .merge(attachment_api)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_origin,
        ));
    let app = Router::new()
        .route("/ws", get(crate::ws::handler))
        .merge(api)
        .merge(Router::new().fallback(crate::static_files::handle_fallback));
    app.layer(SetResponseHeaderLayer::overriding(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    ))
    .layer(SetResponseHeaderLayer::overriding(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    ))
    .with_state(state)
}

fn spawn_delta_flush_ticker(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        loop {
            interval.tick().await;
            state
                .ws
                .flush_delta_snapshots(state.auth.db(), ads_contract::time::now_unix_millis());
        }
    });
}

fn start_prompt_queue(state: &mut AppState, runner: Arc<dyn PromptQueueRunner>) {
    let store = state.auth.db().clone();
    let generation_store = store.clone();
    let emit_state = state.clone();
    let emit_event_state = state.clone();
    let service = PromptQueueService::new(PromptQueueServiceOptions {
        store,
        worker_id: format!("web-rust-{}-{}", std::process::id(), uuid::Uuid::new_v4()),
        owner_pid: Some(i64::from(std::process::id())),
        is_owner_alive: Some(Arc::new(process_is_alive)),
        ownership_renewal_interval: None,
        resolve_current_generation: Arc::new(move |entry| {
            let Ok(mut connection) = generation_store.connect() else {
                return 0;
            };
            get_lane_generation(
                &mut connection,
                &entry.lane_namespace,
                &entry.logical_history_key,
                ads_contract::time::now_unix_millis(),
            )
            .unwrap_or(0)
        }),
        runner,
        emit_snapshot: Arc::new(move |entry| {
            crate::ws::emit_prompt_queue_snapshot(&emit_state, &entry);
        }),
        emit_event: Arc::new(move |entry, payload| {
            crate::ws::emit_prompt_event(&emit_event_state, entry, payload);
        }),
        on_error: Some(Arc::new(|message| {
            eprintln!("[ads-prompts] {message}");
        })),
    });
    state.prompt_queue = Some(Arc::clone(&service));
    tokio::spawn(async move {
        if let Err(error) = service.start().await {
            eprintln!("[ads-prompts] failed to start prompt queue: {error}");
        }
    });
}

fn start_agent_messages(state: &mut AppState, runner: Arc<dyn PromptQueueRunner>) {
    let Some(prompt_queue) = state.prompt_queue.as_ref().cloned() else {
        return;
    };
    let service = crate::AgentMessageService::new(
        state.auth.db().clone(),
        Arc::clone(&state.ws),
        prompt_queue,
        runner,
    );
    service.start();
    state.agent_messages = Some(service);
}

fn process_is_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    if pid == i64::from(std::process::id()) {
        return true;
    }
    let proc_root = std::path::Path::new("/proc");
    if proc_root.is_dir() {
        return proc_root.join(pid.to_string()).exists();
    }
    false
}

async fn enforce_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if is_state_changing_method(request.method())
        && !crate::origin::is_origin_allowed_for_request(request.headers(), &state.allowed_origins)
    {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(ads_contract::auth::ErrorResponse {
                error: "Forbidden".to_string(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

fn is_state_changing_method(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JsonDecodeError {
    TooLarge,
    InvalidJson,
    InvalidPayload,
}

fn map_body_rejection(error: BytesRejection) -> JsonDecodeError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        JsonDecodeError::TooLarge
    } else {
        JsonDecodeError::InvalidPayload
    }
}

fn decode_json_bytes<T>(bytes: Bytes) -> Result<T, JsonDecodeError>
where
    T: DeserializeOwned,
{
    let value: Value = if bytes.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).map_err(|_| JsonDecodeError::InvalidJson)?
    };
    serde_json::from_value(value).map_err(|_| JsonDecodeError::InvalidPayload)
}

pub(crate) fn decode_json<T>(body: Result<Bytes, BytesRejection>) -> Result<T, JsonDecodeError>
where
    T: DeserializeOwned,
{
    body.map_err(map_body_rejection).and_then(decode_json_bytes)
}

pub(crate) async fn read_request_bytes(
    request: Request,
    state: &AppState,
) -> Result<Bytes, JsonDecodeError> {
    Bytes::from_request(request, state)
        .await
        .map_err(map_body_rejection)
}

pub(crate) async fn read_json<T>(request: Request, state: &AppState) -> Result<T, JsonDecodeError>
where
    T: DeserializeOwned,
{
    let bytes = read_request_bytes(request, state).await?;
    decode_json_bytes(bytes)
}

fn json_decode_api_error(error: JsonDecodeError) -> ApiError {
    match error {
        JsonDecodeError::InvalidPayload => ApiError::bad_request("Invalid payload"),
        JsonDecodeError::TooLarge | JsonDecodeError::InvalidJson => ApiError::internal(),
    }
}

pub(crate) fn decode_json_payload<T>(body: Result<Bytes, BytesRejection>) -> Result<T, ApiError>
where
    T: DeserializeOwned,
{
    decode_json(body).map_err(json_decode_api_error)
}

pub(crate) async fn read_json_payload<T>(request: Request, state: &AppState) -> Result<T, ApiError>
where
    T: DeserializeOwned,
{
    read_json(request, state)
        .await
        .map_err(json_decode_api_error)
}

pub(crate) fn request_metadata(headers: &HeaderMap) -> RequestMetadata {
    RequestMetadata {
        ip: client_ip(headers),
        user_agent: user_agent(headers),
    }
}

pub(crate) async fn run_auth<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AuthError> + Send + 'static,
{
    match tokio::task::spawn_blocking(operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            eprintln!("[ads-http] auth operation failed: {error}");
            Err(ApiError::internal())
        }
        Err(error) => {
            eprintln!("[ads-http] auth worker failed: {error}");
            Err(ApiError::internal())
        }
    }
}

pub(crate) async fn run_db<T, F>(db: StateDb, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Connection) -> Result<T, StateError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        operation(connection)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] database worker failed: {error}");
        ApiError::internal()
    })?;

    result.map_err(map_state_error)
}

pub(crate) async fn run_workspace_db<T, F>(
    db: Arc<WorkspaceDb>,
    operation: F,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(Connection) -> Result<T, StateError> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        operation(connection)
    })
    .await
    .map_err(|error| {
        eprintln!("[ads-http] workspace database worker failed: {error}");
        ApiError::internal()
    })?;

    result.map_err(map_state_error)
}

fn map_state_error(error: StateError) -> ApiError {
    match error {
        StateError::InvalidInput(message) => ApiError::bad_request(message),
        other => {
            eprintln!("[ads-http] state operation failed: {other}");
            ApiError::internal()
        }
    }
}

pub(crate) struct AuthenticatedRequest {
    pub session: ads_auth::AuthenticatedSession,
    pub connector: bool,
}

pub(crate) async fn authenticate_request(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedRequest, ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let auth = state.auth.clone();
    if let Some(session) =
        run_auth(move || auth.authenticate_connector(authorization.as_deref())).await?
    {
        return Ok(AuthenticatedRequest {
            session,
            connector: true,
        });
    }

    let token = read_session_cookie(headers).ok_or_else(ApiError::unauthorized)?;
    let auth = state.auth.clone();
    let metadata = request_metadata(headers);
    match run_auth(move || auth.authenticate(&token, &metadata)).await? {
        Some(session) => Ok(AuthenticatedRequest {
            session,
            connector: false,
        }),
        None => Err(ApiError::unauthorized()),
    }
}

pub(crate) async fn require_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<ads_auth::AuthenticatedSession, ApiError> {
    Ok(authenticate_request(state, headers).await?.session)
}
