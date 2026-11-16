use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_state::{
    CancelPromptInput, CancelPromptResult, EnqueuePromptInput, EnqueuePromptResult,
    INTERRUPTED_PROMPT_ERROR, PromptIdentityReconciliation, PromptQueueEntry, PromptQueueLane,
    PromptQueueStatus, PromptQueueStore, ReconcilePromptIdentitiesInput, StateDb, StateError,
    StateResult,
};
use serde_json::Value;
use thiserror::Error;
use tokio::task::JoinHandle;

pub mod scheduler;

const DEFAULT_OWNERSHIP_LEASE_MS: i64 = 60_000;
const DEFAULT_RENEWAL_INTERVAL: Duration = Duration::from_secs(20);

pub type PromptQueueFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub type PromptEventEmitter = Arc<dyn Fn(Value) + Send + Sync>;

pub type PromptEntryEventEmitter = Arc<dyn Fn(&PromptQueueEntry, Value) + Send + Sync>;

#[derive(Clone)]
pub struct PromptRunContext {
    emit: PromptEventEmitter,
}

impl PromptRunContext {
    pub fn new(emit: PromptEventEmitter) -> Self {
        Self { emit }
    }

    pub fn emit(&self, payload: Value) {
        (self.emit)(payload);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptQueueRunOutcome {
    pub ok: bool,
    pub error: Option<String>,
}

impl PromptQueueRunOutcome {
    pub fn success() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

pub trait PromptQueueRunner: Send + Sync {
    fn reconcile_before_run<'a>(
        &'a self,
        _entry: &'a PromptQueueEntry,
    ) -> PromptQueueFuture<'a, StateResult<Option<PromptQueueRunOutcome>>> {
        Box::pin(async { Ok(None) })
    }

    fn run_prompt<'a>(
        &'a self,
        entry: PromptQueueEntry,
        context: PromptRunContext,
    ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>>;

    fn abort_run(&self, _entry: &PromptQueueEntry) {}
}

#[derive(Debug, Error)]
pub enum PromptQueueServiceError {
    #[error("Prompt queue ownership is held by another live process")]
    OwnershipHeld,
    #[error("Prompt queue service does not own the queue")]
    NotOwner,
    #[error("Prompt queue service has not been started")]
    NotStarted,
    #[error(transparent)]
    State(#[from] StateError),
}

pub type PromptQueueServiceResult<T> = Result<T, PromptQueueServiceError>;

pub struct PromptQueueServiceOptions {
    pub store: StateDb,
    pub worker_id: String,
    pub owner_pid: Option<i64>,
    pub is_owner_alive: Option<Arc<dyn Fn(i64) -> bool + Send + Sync>>,
    pub ownership_renewal_interval: Option<Duration>,
    pub resolve_current_generation: Arc<dyn Fn(&PromptQueueEntry) -> i64 + Send + Sync>,
    pub runner: Arc<dyn PromptQueueRunner>,
    pub emit_snapshot: Arc<dyn Fn(PromptQueueEntry) + Send + Sync>,
    pub emit_event: PromptEntryEventEmitter,
    pub on_error: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

pub struct PromptQueueService {
    store: StateDb,
    worker_id: String,
    owner_pid: i64,
    is_owner_alive: Arc<dyn Fn(i64) -> bool + Send + Sync>,
    ownership_renewal_interval: Duration,
    resolve_current_generation: Arc<dyn Fn(&PromptQueueEntry) -> i64 + Send + Sync>,
    runner: Arc<dyn PromptQueueRunner>,
    emit_snapshot: Arc<dyn Fn(PromptQueueEntry) + Send + Sync>,
    emit_event: PromptEntryEventEmitter,
    on_error: Option<Arc<dyn Fn(String) + Send + Sync>>,
    started: AtomicBool,
    stopped: AtomicBool,
    ownership_lost: AtomicBool,
    ownership_timer: Mutex<Option<JoinHandle<()>>>,
    lane_tasks: Mutex<HashMap<String, Option<JoinHandle<()>>>>,
    active_entries: Mutex<HashMap<i64, PromptQueueEntry>>,
}

impl PromptQueueService {
    pub fn new(options: PromptQueueServiceOptions) -> Arc<Self> {
        Arc::new(Self {
            store: options.store,
            worker_id: options.worker_id,
            owner_pid: options
                .owner_pid
                .unwrap_or_else(|| i64::from(std::process::id()))
                .max(1),
            is_owner_alive: options
                .is_owner_alive
                .unwrap_or_else(|| Arc::new(|_| false)),
            ownership_renewal_interval: options
                .ownership_renewal_interval
                .unwrap_or(DEFAULT_RENEWAL_INTERVAL)
                .max(Duration::from_millis(10)),
            resolve_current_generation: options.resolve_current_generation,
            runner: options.runner,
            emit_snapshot: options.emit_snapshot,
            emit_event: options.emit_event,
            on_error: options.on_error,
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            ownership_lost: AtomicBool::new(false),
            ownership_timer: Mutex::new(None),
            lane_tasks: Mutex::new(HashMap::new()),
            active_entries: Mutex::new(HashMap::new()),
        })
    }

    pub async fn start(self: &Arc<Self>) -> PromptQueueServiceResult<()> {
        if self.started.load(Ordering::SeqCst) {
            return Ok(());
        }
        let claim = self.claim_ownership(now_ms())?;
        if !claim.claimed {
            return Err(PromptQueueServiceError::OwnershipHeld);
        }
        self.started.store(true, Ordering::SeqCst);
        self.stopped.store(false, Ordering::SeqCst);
        self.ownership_lost.store(false, Ordering::SeqCst);
        self.start_renewal_timer();
        self.reconcile_interrupted(claim.previous_owner_id).await?;
        if self.stopped.load(Ordering::SeqCst) || !self.is_owner() {
            return Ok(());
        }

        let mut scheduled = HashSet::new();
        for entry in self.with_store(|store| store.list_recoverable())? {
            let lane_key = entry_lane_key(&entry);
            if scheduled.insert(lane_key.clone()) {
                self.schedule_lane(lane_key);
            }
        }
        Ok(())
    }

    pub async fn stop(self: &Arc<Self>) {
        if !self.started.load(Ordering::SeqCst) {
            return;
        }
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(timer) = lock(&self.ownership_timer).take() {
            timer.abort();
        }
        let tasks = {
            let mut tasks = lock(&self.lane_tasks);
            tasks
                .drain()
                .filter_map(|(_, task)| task)
                .collect::<Vec<_>>()
        };
        for task in tasks {
            let _ = task.await;
        }
        let _ = self.release_ownership();
        self.started.store(false, Ordering::SeqCst);
    }

    pub fn enqueue(
        self: &Arc<Self>,
        input: EnqueuePromptInput,
    ) -> PromptQueueServiceResult<EnqueuePromptResult> {
        if !self.is_owner() {
            return Err(PromptQueueServiceError::NotOwner);
        }
        let result = self.with_store(|store| store.enqueue(input, now_ms()))?;
        (self.emit_snapshot)(result.entry.clone());
        self.ensure_lane_scheduled(&lane_from_entry(&result.entry));
        Ok(result)
    }

    pub fn ensure_lane_scheduled(self: &Arc<Self>, lane: &PromptQueueLane) {
        if !self.is_owner() {
            return;
        }
        let lane_key = lane_key_of(lane);
        if self
            .with_store(|store| store.list_recoverable())
            .is_ok_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry_lane_key(entry) == lane_key)
            })
        {
            self.schedule_lane(lane_key);
        }
    }

    pub fn abort_lane(&self, lane: &PromptQueueLane) -> usize {
        let lane_key = lane_key_of(lane);
        let active = lock(&self.active_entries)
            .values()
            .filter(|entry| entry_lane_key(entry) == lane_key)
            .cloned()
            .collect::<Vec<_>>();
        for entry in &active {
            self.runner.abort_run(entry);
        }
        active.len()
    }

    pub fn get_snapshot(
        &self,
        lane: &PromptQueueLane,
    ) -> PromptQueueServiceResult<Vec<PromptQueueEntry>> {
        Ok(self
            .with_store(|store| store.list_logical_lane(lane))?
            .into_iter()
            .filter(|entry| entry.status != PromptQueueStatus::Completed)
            .collect())
    }

    pub fn cancel(&self, input: CancelPromptInput) -> PromptQueueServiceResult<CancelPromptResult> {
        if !self.is_owner() {
            return Err(PromptQueueServiceError::NotOwner);
        }
        Ok(self.with_store(|store| store.cancel(input, now_ms()))?)
    }

    pub fn reconcile(
        &self,
        input: ReconcilePromptIdentitiesInput,
    ) -> PromptQueueServiceResult<Vec<PromptIdentityReconciliation>> {
        if !self.is_owner() {
            return Err(PromptQueueServiceError::NotOwner);
        }
        Ok(self.with_store(|store| store.reconcile(input))?)
    }

    /// Whether this process currently owns a running prompt for the lane.
    pub fn is_lane_active(&self, history_key: &str) -> bool {
        let history_key = history_key.trim();
        if history_key.is_empty() {
            return false;
        }
        lock(&self.active_entries)
            .values()
            .any(|entry| entry.history_key == history_key)
    }

    /// Reserve a lane for a server-owned agent turn. User prompts for the same
    /// lane remain durable but cannot start until the reservation is released.
    pub fn try_reserve_lane(&self, lane: &PromptQueueLane) -> bool {
        if !self.is_owner() {
            return false;
        }
        let lane_key = lane_key_of(lane);
        let mut tasks = lock(&self.lane_tasks);
        if tasks.contains_key(&lane_key) {
            return false;
        }
        tasks.insert(lane_key, None);
        true
    }

    pub fn release_reserved_lane(self: &Arc<Self>, lane: &PromptQueueLane) {
        let lane_key = lane_key_of(lane);
        {
            let mut tasks = lock(&self.lane_tasks);
            tasks.remove(&lane_key);
        }
        if !self.is_owner() {
            return;
        }
        let should_reschedule =
            self.with_store(|store| store.list_recoverable())
                .is_ok_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| entry_lane_key(entry) == lane_key)
                });
        if should_reschedule {
            self.schedule_lane(lane_key);
        }
    }

    pub fn is_owner(&self) -> bool {
        self.started.load(Ordering::SeqCst)
            && !self.stopped.load(Ordering::SeqCst)
            && !self.ownership_lost.load(Ordering::SeqCst)
            && self
                .with_store(|store| store.is_ownership_current(&self.worker_id, now_ms()))
                .unwrap_or(false)
    }

    fn can_write_terminal(&self) -> bool {
        self.started.load(Ordering::SeqCst)
            && !self.ownership_lost.load(Ordering::SeqCst)
            && self
                .with_store(|store| store.is_ownership_current(&self.worker_id, now_ms()))
                .unwrap_or(false)
    }

    fn claim_ownership(&self, now: i64) -> StateResult<ads_state::PromptQueueOwnershipClaim> {
        self.with_store(|store| {
            store.claim_ownership(
                &self.worker_id,
                self.owner_pid,
                now,
                DEFAULT_OWNERSHIP_LEASE_MS,
                |pid| (self.is_owner_alive)(pid),
            )
        })
    }

    fn release_ownership(&self) -> StateResult<bool> {
        self.with_store(|store| store.release_ownership(&self.worker_id))
    }

    fn start_renewal_timer(self: &Arc<Self>) {
        let service = Arc::clone(self);
        let interval = service.ownership_renewal_interval;
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if service.stopped.load(Ordering::SeqCst)
                    || service.ownership_lost.load(Ordering::SeqCst)
                {
                    return;
                }
                match service.claim_ownership(now_ms()) {
                    Ok(claim) if claim.claimed => {}
                    Ok(_) => {
                        service.lose_ownership("Prompt queue ownership renewal failed");
                        return;
                    }
                    Err(error) => {
                        // SQLite contention is transient. Keep the renewal loop alive so the
                        // same worker can extend or reacquire its lease once the write lock
                        // clears; only an explicit competing owner ends this service.
                        service.report_error(format!(
                            "Prompt queue ownership renewal delayed: {error}"
                        ));
                    }
                }
            }
        });
        *lock(&self.ownership_timer) = Some(handle);
    }

    fn schedule_lane(self: &Arc<Self>, lane_key: String) {
        if !self.is_owner() {
            return;
        }
        {
            let mut tasks = lock(&self.lane_tasks);
            if tasks.contains_key(&lane_key) {
                return;
            }
            tasks.insert(lane_key.clone(), None);
        }
        let service = Arc::clone(self);
        let task_lane_key = lane_key.clone();
        let handle = tokio::spawn(async move {
            if let Err(error) = service.drain_lane(&task_lane_key).await {
                service.report_error(error.to_string());
            }
            service.finish_lane(&task_lane_key);
        });
        let mut tasks = lock(&self.lane_tasks);
        if let Some(slot) = tasks.get_mut(&lane_key) {
            *slot = Some(handle);
        }
    }

    fn finish_lane(self: &Arc<Self>, lane_key: &str) {
        lock(&self.lane_tasks).remove(lane_key);
        if !self.is_owner() {
            return;
        }
        let should_reschedule =
            self.with_store(|store| store.list_recoverable())
                .is_ok_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| entry_lane_key(entry) == lane_key)
                });
        if should_reschedule {
            self.schedule_lane(lane_key.to_string());
        }
    }

    async fn drain_lane(&self, lane_key: &str) -> PromptQueueServiceResult<()> {
        while self.is_owner() {
            let next = self
                .with_store(|store| store.list_recoverable())?
                .into_iter()
                .find(|entry| entry_lane_key(entry) == lane_key);
            let Some(next) = next else {
                return Ok(());
            };
            let current_generation = (self.resolve_current_generation)(&next);
            if current_generation != next.lane_generation {
                if self.with_store(|store| {
                    store.mark_failed(
                        next.id,
                        "Lane generation changed before execution",
                        &self.worker_id,
                        now_ms(),
                    )
                })? {
                    self.emit_latest(&next);
                }
                continue;
            }
            if !self.with_store(|store| {
                store.mark_running(
                    next.id,
                    &self.worker_id,
                    now_ms(),
                    DEFAULT_OWNERSHIP_LEASE_MS,
                )
            })? {
                continue;
            }
            let running = self
                .with_store(|store| store.get_by_client_message_id(&next.client_message_id))?
                .unwrap_or_else(|| next.clone());
            lock(&self.active_entries).insert(running.id, running.clone());
            (self.emit_snapshot)(running.clone());

            let outcome = match self.runner.reconcile_before_run(&running).await {
                Ok(reconciled) => match reconciled {
                    Some(outcome) => Ok(outcome),
                    None => {
                        let emit = Arc::clone(&self.emit_event);
                        let emitted_entry = running.clone();
                        let context = PromptRunContext::new(Arc::new(move |payload| {
                            emit(&emitted_entry, payload);
                        }));
                        self.runner.run_prompt(running.clone(), context).await
                    }
                },
                Err(error) => Err(error),
            };
            if !self.can_write_terminal() {
                lock(&self.active_entries).remove(&running.id);
                return Ok(());
            }
            let terminal_changed = match outcome {
                Ok(outcome) if outcome.ok => self.with_store(|store| {
                    store.mark_completed(running.id, &self.worker_id, now_ms())
                }),
                Ok(outcome) => self.with_store(|store| {
                    store.mark_failed(
                        running.id,
                        outcome
                            .error
                            .unwrap_or_else(|| "Prompt execution failed".to_string()),
                        &self.worker_id,
                        now_ms(),
                    )
                }),
                Err(error) => {
                    self.report_error(error.to_string());
                    self.with_store(|store| {
                        store.mark_failed(running.id, error.to_string(), &self.worker_id, now_ms())
                    })
                }
            };
            lock(&self.active_entries).remove(&running.id);
            if terminal_changed? {
                self.emit_latest(&running);
            }
        }
        Ok(())
    }

    async fn reconcile_interrupted(
        &self,
        previous_owner_id: Option<String>,
    ) -> PromptQueueServiceResult<()> {
        for entry in
            self.with_store(|store| store.list_interrupted(previous_owner_id.as_deref(), now_ms()))?
        {
            if !self.is_owner() {
                return Ok(());
            }
            let reconciled = self.runner.reconcile_before_run(&entry).await;
            let (outcome, reconciliation_error) = match reconciled {
                Ok(outcome) => (outcome, None),
                Err(error) => (None, Some(error.to_string())),
            };
            if !self.can_write_terminal() {
                return Ok(());
            }
            let changed = if outcome.as_ref().is_some_and(|outcome| outcome.ok) {
                self.with_store(|store| {
                    store.complete_interrupted(
                        entry.id,
                        &self.worker_id,
                        previous_owner_id.as_deref(),
                        now_ms(),
                    )
                })?
            } else {
                let message = reconciliation_error
                    .clone()
                    .or_else(|| outcome.and_then(|outcome| outcome.error))
                    .unwrap_or_else(|| INTERRUPTED_PROMPT_ERROR.to_string());
                if let Some(error) = reconciliation_error.as_ref() {
                    self.report_error(error.clone());
                }
                self.with_store(|store| {
                    store.fail_interrupted(
                        entry.id,
                        &self.worker_id,
                        previous_owner_id.as_deref(),
                        message,
                        now_ms(),
                    )
                })?
            };
            if changed {
                self.emit_latest(&entry);
            }
        }
        Ok(())
    }

    fn emit_latest(&self, fallback: &PromptQueueEntry) {
        let entry = self
            .with_store(|store| store.get_by_client_message_id(&fallback.client_message_id))
            .ok()
            .flatten()
            .unwrap_or_else(|| fallback.clone());
        (self.emit_snapshot)(entry);
    }

    fn lose_ownership(&self, message: &str) {
        if self.ownership_lost.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(timer) = lock(&self.ownership_timer).take() {
            timer.abort();
        }
        let active = lock(&self.active_entries)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in active {
            self.runner.abort_run(&entry);
        }
        self.report_error(message.to_string());
    }

    fn report_error(&self, message: String) {
        if let Some(on_error) = &self.on_error {
            on_error(message);
        }
    }

    fn with_store<T>(
        &self,
        operation: impl FnOnce(&PromptQueueStore<'_>) -> StateResult<T>,
    ) -> StateResult<T> {
        let connection = self.store.connect()?;
        let store = PromptQueueStore::new(&connection)?;
        operation(&store)
    }
}

fn entry_lane_key(entry: &PromptQueueEntry) -> String {
    lane_key_from_parts(
        &entry.auth_user_id,
        &entry.session_id,
        &entry.chat_session_id,
        &entry.logical_history_key,
        entry.lane_generation,
    )
}

fn lane_from_entry(entry: &PromptQueueEntry) -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: entry.auth_user_id.clone(),
        session_id: entry.session_id.clone(),
        chat_session_id: entry.chat_session_id.clone(),
        history_key: entry.history_key.clone(),
        logical_history_key: entry.logical_history_key.clone(),
        lane_namespace: entry.lane_namespace.clone(),
        lane_generation: entry.lane_generation,
    }
}

fn lane_key_of(lane: &PromptQueueLane) -> String {
    lane_key_from_parts(
        &lane.auth_user_id,
        &lane.session_id,
        &lane.chat_session_id,
        &lane.logical_history_key,
        lane.lane_generation,
    )
}

fn lane_key_from_parts(
    auth_user_id: &str,
    session_id: &str,
    chat_session_id: &str,
    logical_history_key: &str,
    lane_generation: i64,
) -> String {
    serde_json::json!([
        auth_user_id,
        session_id,
        chat_session_id,
        logical_history_key,
        lane_generation,
    ])
    .to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
