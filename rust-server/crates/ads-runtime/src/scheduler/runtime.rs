use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_contract::schedule::DeliveryChannel;
use ads_contract::time::now_unix_millis;
use ads_state::{
    InsertScheduleRun, ScheduleRunStatus, ScheduleStore, StateResult, StoredSchedule,
    UpdateSchedule, UpdateScheduleRun, WorkspaceDb, derive_workspace_state_id,
};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

use super::queue::{SchedulerQueue, has_queued_jobs, liteque_db_path, queue_name_for_workspace};
use super::{compute_next_cron_run_at, normalize_questions};

pub type ScheduleExecuteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct SchedulerJobPayload {
    pub workspace_root: String,
    pub schedule_id: String,
    pub external_id: String,
    pub run_at: i64,
    pub prompt: Option<String>,
}

impl SchedulerJobPayload {
    pub fn parse(value: &Value) -> Option<Self> {
        let record = value.as_object()?;
        let workspace_root = record
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .map(normalize_workspace_root)
            .filter(|value| !value.is_empty())?;
        let schedule_id = record
            .get("scheduleId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_string();
        let external_id = record
            .get("externalId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_string();
        let run_at = record.get("runAt").and_then(Value::as_i64)?;
        let prompt = record
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_string);
        Some(Self {
            workspace_root,
            schedule_id,
            external_id,
            run_at,
            prompt,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueJobPayload {
    workspace_root: String,
    schedule_id: String,
    external_id: String,
    run_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

impl From<&SchedulerJobPayload> for QueueJobPayload {
    fn from(payload: &SchedulerJobPayload) -> Self {
        Self {
            workspace_root: payload.workspace_root.clone(),
            schedule_id: payload.schedule_id.clone(),
            external_id: payload.external_id.clone(),
            run_at: payload.run_at,
            prompt: payload.prompt.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SchedulerExecutionInput {
    pub workspace_root: String,
    pub owner: String,
    pub schedule: StoredSchedule,
    pub payload: SchedulerJobPayload,
    pub prompt: String,
    pub task_id: String,
    pub task_title: String,
}

pub trait ScheduleExecutor: Send + Sync {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a>;
}

#[derive(Debug, Clone)]
pub struct ScheduleTerminalEvent {
    pub task_id: String,
    pub title: String,
    pub status: &'static str,
    pub workspace_root: String,
    pub started_at: Option<i64>,
    pub completed_at: i64,
    pub result: Option<String>,
    pub event_ts: i64,
    pub telegram_chat_id: Option<String>,
}

pub trait ScheduleNotifier: Send + Sync {
    fn notify(&self, event: ScheduleTerminalEvent);
}

pub struct SchedulerRuntimeOptions {
    pub workspace_db: Arc<WorkspaceDb>,
    pub executor: Arc<dyn ScheduleExecutor>,
    pub notifier: Option<Arc<dyn ScheduleNotifier>>,
    pub enabled: bool,
    pub tick_ms: u64,
    pub idle_recycle_ms: i64,
    pub lease_ttl_ms: i64,
    pub due_limit: i64,
    pub owner_id: String,
    pub runner_poll_ms: u64,
    pub runner_timeout_secs: i64,
    pub runner_concurrency: usize,
    pub schedule_owner: String,
    pub queue_db_path_override: Option<PathBuf>,
}

impl SchedulerRuntimeOptions {
    pub fn new(workspace_db: Arc<WorkspaceDb>, executor: Arc<dyn ScheduleExecutor>) -> Self {
        Self {
            workspace_db,
            executor,
            notifier: None,
            enabled: env_bool("ADS_SCHEDULER_ENABLED", true),
            tick_ms: env_positive_u64("ADS_SCHEDULER_TICK_MS", 5_000),
            idle_recycle_ms: env_non_negative_i64("ADS_SCHEDULER_IDLE_RECYCLE_MS", 300_000),
            lease_ttl_ms: env_positive_i64("ADS_SCHEDULER_LEASE_TTL_MS", 30_000),
            due_limit: env_positive_i64("ADS_SCHEDULER_DUE_LIMIT", 20),
            owner_id: uuid::Uuid::new_v4().to_string(),
            runner_poll_ms: env_positive_u64("ADS_SCHEDULER_RUNNER_POLL_MS", 1_000),
            runner_timeout_secs: env_positive_i64("ADS_SCHEDULER_RUNNER_TIMEOUT_SECS", 1_800),
            runner_concurrency: env_positive_usize("ADS_SCHEDULER_RUNNER_CONCURRENCY", 1),
            schedule_owner: std::env::var("ADS_SCHEDULER_OWNER")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "scheduler".to_string()),
            queue_db_path_override: None,
        }
    }

    pub fn with_notifier(mut self, notifier: Arc<dyn ScheduleNotifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }
}

struct WorkspaceSchedulerState {
    workspace_root: String,
    workspace_id: String,
    queue: SchedulerQueue,
    last_touched_ms: AtomicI64,
    runner_running: AtomicBool,
    runner_task: Mutex<Option<JoinHandle<()>>>,
}

impl WorkspaceSchedulerState {
    fn touch(&self) {
        self.last_touched_ms
            .store(now_unix_millis(), Ordering::Relaxed);
    }
}

pub struct SchedulerRuntime {
    options: SchedulerRuntimeOptions,
    workspaces: Mutex<HashSet<String>>,
    states: Mutex<HashMap<String, Arc<WorkspaceSchedulerState>>>,
    in_flight: Mutex<HashSet<String>>,
    stopping: AtomicBool,
    started: AtomicBool,
    tick_task: Mutex<Option<JoinHandle<()>>>,
}

impl SchedulerRuntime {
    pub fn new(options: SchedulerRuntimeOptions) -> Arc<Self> {
        Arc::new(Self {
            options,
            workspaces: Mutex::new(HashSet::new()),
            states: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashSet::new()),
            stopping: AtomicBool::new(false),
            started: AtomicBool::new(false),
            tick_task: Mutex::new(None),
        })
    }

    pub fn enabled(&self) -> bool {
        self.options.enabled
    }

    pub fn register_workspace(self: &Arc<Self>, workspace_root: &str) {
        let normalized = normalize_workspace_root(workspace_root);
        if normalized.is_empty() {
            return;
        }
        let inserted = self
            .workspaces
            .lock()
            .expect("scheduler workspaces")
            .insert(normalized.clone());
        if inserted && self.started.load(Ordering::Relaxed) && self.options.enabled {
            let runtime = Arc::clone(self);
            tokio::spawn(async move {
                runtime.tick_workspace(&normalized).await;
            });
        }
    }

    pub fn start(self: &Arc<Self>) {
        if !self.options.enabled || self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let runtime = Arc::clone(self);
        let handle = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(runtime.options.tick_ms.max(1)));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if runtime.stopping.load(Ordering::Relaxed) {
                    break;
                }
                runtime.tick_all().await;
                runtime.recycle_idle_states();
            }
        });
        *self.tick_task.lock().expect("scheduler tick task") = Some(handle);
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(handle) = self.tick_task.lock().expect("scheduler tick task").take() {
            handle.abort();
        }
        let states = self.states.lock().expect("scheduler states").clone();
        for state in states.values() {
            if let Some(handle) = state.runner_task.lock().expect("scheduler runner").take() {
                handle.abort();
            }
        }
    }

    pub async fn tick_workspace(self: &Arc<Self>, workspace_root: &str) {
        let root = normalize_workspace_root(workspace_root);
        if root.is_empty() {
            return;
        }
        {
            let mut in_flight = self.in_flight.lock().expect("scheduler in-flight");
            if !in_flight.insert(root.clone()) {
                return;
            }
        }

        if let Err(error) = self.tick_workspace_inner(&root).await {
            self.warn("tick-workspace", &root, "n/a", None, &error.to_string());
        }

        self.in_flight
            .lock()
            .expect("scheduler in-flight")
            .remove(&root);
    }

    async fn tick_all(self: &Arc<Self>) {
        let workspaces = self
            .workspaces
            .lock()
            .expect("scheduler workspaces")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        for workspace_root in workspaces {
            self.tick_workspace(&workspace_root).await;
        }
    }

    async fn tick_workspace_inner(self: &Arc<Self>, workspace_root: &str) -> StateResult<()> {
        let now = now_unix_millis();
        if !self.workspace_needs_materialization(workspace_root, now)? {
            return Ok(());
        }
        let state = self.get_state(workspace_root)?;

        let due_ids = self.with_store(&state, |store| {
            store.list_due_schedule_ids(now, Some(self.options.due_limit))
        })?;
        for schedule_id in due_ids {
            let claimed = self.with_store(&state, |store| {
                store.claim_schedule_lease(
                    &schedule_id,
                    &self.options.owner_id,
                    now + self.options.lease_ttl_ms,
                    now,
                )
            })?;
            if !claimed {
                continue;
            }
            if let Err(error) = self.trigger_schedule_run(&state, &schedule_id, now) {
                self.warn(
                    "trigger-schedule",
                    workspace_root,
                    &schedule_id,
                    None,
                    &error.to_string(),
                );
            }
            if let Err(error) = self.with_store(&state, |store| {
                store.release_schedule_lease(
                    &schedule_id,
                    Some(&self.options.owner_id),
                    now_unix_millis(),
                )
            }) {
                self.warn(
                    "release-lease",
                    workspace_root,
                    &schedule_id,
                    None,
                    &error.to_string(),
                );
            }
        }

        if self.options.enabled && state.queue.stats()?.has_work() {
            self.start_runner(&state);
        }
        Ok(())
    }

    fn workspace_needs_materialization(&self, workspace_root: &str, now: i64) -> StateResult<bool> {
        if self
            .states
            .lock()
            .expect("scheduler states")
            .contains_key(workspace_root)
        {
            return Ok(true);
        }
        let workspace_id = derive_workspace_state_id(workspace_root);
        let connection = self.options.workspace_db.connect()?;
        let due =
            ScheduleStore::new(&connection, &workspace_id).list_due_schedule_ids(now, Some(1))?;
        if !due.is_empty() {
            return Ok(true);
        }
        Ok(has_queued_jobs(
            &self.queue_path(workspace_root),
            &queue_name_for_workspace(workspace_root),
        ))
    }

    fn recycle_idle_states(&self) {
        if self.options.idle_recycle_ms <= 0 {
            return;
        }
        let now = now_unix_millis();
        let states = self
            .states
            .lock()
            .expect("scheduler states")
            .iter()
            .map(|(key, state)| (key.clone(), Arc::clone(state)))
            .collect::<Vec<_>>();
        for (workspace_root, state) in states {
            if state.runner_running.load(Ordering::Relaxed) {
                continue;
            }
            if now - state.last_touched_ms.load(Ordering::Relaxed) < self.options.idle_recycle_ms {
                continue;
            }
            if has_queued_jobs(state.queue.path(), state.queue.name()) {
                continue;
            }
            self.states
                .lock()
                .expect("scheduler states")
                .remove(&workspace_root);
        }
    }

    fn get_state(&self, workspace_root: &str) -> StateResult<Arc<WorkspaceSchedulerState>> {
        if let Some(existing) = self
            .states
            .lock()
            .expect("scheduler states")
            .get(workspace_root)
            .cloned()
        {
            existing.touch();
            return Ok(existing);
        }

        let queue = SchedulerQueue::open(
            self.queue_path(workspace_root),
            queue_name_for_workspace(workspace_root),
        )?;
        let state = Arc::new(WorkspaceSchedulerState {
            workspace_root: workspace_root.to_string(),
            workspace_id: derive_workspace_state_id(workspace_root),
            queue,
            last_touched_ms: AtomicI64::new(now_unix_millis()),
            runner_running: AtomicBool::new(false),
            runner_task: Mutex::new(None),
        });
        self.states
            .lock()
            .expect("scheduler states")
            .insert(workspace_root.to_string(), Arc::clone(&state));
        Ok(state)
    }

    fn queue_path(&self, workspace_root: &str) -> PathBuf {
        self.options
            .queue_db_path_override
            .clone()
            .unwrap_or_else(|| liteque_db_path(workspace_root))
    }

    fn with_store<T>(
        &self,
        state: &WorkspaceSchedulerState,
        operation: impl FnOnce(ScheduleStore<'_>) -> StateResult<T>,
    ) -> StateResult<T> {
        let connection = self.options.workspace_db.connect()?;
        operation(ScheduleStore::new(&connection, &state.workspace_id))
    }

    fn trigger_schedule_run(
        &self,
        state: &WorkspaceSchedulerState,
        schedule_id: &str,
        now: i64,
    ) -> StateResult<()> {
        let Some(schedule) = self.with_store(state, |store| store.get_schedule(schedule_id))?
        else {
            return Ok(());
        };
        if !schedule.enabled {
            return Ok(());
        }
        let Some(run_at) = schedule.next_run_at else {
            return Ok(());
        };
        let external_id = build_external_id(&schedule, run_at);
        let existing =
            self.with_store(state, |store| store.get_run_by_external_id(&external_id))?;
        let terminal = existing.as_ref().is_some_and(|run| {
            matches!(
                run.status,
                ScheduleRunStatus::Completed
                    | ScheduleRunStatus::Failed
                    | ScheduleRunStatus::Cancelled
            )
        });

        if !terminal {
            if existing.is_none() {
                self.with_store(state, |store| {
                    store.insert_run(
                        InsertScheduleRun {
                            schedule_id: schedule.id.clone(),
                            external_id: external_id.clone(),
                            run_at,
                            task_id: None,
                            status: ScheduleRunStatus::Queued,
                        },
                        now,
                    )
                })?;
            }
            let payload = SchedulerJobPayload {
                workspace_root: state.workspace_root.clone(),
                schedule_id: schedule.id.clone(),
                external_id: external_id.clone(),
                run_at,
                prompt: None,
            };
            let prompt = build_effective_task_prompt(&payload, &schedule);
            let queued = QueueJobPayload {
                prompt: Some(prompt),
                ..QueueJobPayload::from(&payload)
            };
            let payload_json = serde_json::to_string(&queued)?;
            state.queue.enqueue(
                &payload_json,
                schedule.spec.policy.max_retries.max(0),
                &external_id,
                now,
            )?;
        }

        match compute_next_cron_run_at(
            &schedule.spec.schedule.cron,
            &schedule.spec.schedule.timezone,
            run_at,
        ) {
            Ok(next_run_at) => {
                self.with_store(state, |store| {
                    store.update_schedule(
                        &schedule.id,
                        UpdateSchedule {
                            next_run_at: Some(Some(next_run_at)),
                            lease_owner: Some(None),
                            lease_until: Some(None),
                            ..UpdateSchedule::default()
                        },
                        now,
                    )
                })?;
            }
            Err(error) => {
                self.warn(
                    "compute-next-run",
                    &state.workspace_root,
                    &schedule.id,
                    Some(&external_id),
                    &error,
                );
                let mut spec = schedule.spec.clone();
                spec.enabled = false;
                let mut questions = spec.questions.clone();
                questions.push(format!(
                    "Cron expression is not supported by runtime: {}",
                    spec.schedule.cron.trim()
                ));
                spec.questions = normalize_questions(&questions);
                self.with_store(state, |store| {
                    store.update_schedule(
                        &schedule.id,
                        UpdateSchedule {
                            spec: Some(spec),
                            enabled: Some(false),
                            next_run_at: Some(None),
                            lease_owner: Some(None),
                            lease_until: Some(None),
                            ..UpdateSchedule::default()
                        },
                        now,
                    )
                })?;
            }
        }
        Ok(())
    }

    fn start_runner(self: &Arc<Self>, state: &Arc<WorkspaceSchedulerState>) {
        if state.runner_running.swap(true, Ordering::SeqCst) {
            return;
        }
        state.touch();
        let runtime = Arc::clone(self);
        let runner_state = Arc::clone(state);
        let handle = tokio::spawn(async move {
            runtime.run_runner(&runner_state).await;
            runner_state.touch();
            runner_state.runner_running.store(false, Ordering::SeqCst);
        });
        *state.runner_task.lock().expect("scheduler runner") = Some(handle);
    }

    async fn run_runner(self: &Arc<Self>, state: &Arc<WorkspaceSchedulerState>) {
        let semaphore = Arc::new(Semaphore::new(self.options.runner_concurrency.max(1)));
        let mut in_flight = JoinSet::new();

        loop {
            if self.stopping.load(Ordering::Relaxed) {
                break;
            }
            let permit = match Arc::clone(&semaphore).acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => break,
            };
            match state
                .queue
                .attempt_dequeue(self.options.runner_timeout_secs)
            {
                Ok(Some(job)) => {
                    let runtime = Arc::clone(self);
                    let job_state = Arc::clone(state);
                    in_flight.spawn(async move {
                        runtime.execute_job(job_state, job).await;
                        drop(permit);
                    });
                }
                Ok(None) => {
                    drop(permit);
                    if !in_flight.is_empty() {
                        tokio::time::sleep(Duration::from_millis(
                            self.options.runner_poll_ms.max(1),
                        ))
                        .await;
                        drain_finished(&mut in_flight, &state.workspace_root);
                        continue;
                    }
                    let stats = state.queue.stats().unwrap_or_default();
                    if stats.pending + stats.pending_retry > 0 {
                        tokio::time::sleep(Duration::from_millis(
                            self.options.runner_poll_ms.max(1),
                        ))
                        .await;
                        continue;
                    }
                    break;
                }
                Err(error) => {
                    drop(permit);
                    self.warn(
                        "runner-crash",
                        &state.workspace_root,
                        "n/a",
                        None,
                        &error.to_string(),
                    );
                    break;
                }
            }
            drain_finished(&mut in_flight, &state.workspace_root);
        }

        while let Some(result) = in_flight.join_next().await {
            if let Err(error) = result {
                self.warn(
                    "runner-job",
                    &state.workspace_root,
                    "n/a",
                    None,
                    &error.to_string(),
                );
            }
        }
    }

    async fn execute_job(
        self: &Arc<Self>,
        state: Arc<WorkspaceSchedulerState>,
        job: super::queue::DequeuedJob,
    ) {
        let payload_value = match serde_json::from_str::<Value>(&job.payload) {
            Ok(value) => value,
            Err(error) => {
                self.warn(
                    "parse-job-payload",
                    &state.workspace_root,
                    "n/a",
                    None,
                    &error.to_string(),
                );
                self.finalize_job(&state, &job);
                return;
            }
        };
        let Some(payload) = SchedulerJobPayload::parse(&payload_value) else {
            self.warn(
                "parse-job-payload",
                &state.workspace_root,
                "n/a",
                None,
                "Scheduler job payload is invalid",
            );
            self.finalize_job(&state, &job);
            return;
        };

        let timeout = Duration::from_secs(self.options.runner_timeout_secs.max(1) as u64);
        let outcome = tokio::time::timeout(timeout, self.run_scheduled_job(&state, &payload)).await;
        match outcome {
            Ok(Ok(summary)) => {
                self.handle_job_complete(&state, &payload, &summary).await;
                let _ = state.queue.finalize(
                    job.id,
                    &job.allocation_id,
                    "completed",
                    now_unix_millis(),
                    false,
                );
            }
            Ok(Err(error)) => {
                self.handle_job_error(&state, &payload, &error, job.num_runs_left)
                    .await;
                self.finalize_job(&state, &job);
            }
            Err(_) => {
                self.handle_job_error(&state, &payload, "Timeout", job.num_runs_left)
                    .await;
                self.finalize_job(&state, &job);
            }
        }
    }

    fn finalize_job(&self, state: &WorkspaceSchedulerState, job: &super::queue::DequeuedJob) {
        let status = if job.num_runs_left <= 0 {
            "failed"
        } else {
            "pending_retry"
        };
        if let Err(error) =
            state
                .queue
                .finalize(job.id, &job.allocation_id, status, now_unix_millis(), false)
        {
            self.warn(
                "finalize-job",
                &state.workspace_root,
                "n/a",
                None,
                &error.to_string(),
            );
        }
    }

    async fn run_scheduled_job(
        &self,
        state: &WorkspaceSchedulerState,
        payload: &SchedulerJobPayload,
    ) -> Result<String, String> {
        let now = now_unix_millis();
        let schedule = self
            .with_store(state, |store| store.get_schedule(&payload.schedule_id))
            .map_err(|error| error.to_string())?;
        let Some(schedule) = schedule else {
            if let Err(error) = self.with_store(state, |store| {
                store.update_run_by_external_id(
                    &payload.external_id,
                    UpdateScheduleRun {
                        status: Some(ScheduleRunStatus::Cancelled),
                        error: Some(Some("Schedule not found".to_string())),
                        completed_at: Some(Some(now)),
                        ..UpdateScheduleRun::default()
                    },
                    now,
                )
            }) {
                self.warn(
                    "mark-run-cancelled",
                    &payload.workspace_root,
                    &payload.schedule_id,
                    Some(&payload.external_id),
                    &error.to_string(),
                );
            }
            return Ok(String::new());
        };
        if !schedule.enabled {
            if let Err(error) = self.with_store(state, |store| {
                store.update_run_by_external_id(
                    &payload.external_id,
                    UpdateScheduleRun {
                        status: Some(ScheduleRunStatus::Cancelled),
                        error: Some(Some("Schedule is disabled".to_string())),
                        completed_at: Some(Some(now)),
                        ..UpdateScheduleRun::default()
                    },
                    now,
                )
            }) {
                self.warn(
                    "mark-run-cancelled",
                    &payload.workspace_root,
                    &payload.schedule_id,
                    Some(&payload.external_id),
                    &error.to_string(),
                );
            }
            return Ok(String::new());
        }

        let current_run = self
            .with_store(state, |store| {
                store.get_run_by_external_id(&payload.external_id)
            })
            .map_err(|error| error.to_string())?;
        if let Some(run) = current_run.as_ref()
            && matches!(
                run.status,
                ScheduleRunStatus::Completed | ScheduleRunStatus::Cancelled
            )
        {
            return Ok(run.result.clone().unwrap_or_default());
        }

        if let Err(error) = self.with_store(state, |store| {
            store.update_run_by_external_id(
                &payload.external_id,
                UpdateScheduleRun {
                    status: Some(ScheduleRunStatus::Running),
                    error: Some(None),
                    started_at: Some(Some(now)),
                    completed_at: Some(None),
                    ..UpdateScheduleRun::default()
                },
                now,
            )
        }) {
            self.warn(
                "mark-run-running",
                &payload.workspace_root,
                &payload.schedule_id,
                Some(&payload.external_id),
                &error.to_string(),
            );
        }

        if schedule_requests_telegram(&schedule) && self.options.notifier.is_none() {
            self.warn(
                "bind-task-telegram",
                &payload.workspace_root,
                &payload.schedule_id,
                Some(&payload.external_id),
                "Telegram delivery unavailable: connector is not implemented in the Rust runtime",
            );
        }

        let effective_prompt = payload
            .prompt
            .clone()
            .unwrap_or_else(|| build_effective_task_prompt(payload, &schedule));
        let task_title = schedule.spec.compiled_task.title.clone();
        self.options
            .executor
            .execute(SchedulerExecutionInput {
                workspace_root: payload.workspace_root.clone(),
                owner: self.options.schedule_owner.clone(),
                schedule,
                payload: payload.clone(),
                prompt: effective_prompt,
                task_id: payload.external_id.clone(),
                task_title,
            })
            .await
    }

    async fn handle_job_complete(
        &self,
        state: &WorkspaceSchedulerState,
        payload: &SchedulerJobPayload,
        summary: &str,
    ) {
        let now = now_unix_millis();
        let result_summary = {
            let trimmed = summary.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };
        let schedule = self
            .with_store(state, |store| store.get_schedule(&payload.schedule_id))
            .ok()
            .flatten();
        let current_run = self
            .with_store(state, |store| {
                store.get_run_by_external_id(&payload.external_id)
            })
            .ok()
            .flatten();

        if let Err(error) = self.with_store(state, |store| {
            store.update_run_by_external_id(
                &payload.external_id,
                UpdateScheduleRun {
                    status: Some(ScheduleRunStatus::Completed),
                    result: Some(result_summary.clone()),
                    error: Some(None),
                    completed_at: Some(Some(now)),
                    ..UpdateScheduleRun::default()
                },
                now,
            )
        }) {
            self.warn(
                "mark-run-completed",
                &payload.workspace_root,
                &payload.schedule_id,
                Some(&payload.external_id),
                &error.to_string(),
            );
        }

        if let Some(schedule) = schedule.as_ref()
            && schedule_requests_telegram(schedule)
        {
            self.notify_terminal(
                "notify-telegram-completed",
                &payload.schedule_id,
                ScheduleTerminalEvent {
                    task_id: payload.external_id.clone(),
                    title: schedule.spec.compiled_task.title.clone(),
                    status: "completed",
                    workspace_root: payload.workspace_root.clone(),
                    started_at: current_run.as_ref().and_then(|run| run.started_at),
                    completed_at: now,
                    result: result_summary,
                    event_ts: now,
                    telegram_chat_id: resolve_schedule_telegram_chat_id(schedule),
                },
            );
        }
    }

    async fn handle_job_error(
        &self,
        state: &WorkspaceSchedulerState,
        payload: &SchedulerJobPayload,
        error: &str,
        num_retries_left: i64,
    ) {
        let now = now_unix_millis();
        let terminal = num_retries_left <= 0;
        let schedule = self
            .with_store(state, |store| store.get_schedule(&payload.schedule_id))
            .ok()
            .flatten();
        let current_run = self
            .with_store(state, |store| {
                store.get_run_by_external_id(&payload.external_id)
            })
            .ok()
            .flatten();

        let status = if terminal {
            ScheduleRunStatus::Failed
        } else {
            ScheduleRunStatus::Queued
        };
        if let Err(persist_error) = self.with_store(state, |store| {
            store.update_run_by_external_id(
                &payload.external_id,
                UpdateScheduleRun {
                    status: Some(status),
                    error: Some(Some(error.to_string())),
                    completed_at: Some(terminal.then_some(now)),
                    ..UpdateScheduleRun::default()
                },
                now,
            )
        }) {
            let stage = if terminal {
                "mark-run-failed"
            } else {
                "mark-run-queued"
            };
            self.warn(
                stage,
                &payload.workspace_root,
                &payload.schedule_id,
                Some(&payload.external_id),
                &persist_error.to_string(),
            );
        }

        if terminal
            && let Some(schedule) = schedule.as_ref()
            && schedule_requests_telegram(schedule)
        {
            self.notify_terminal(
                "notify-telegram-failed",
                &payload.schedule_id,
                ScheduleTerminalEvent {
                    task_id: payload.external_id.clone(),
                    title: schedule.spec.compiled_task.title.clone(),
                    status: "failed",
                    workspace_root: payload.workspace_root.clone(),
                    started_at: current_run.as_ref().and_then(|run| run.started_at),
                    completed_at: now,
                    result: Some(format!("[Failed]\n{error}")),
                    event_ts: now,
                    telegram_chat_id: resolve_schedule_telegram_chat_id(schedule),
                },
            );
        }
    }

    fn notify_terminal(&self, stage: &str, schedule_id: &str, event: ScheduleTerminalEvent) {
        let Some(notifier) = self.options.notifier.as_ref() else {
            self.warn(
                stage,
                &event.workspace_root,
                schedule_id,
                Some(&event.task_id),
                "Telegram delivery unavailable: connector is not implemented in the Rust runtime",
            );
            return;
        };
        notifier.notify(event);
    }

    fn warn(
        &self,
        stage: &str,
        workspace_root: &str,
        schedule_id: &str,
        external_id: Option<&str>,
        error: &str,
    ) {
        let mut message = format!(
            "[scheduler] stage={stage} workspaceRoot={workspace_root} scheduleId={schedule_id}"
        );
        if let Some(external_id) = external_id {
            message.push_str(&format!(" externalId={external_id}"));
        }
        message.push_str(&format!(" err={error}"));
        eprintln!("{message}");
    }
}

fn drain_finished(in_flight: &mut JoinSet<()>, workspace_root: &str) {
    while let Some(result) = in_flight.try_join_next() {
        if let Err(error) = result {
            eprintln!("[scheduler] stage=runner-job workspaceRoot={workspace_root} err={error}");
        }
    }
}

pub fn build_effective_task_prompt(
    payload: &SchedulerJobPayload,
    schedule: &StoredSchedule,
) -> String {
    let run_at_iso = format_iso_millis(payload.run_at);
    let timezone = {
        let value = schedule.spec.schedule.timezone.trim();
        if value.is_empty() { "UTC" } else { value }
    };
    [
        "Scheduler runtime context:".to_string(),
        format!("- scheduleId: {}", schedule.id),
        format!("- externalId: {}", payload.external_id),
        format!("- runAtIso: {run_at_iso}"),
        format!("- runAtMs: {}", payload.run_at),
        format!("- timezone: {timezone}"),
        format!("- idempotencyKey: {}", payload.external_id),
        String::new(),
        "Use the trigger values above as authoritative for this run.".to_string(),
        "Do not ask the user for missing schedule trigger metadata when it is provided here."
            .to_string(),
        String::new(),
        schedule.spec.compiled_task.prompt.clone(),
    ]
    .join("\n")
}

pub fn build_external_id(schedule: &StoredSchedule, run_at_ms: i64) -> String {
    render_idempotency_key(
        &schedule.spec.policy.idempotency_key_template,
        &schedule.id,
        &format_iso_millis(run_at_ms),
    )
}

pub fn render_idempotency_key(template: &str, schedule_id: &str, run_at_iso: &str) -> String {
    let normalized = template.trim();
    if normalized.is_empty() {
        return format!("sch:{schedule_id}:{run_at_iso}");
    }
    let rendered = normalized
        .replace("{scheduleId}", schedule_id)
        .replace("{runAtIso}", run_at_iso);
    if rendered.is_empty() {
        format!("sch:{schedule_id}:{run_at_iso}")
    } else {
        rendered
    }
}

pub fn format_iso_millis(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

pub fn schedule_requests_telegram(schedule: &StoredSchedule) -> bool {
    schedule
        .spec
        .delivery
        .channels
        .contains(&DeliveryChannel::Telegram)
}

pub fn resolve_schedule_telegram_chat_id(schedule: &StoredSchedule) -> Option<String> {
    match schedule.spec.delivery.telegram.chat_id.as_ref() {
        Some(Some(chat_id)) => {
            let trimmed = chat_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

pub fn normalize_workspace_root(raw: &str) -> String {
    let trimmed = raw.trim();
    let path = if trimmed.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        let path = PathBuf::from(trimmed);
        if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    };
    std::fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        Err(_) => fallback,
    }
}

fn env_positive_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_positive_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_non_negative_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(fallback)
}

fn env_positive_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}
