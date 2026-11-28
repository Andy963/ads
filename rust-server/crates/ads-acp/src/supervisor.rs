use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::{Mutex, watch};

use crate::bridge::{AcpStreamEvent, PermissionHandler};
use crate::driver::{AcpDriver, AcpLaunchContext, AcpSessionContext};
use crate::error::{AcpError, AcpResult};
use crate::session::{AcpPromptRequest, AcpSession, AcpSessionConfig, AcpTurnResult};

pub const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
pub const DEFAULT_REAP_INTERVAL: Duration = Duration::from_secs(30);
pub const ACP_SESSION_IDLE_TTL_ENV: &str = "ADS_ACP_SESSION_IDLE_TTL_MS";

pub fn resolve_acp_session_idle_ttl() -> Duration {
    std::env::var(ACP_SESSION_IDLE_TTL_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(DEFAULT_IDLE_TTL, |ms| {
            if ms == 0 {
                Duration::ZERO
            } else {
                Duration::from_millis(ms)
            }
        })
}

#[derive(Debug, Clone)]
pub struct AcpSupervisorConfig {
    pub idle_ttl: Duration,
    pub reap_interval: Duration,
    pub session: AcpSessionConfig,
    /// When `session/resume` or `session/load` fails because the remote session no longer
    /// exists (or times out), fall back to `session/new` automatically if true.
    pub fallback_to_new_on_resume_error: bool,
}

impl Default for AcpSupervisorConfig {
    fn default() -> Self {
        Self {
            idle_ttl: DEFAULT_IDLE_TTL,
            reap_interval: DEFAULT_REAP_INTERVAL,
            session: AcpSessionConfig::default(),
            fallback_to_new_on_resume_error: true,
        }
    }
}

impl AcpSupervisorConfig {
    pub fn from_env() -> Self {
        Self {
            idle_ttl: resolve_acp_session_idle_ttl(),
            reap_interval: DEFAULT_REAP_INTERVAL,
            session: AcpSessionConfig {
                transport: crate::transport::AcpTransportConfig::from_env(),
                ..AcpSessionConfig::default()
            },
            fallback_to_new_on_resume_error: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAttachMode {
    ReusedLive,
    CreatedNew,
    Resumed,
    Loaded,
    CreatedAfterResumeFallback,
}

#[derive(Debug, Clone)]
pub struct SupervisedSessionRequest {
    pub session_key: String,
    pub workspace_root: PathBuf,
    pub working_directory: Option<PathBuf>,
    pub mcp_servers: Vec<Value>,
    pub env: HashMap<String, String>,
    pub preferred_session_id: Option<String>,
    pub prefer_load: bool,
}

impl SupervisedSessionRequest {
    pub fn new(session_key: impl Into<String>, workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            session_key: session_key.into(),
            workspace_root: workspace_root.into(),
            working_directory: None,
            mcp_servers: Vec::new(),
            env: HashMap::new(),
            preferred_session_id: None,
            prefer_load: false,
        }
    }

    pub fn with_working_directory(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.working_directory = Some(cwd.into());
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn with_preferred_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.preferred_session_id = Some(session_id.into());
        self
    }

    pub fn with_prefer_load(mut self, prefer_load: bool) -> Self {
        self.prefer_load = prefer_load;
        self
    }
}

#[derive(Debug, Clone)]
pub struct SupervisedTurnResult {
    pub attach_mode: SessionAttachMode,
    pub replayed_events: Vec<AcpStreamEvent>,
    pub turn: AcpTurnResult,
}

struct ManagedSessionEntry {
    session_lock: Arc<Mutex<()>>,
    acp_session_id: Option<String>,
    session: Option<Arc<AcpSession>>,
    last_active_at: Instant,
    in_flight: bool,
}

impl ManagedSessionEntry {
    fn new() -> Self {
        Self {
            session_lock: Arc::new(Mutex::new(())),
            acp_session_id: None,
            session: None,
            last_active_at: Instant::now(),
            in_flight: false,
        }
    }
}

struct InFlightGuard<'a> {
    entries: &'a StdMutex<HashMap<String, ManagedSessionEntry>>,
    session_key: String,
    session: Option<Arc<AcpSession>>,
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        let mut entries = self.entries.lock().expect("supervisor entries lock");
        if let Some(entry) = entries.get_mut(&self.session_key) {
            entry.in_flight = false;
            entry.last_active_at = Instant::now();
            if self
                .session
                .as_ref()
                .is_some_and(|session| session.is_closed())
            {
                entry.session = None;
            }
        }
    }
}

/// Manages one isolated ACP subprocess per active ADS session/thread with idle TTL
/// reclamation and automatic `session/resume` / `session/load` re-attachment on subsequent turns.
pub struct AcpSessionSupervisor {
    driver: Arc<dyn AcpDriver>,
    permission_handler: Arc<dyn PermissionHandler>,
    config: AcpSupervisorConfig,
    entries: StdMutex<HashMap<String, ManagedSessionEntry>>,
    shutdown_tx: watch::Sender<bool>,
}

impl Drop for AcpSessionSupervisor {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
    }
}

impl AcpSessionSupervisor {
    pub fn new(
        driver: Arc<dyn AcpDriver>,
        permission_handler: Arc<dyn PermissionHandler>,
        config: AcpSupervisorConfig,
    ) -> Arc<Self> {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let supervisor = Arc::new(Self {
            driver,
            permission_handler,
            config: config.clone(),
            entries: StdMutex::new(HashMap::new()),
            shutdown_tx,
        });

        if !config.idle_ttl.is_zero() && !config.reap_interval.is_zero() {
            let weak = Arc::downgrade(&supervisor);
            let reap_interval = config.reap_interval;
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(reap_interval);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticker.tick().await;
                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            let Some(supervisor) = weak.upgrade() else {
                                return;
                            };
                            let _ = supervisor.reap_idle_once().await;
                        }
                        changed = shutdown_rx.changed() => {
                            if changed.is_err() || *shutdown_rx.borrow() {
                                return;
                            }
                        }
                    }
                }
            });
        }

        supervisor
    }

    pub fn active_process_count(&self) -> usize {
        self.entries
            .lock()
            .expect("supervisor entries lock")
            .values()
            .filter(|entry| entry.session.is_some())
            .count()
    }

    pub fn known_session_id(&self, session_key: &str) -> Option<String> {
        self.entries
            .lock()
            .expect("supervisor entries lock")
            .get(session_key)
            .and_then(|entry| entry.acp_session_id.clone())
    }

    pub fn active_pid(&self, session_key: &str) -> Option<u32> {
        self.entries
            .lock()
            .expect("supervisor entries lock")
            .get(session_key)
            .and_then(|entry| entry.session.as_ref())
            .filter(|session| !session.is_closed())
            .and_then(|session| session.transport().pid())
    }

    pub async fn run_turn(
        &self,
        session_request: SupervisedSessionRequest,
        prompt_request: AcpPromptRequest,
    ) -> AcpResult<SupervisedTurnResult> {
        if *self.shutdown_tx.borrow() {
            return Err(AcpError::Cancelled);
        }
        let session_key = session_request.session_key.trim().to_string();
        let session_lock = {
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            let entry = entries
                .entry(session_key.clone())
                .or_insert_with(ManagedSessionEntry::new);
            Arc::clone(&entry.session_lock)
        };
        let _guard = session_lock.lock().await;
        if *self.shutdown_tx.borrow() {
            return Err(AcpError::Cancelled);
        }

        let (existing_live, saved_session_id) = {
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            let entry = entries
                .entry(session_key.clone())
                .or_insert_with(ManagedSessionEntry::new);
            entry.in_flight = true;
            let existing = entry.session.clone().filter(|session| !session.is_closed());
            if existing.is_none() {
                entry.session = None;
            }
            let saved = entry
                .acp_session_id
                .clone()
                .or_else(|| session_request.preferred_session_id.clone());
            (existing, saved)
        };

        // RAII guard ensures `in_flight` is cleared even if this future is cancelled/dropped.
        let mut in_flight_guard = InFlightGuard {
            entries: &self.entries,
            session_key: session_key.clone(),
            session: existing_live.clone(),
        };

        let (session, attach_mode, replayed_events) = match existing_live {
            Some(session) => (session, SessionAttachMode::ReusedLive, Vec::new()),
            None => {
                self.spawn_and_attach(&session_request, saved_session_id.as_deref())
                    .await?
            }
        };

        if *self.shutdown_tx.borrow() {
            session.shutdown().await;
            return Err(AcpError::Cancelled);
        }

        in_flight_guard.session = Some(Arc::clone(&session));
        {
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            if let Some(entry) = entries.get_mut(&session_key) {
                entry.acp_session_id = session.session_id();
                entry.session = Some(Arc::clone(&session));
            }
        }

        let turn = session.prompt(prompt_request).await?;
        drop(in_flight_guard);

        Ok(SupervisedTurnResult {
            attach_mode,
            replayed_events,
            turn,
        })
    }

    /// Reclaims idle sessions whose `last_active_at` exceeds `config.idle_ttl`.
    /// Preserves each session's `acp_session_id` so the next turn re-attaches via `session/resume`.
    pub async fn reap_idle_once(&self) -> usize {
        let now = Instant::now();
        let candidates: Vec<(String, Arc<Mutex<()>>)> = {
            let entries = self.entries.lock().expect("supervisor entries lock");
            entries
                .iter()
                .filter(|(_, entry)| {
                    !entry.in_flight
                        && entry.session.is_some()
                        && now.saturating_duration_since(entry.last_active_at)
                            >= self.config.idle_ttl
                })
                .map(|(key, entry)| (key.clone(), Arc::clone(&entry.session_lock)))
                .collect()
        };

        let mut reclaimed = 0usize;
        for (key, session_lock) in candidates {
            let Ok(_guard) = session_lock.try_lock() else {
                continue;
            };
            let to_close = {
                let entries = self.entries.lock().expect("supervisor entries lock");
                let Some(entry) = entries.get(&key) else {
                    continue;
                };
                if entry.in_flight
                    || Instant::now().saturating_duration_since(entry.last_active_at)
                        < self.config.idle_ttl
                {
                    None
                } else {
                    entry.session.clone()
                }
            };
            if let Some(session) = to_close {
                session.shutdown().await;
                let mut entries = self.entries.lock().expect("supervisor entries lock");
                if let Some(entry) = entries.get_mut(&key)
                    && entry
                        .session
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    entry.session = None;
                }
                reclaimed += 1;
            }
        }
        reclaimed
    }

    pub async fn shutdown_session(&self, session_key: &str) {
        self.shutdown_session_inner(session_key, false).await;
    }

    /// Shuts down the active subprocess and forgets any cached `acp_session_id` so the next
    /// turn starts from a fresh `session/new` (used after inactivity timeout or corruption).
    pub async fn discard_session(&self, session_key: &str) {
        self.shutdown_session_inner(session_key, true).await;
    }

    async fn shutdown_session_inner(&self, session_key: &str, clear_session_id: bool) {
        let session_lock = {
            let entries = self.entries.lock().expect("supervisor entries lock");
            entries
                .get(session_key)
                .map(|entry| Arc::clone(&entry.session_lock))
        };
        let Some(session_lock) = session_lock else {
            return;
        };
        let _guard = session_lock.lock().await;
        let session = {
            let entries = self.entries.lock().expect("supervisor entries lock");
            entries
                .get(session_key)
                .and_then(|entry| entry.session.clone())
        };
        if let Some(session) = session {
            session.shutdown().await;
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            if let Some(entry) = entries.get_mut(session_key) {
                if entry
                    .session
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    entry.session = None;
                }
                if clear_session_id {
                    entry.acp_session_id = None;
                }
            }
        } else if clear_session_id {
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            if let Some(entry) = entries.get_mut(session_key) {
                entry.acp_session_id = None;
            }
        }
    }

    pub async fn shutdown_all(&self) {
        let _ = self.shutdown_tx.send(true);
        let sessions: Vec<Arc<AcpSession>> = {
            let mut entries = self.entries.lock().expect("supervisor entries lock");
            entries
                .values_mut()
                .filter_map(|entry| entry.session.take())
                .collect()
        };
        for session in sessions {
            session.shutdown().await;
        }
    }

    async fn spawn_and_attach(
        &self,
        request: &SupervisedSessionRequest,
        saved_session_id: Option<&str>,
    ) -> AcpResult<(Arc<AcpSession>, SessionAttachMode, Vec<AcpStreamEvent>)> {
        let launch_ctx = AcpLaunchContext {
            session_key: request.session_key.clone(),
            workspace_root: request.workspace_root.clone(),
            working_directory: request.working_directory.clone(),
            env: request.env.clone(),
        };
        let session_ctx = AcpSessionContext {
            session_key: request.session_key.clone(),
            workspace_root: request.workspace_root.clone(),
            working_directory: request.working_directory.clone(),
            mcp_servers: request.mcp_servers.clone(),
        };

        let session = AcpSession::spawn(
            Arc::clone(&self.driver),
            &launch_ctx,
            Arc::clone(&self.permission_handler),
            self.config.session.clone(),
        )
        .await?;

        let init = match session.initialize().await {
            Ok(init) => init,
            Err(error) => {
                session.shutdown().await;
                return Err(error);
            }
        };

        let supports_resume = init.agent_capabilities.supports_resume();
        let supports_load = init.agent_capabilities.supports_load_session();

        if let Some(saved_id) = saved_session_id.filter(|id| !id.trim().is_empty()) {
            let attempt_load_first = (request.prefer_load || !supports_resume) && supports_load;

            if attempt_load_first {
                match session.load_session(saved_id, &session_ctx, None).await {
                    Ok(loaded) => {
                        return Ok((session, SessionAttachMode::Loaded, loaded.replayed_events));
                    }
                    Err(error) => {
                        return self
                            .handle_resume_or_load_error(session, &launch_ctx, &session_ctx, error)
                            .await;
                    }
                }
            } else {
                match session.resume_session(saved_id, &session_ctx).await {
                    Ok(_) => return Ok((session, SessionAttachMode::Resumed, Vec::new())),
                    Err(error) => {
                        if is_method_not_found(&error) && supports_load {
                            match session.load_session(saved_id, &session_ctx, None).await {
                                Ok(loaded) => {
                                    return Ok((
                                        session,
                                        SessionAttachMode::Loaded,
                                        loaded.replayed_events,
                                    ));
                                }
                                Err(load_error) => {
                                    return self
                                        .handle_resume_or_load_error(
                                            session,
                                            &launch_ctx,
                                            &session_ctx,
                                            load_error,
                                        )
                                        .await;
                                }
                            }
                        }
                        return self
                            .handle_resume_or_load_error(session, &launch_ctx, &session_ctx, error)
                            .await;
                    }
                }
            }
        }

        if let Err(error) = session.new_session(&session_ctx).await {
            session.shutdown().await;
            return Err(error);
        }
        Ok((session, SessionAttachMode::CreatedNew, Vec::new()))
    }

    async fn handle_resume_or_load_error(
        &self,
        session: Arc<AcpSession>,
        launch_ctx: &AcpLaunchContext,
        session_ctx: &AcpSessionContext,
        error: AcpError,
    ) -> AcpResult<(Arc<AcpSession>, SessionAttachMode, Vec<AcpStreamEvent>)> {
        if !self.config.fallback_to_new_on_resume_error || error.is_auth_required() {
            session.shutdown().await;
            return Err(error);
        }
        if error.is_timeout() {
            // A timed-out `session/resume` or `session/load` may leave the subprocess busy
            // processing the stale request. Recycle the subprocess cleanly and start a fresh
            // session so a single slow/poisoned saved session ID never traps the lane in a loop.
            return self
                .respawn_fallback_to_new(session, launch_ctx, session_ctx)
                .await;
        }
        if session.is_closed() {
            session.shutdown().await;
            return Err(error);
        }
        self.fallback_to_new(session, session_ctx).await
    }

    async fn respawn_fallback_to_new(
        &self,
        stale_session: Arc<AcpSession>,
        launch_ctx: &AcpLaunchContext,
        session_ctx: &AcpSessionContext,
    ) -> AcpResult<(Arc<AcpSession>, SessionAttachMode, Vec<AcpStreamEvent>)> {
        stale_session.shutdown().await;
        let fresh = AcpSession::spawn(
            Arc::clone(&self.driver),
            launch_ctx,
            Arc::clone(&self.permission_handler),
            self.config.session.clone(),
        )
        .await?;
        if let Err(init_error) = fresh.initialize().await {
            fresh.shutdown().await;
            return Err(init_error);
        }
        self.fallback_to_new(fresh, session_ctx).await
    }

    async fn fallback_to_new(
        &self,
        session: Arc<AcpSession>,
        session_ctx: &AcpSessionContext,
    ) -> AcpResult<(Arc<AcpSession>, SessionAttachMode, Vec<AcpStreamEvent>)> {
        if let Err(new_error) = session.new_session(session_ctx).await {
            session.shutdown().await;
            return Err(new_error);
        }
        Ok((
            session,
            SessionAttachMode::CreatedAfterResumeFallback,
            Vec::new(),
        ))
    }
}

fn is_method_not_found(error: &AcpError) -> bool {
    matches!(error, AcpError::Rpc(details) if details.code == -32601)
}
