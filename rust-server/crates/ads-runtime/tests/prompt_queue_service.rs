use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_runtime::{
    PromptQueueFuture, PromptQueueRunOutcome, PromptQueueRunner, PromptQueueService,
    PromptQueueServiceOptions, PromptRunContext,
};
use ads_state::{
    EnqueuePromptInput, PromptQueueEntry, PromptQueueLane, PromptQueueStatus, PromptQueueStore,
    StateDb, StateResult,
};
use serde_json::{Map, Value, json};
use tempfile::tempdir;
use tokio::sync::Notify;

struct FakeRunner {
    calls: Mutex<Vec<String>>,
    outcomes: Mutex<VecDeque<PromptQueueRunOutcome>>,
    reconciliations: Mutex<VecDeque<StateResult<Option<PromptQueueRunOutcome>>>>,
    aborted: Mutex<Vec<String>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    delay: Duration,
    gate: Option<Arc<Notify>>,
}

impl FakeRunner {
    fn new(delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            outcomes: Mutex::new(VecDeque::new()),
            reconciliations: Mutex::new(VecDeque::new()),
            aborted: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            delay,
            gate: None,
        })
    }

    fn gated() -> (Arc<Self>, Arc<Notify>) {
        let gate = Arc::new(Notify::new());
        let runner = Self {
            calls: Mutex::new(Vec::new()),
            outcomes: Mutex::new(VecDeque::new()),
            reconciliations: Mutex::new(VecDeque::new()),
            aborted: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            delay: Duration::ZERO,
            gate: Some(Arc::clone(&gate)),
        };
        (Arc::new(runner), gate)
    }

    fn push_outcome(&self, outcome: PromptQueueRunOutcome) {
        self.outcomes.lock().expect("outcomes").push_back(outcome);
    }

    fn push_reconciliation(&self, result: StateResult<Option<PromptQueueRunOutcome>>) {
        self.reconciliations
            .lock()
            .expect("reconciliations")
            .push_back(result);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }

    fn aborted(&self) -> Vec<String> {
        self.aborted.lock().expect("aborted").clone()
    }
}

impl PromptQueueRunner for FakeRunner {
    fn reconcile_before_run<'a>(
        &'a self,
        _entry: &'a PromptQueueEntry,
    ) -> PromptQueueFuture<'a, StateResult<Option<PromptQueueRunOutcome>>> {
        Box::pin(async move {
            self.reconciliations
                .lock()
                .expect("reconciliations")
                .pop_front()
                .unwrap_or(Ok(None))
        })
    }

    fn run_prompt<'a>(
        &'a self,
        entry: PromptQueueEntry,
        _context: PromptRunContext,
    ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("calls")
                .push(entry.client_message_id.clone());
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            let outcome = self
                .outcomes
                .lock()
                .expect("outcomes")
                .pop_front()
                .unwrap_or_else(PromptQueueRunOutcome::success);
            Ok(outcome)
        })
    }

    fn abort_run(&self, entry: &PromptQueueEntry) {
        self.aborted
            .lock()
            .expect("aborted")
            .push(entry.client_message_id.clone());
        if let Some(gate) = &self.gate {
            gate.notify_waiters();
        }
    }
}

fn lane(generation: i64) -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: "user-1".to_string(),
        session_id: "session-1".to_string(),
        chat_session_id: "main".to_string(),
        history_key: if generation > 1 {
            "user-1::session-1::main:generation:2".to_string()
        } else {
            "user-1::session-1::main".to_string()
        },
        logical_history_key: "user-1::session-1::main".to_string(),
        lane_namespace: "web-actions".to_string(),
        lane_generation: generation,
    }
}

fn payload(value: Value) -> Map<String, Value> {
    value.as_object().expect("payload object").clone()
}

fn prompt_input(id: &str, generation: i64, text: &str, now: i64) -> EnqueuePromptInput {
    EnqueuePromptInput {
        client_message_id: id.to_string(),
        lane: lane(generation),
        user_id: 42,
        workspace_root: "/work/ads".to_string(),
        payload: payload(json!({ "text": text, "images": [] })),
        retry_failed: false,
        retry_original: false,
        created_at: Some(now),
    }
}

fn service(
    db: &StateDb,
    runner: Arc<FakeRunner>,
    current_generation: Arc<AtomicI64>,
    snapshots: Arc<Mutex<Vec<PromptQueueEntry>>>,
    is_owner_alive: Option<Arc<dyn Fn(i64) -> bool + Send + Sync>>,
) -> Arc<PromptQueueService> {
    PromptQueueService::new(PromptQueueServiceOptions {
        store: db.clone(),
        worker_id: "worker-1".to_string(),
        owner_pid: Some(100),
        is_owner_alive,
        ownership_renewal_interval: Some(Duration::from_millis(10)),
        resolve_current_generation: Arc::new(move |_entry| {
            current_generation.load(Ordering::SeqCst)
        }),
        runner,
        emit_snapshot: Arc::new(move |entry| {
            snapshots.lock().expect("snapshots").push(entry);
        }),
        emit_event: Arc::new(|_, _| {}),
        on_error: Some(Arc::new(|_error| {})),
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

async fn wait_until(mut predicate: impl FnMut() -> bool, label: &str) {
    for _ in 0..300 {
        if predicate() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {label}");
}

fn entry_status(db: &StateDb, client_message_id: &str) -> Option<PromptQueueStatus> {
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    store
        .get_by_client_message_id(client_message_id)
        .expect("get entry")
        .map(|entry| entry.status)
}

#[tokio::test(flavor = "current_thread")]
async fn drains_one_lane_in_fifo_order_and_releases_ownership() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = FakeRunner::new(Duration::from_millis(5));
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(
        &db,
        Arc::clone(&runner),
        generation,
        Arc::clone(&snapshots),
        None,
    );
    service.start().await.expect("start");

    let now = now_ms();
    service
        .enqueue(prompt_input("cm-1", 1, "first", now))
        .expect("enqueue first");
    service
        .enqueue(prompt_input("cm-2", 1, "second", now + 1))
        .expect("enqueue second");

    wait_until(
        || {
            entry_status(&db, "cm-1") == Some(PromptQueueStatus::Completed)
                && entry_status(&db, "cm-2") == Some(PromptQueueStatus::Completed)
        },
        "both prompts completed",
    )
    .await;

    assert_eq!(runner.calls(), vec!["cm-1", "cm-2"]);
    assert_eq!(runner.max_active.load(Ordering::SeqCst), 1);
    let statuses = snapshots
        .lock()
        .expect("snapshots")
        .iter()
        .map(|entry| entry.status)
        .collect::<Vec<_>>();
    assert!(statuses.contains(&PromptQueueStatus::Queued));
    assert!(statuses.contains(&PromptQueueStatus::Running));
    assert!(statuses.contains(&PromptQueueStatus::Completed));
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    assert!(
        store
            .get_by_client_message_id("cm-1")
            .expect("completed entry")
            .expect("entry")
            .payload
            .is_empty()
    );

    service.stop().await;
    assert!(
        !store
            .is_ownership_current("worker-1", now_ms())
            .expect("ownership")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn agent_lane_reservation_serializes_user_prompts() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = FakeRunner::new(Duration::from_millis(1));
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(
        &db,
        Arc::clone(&runner),
        generation,
        Arc::clone(&snapshots),
        None,
    );
    service.start().await.expect("start");
    let lane = lane(1);
    assert!(service.try_reserve_lane(&lane));

    let now = now_ms();
    service
        .enqueue(prompt_input("cm-after-agent", 1, "user prompt", now))
        .expect("enqueue");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(runner.calls().is_empty());
    assert_eq!(
        entry_status(&db, "cm-after-agent"),
        Some(PromptQueueStatus::Queued)
    );

    service.release_reserved_lane(&lane);
    wait_until(
        || entry_status(&db, "cm-after-agent") == Some(PromptQueueStatus::Completed),
        "queued user prompt after agent reservation",
    )
    .await;
    assert_eq!(runner.calls(), vec!["cm-after-agent"]);
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn generation_mismatch_fails_without_running_the_prompt() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = FakeRunner::new(Duration::ZERO);
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(
        &db,
        Arc::clone(&runner),
        generation.clone(),
        snapshots,
        None,
    );
    service.start().await.expect("start");
    generation.store(2, Ordering::SeqCst);
    service
        .enqueue(prompt_input("cm-stale", 1, "stale", now_ms()))
        .expect("enqueue stale");

    wait_until(
        || entry_status(&db, "cm-stale") == Some(PromptQueueStatus::Failed),
        "stale prompt failed",
    )
    .await;
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    let failed = store
        .get_by_client_message_id("cm-stale")
        .expect("failed entry")
        .expect("entry");
    assert_eq!(
        failed.last_error.as_deref(),
        Some("Lane generation changed before execution")
    );
    assert!(runner.calls().is_empty());
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn reconciles_interrupted_rows_before_recovering_queued_work() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let now = now_ms();
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    store
        .claim_ownership("old-worker", 999, now, 60_000, |_| true)
        .expect("old ownership");
    let queued = store
        .enqueue(prompt_input("cm-interrupted", 1, "interrupted", now), now)
        .expect("enqueue interrupted");
    store
        .mark_running(queued.entry.id, "old-worker", now + 1, 60_000)
        .expect("running");
    drop(connection);

    let runner = FakeRunner::new(Duration::ZERO);
    runner.push_reconciliation(Ok(Some(PromptQueueRunOutcome::success())));
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(&db, Arc::clone(&runner), generation, snapshots, None);
    service.start().await.expect("start");

    wait_until(
        || entry_status(&db, "cm-interrupted") == Some(PromptQueueStatus::Completed),
        "interrupted prompt completed",
    )
    .await;
    assert!(runner.calls().is_empty());
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn losing_the_ownership_lease_aborts_the_active_run() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let (runner, gate) = FakeRunner::gated();
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(
        &db,
        Arc::clone(&runner),
        generation,
        snapshots,
        Some(Arc::new(|pid| pid == 200)),
    );
    service.start().await.expect("start");
    service
        .enqueue(prompt_input("cm-active", 1, "active", now_ms()))
        .expect("enqueue active");
    wait_until(|| !runner.calls().is_empty(), "runner started").await;

    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    store
        .claim_ownership("other-worker", 200, now_ms(), 60_000, |_| false)
        .expect("other ownership");

    wait_until(
        || runner.aborted() == vec!["cm-active".to_string()],
        "active run aborted",
    )
    .await;
    gate.notify_waiters();
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn transient_renewal_error_does_not_permanently_drop_ownership() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = FakeRunner::new(Duration::ZERO);
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let observed_errors = Arc::clone(&errors);
    let service = PromptQueueService::new(PromptQueueServiceOptions {
        store: db.clone(),
        worker_id: "worker-1".to_string(),
        owner_pid: Some(100),
        is_owner_alive: None,
        ownership_renewal_interval: Some(Duration::from_millis(10)),
        resolve_current_generation: Arc::new(move |_entry| generation.load(Ordering::SeqCst)),
        runner,
        emit_snapshot: Arc::new(move |entry| {
            snapshots.lock().expect("snapshots").push(entry);
        }),
        emit_event: Arc::new(|_, _| {}),
        on_error: Some(Arc::new(move |error| {
            observed_errors.lock().expect("renewal errors").push(error);
        })),
    });
    service.start().await.expect("start");

    let connection = db.connect().expect("connection");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_ownership_renewal
             BEFORE UPDATE ON prompt_queue_ownership
             BEGIN
               SELECT RAISE(FAIL, 'transient renewal failure');
             END;",
        )
        .expect("renewal failure trigger");

    wait_until(
        || {
            errors
                .lock()
                .expect("renewal errors")
                .iter()
                .any(|error| error.contains("renewal delayed"))
        },
        "renewal failure reported",
    )
    .await;
    assert!(
        service.is_owner(),
        "a transient SQLite error must not permanently drop ownership"
    );

    connection
        .execute_batch("DROP TRIGGER fail_ownership_renewal;")
        .expect("drop renewal failure trigger");
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn failed_runner_outcome_marks_the_prompt_failed() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let runner = FakeRunner::new(Duration::ZERO);
    runner.push_outcome(PromptQueueRunOutcome::failure("runner failed"));
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(&db, Arc::clone(&runner), generation, snapshots, None);
    service.start().await.expect("start");
    service
        .enqueue(prompt_input("cm-failed", 1, "failed", now_ms()))
        .expect("enqueue failed");

    wait_until(
        || entry_status(&db, "cm-failed") == Some(PromptQueueStatus::Failed),
        "prompt marked failed",
    )
    .await;
    let connection = db.connect().expect("connection");
    let store = PromptQueueStore::new(&connection).expect("store");
    let failed = store
        .get_by_client_message_id("cm-failed")
        .expect("failed entry")
        .expect("entry");
    assert_eq!(failed.last_error.as_deref(), Some("runner failed"));
    service.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn abort_lane_only_signals_the_active_lane() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let (runner, gate) = FakeRunner::gated();
    let generation = Arc::new(AtomicI64::new(1));
    let snapshots = Arc::new(Mutex::new(Vec::new()));
    let service = service(&db, Arc::clone(&runner), generation, snapshots, None);
    service.start().await.expect("start");
    service
        .enqueue(prompt_input("cm-active", 1, "active", now_ms()))
        .expect("enqueue");
    wait_until(|| runner.calls() == vec!["cm-active"], "runner started").await;

    assert_eq!(service.abort_lane(&lane(2)), 0);
    assert_eq!(service.abort_lane(&lane(1)), 1);
    assert_eq!(runner.aborted(), vec!["cm-active"]);
    gate.notify_waiters();
    wait_until(
        || entry_status(&db, "cm-active") == Some(PromptQueueStatus::Completed),
        "aborted prompt settled",
    )
    .await;
    service.stop().await;
}
