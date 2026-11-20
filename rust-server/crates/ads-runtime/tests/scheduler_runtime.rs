use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_contract::schedule::{DeliveryChannel, ScheduleSpec};
use ads_contract::time::now_unix_millis;
use ads_runtime::scheduler::{
    ScheduleExecuteFuture, ScheduleExecutor, ScheduleNotifier, ScheduleTerminalEvent,
    SchedulerExecutionInput, SchedulerRuntime, SchedulerRuntimeOptions, build_external_id,
};
use ads_state::{
    CreateSchedule, ScheduleRunStatus, ScheduleStore, StoredScheduleRun, WorkspaceDb,
    derive_workspace_state_id,
};
use serde_json::json;
use tempfile::tempdir;

#[derive(Default)]
struct FakeExecutor {
    calls: AtomicUsize,
    prompts: Mutex<Vec<String>>,
    error: Option<&'static str>,
}

impl FakeExecutor {
    fn success() -> Self {
        Self::default()
    }

    fn failure(message: &'static str) -> Self {
        Self {
            error: Some(message),
            ..Self::default()
        }
    }
}

impl ScheduleExecutor for FakeExecutor {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.prompts
            .lock()
            .expect("prompts")
            .push(input.prompt.clone());
        let outcome = match self.error {
            Some(error) => Err(error.to_string()),
            None => Ok(" 完成 ".to_string()),
        };
        Box::pin(async move {
            tokio::task::yield_now().await;
            outcome
        })
    }
}

fn schedule_spec(max_retries: i64) -> ScheduleSpec {
    serde_json::from_value(json!({
        "version": 1,
        "name": "test-schedule",
        "enabled": true,
        "schedule": { "type": "cron", "cron": "0 9 * * *", "timezone": "UTC" },
        "instruction": "do work",
        "delivery": {
            "channels": ["web"],
            "web": { "audience": "owner" },
            "telegram": { "chatId": null }
        },
        "policy": {
            "workspaceWrite": false,
            "network": "deny",
            "maxDurationMs": 600000,
            "maxRetries": max_retries,
            "concurrencyKey": "schedule:{scheduleId}",
            "idempotencyKeyTemplate": "sch:{scheduleId}:{runAtIso}"
        },
        "compiledTask": {
            "title": "Test task",
            "prompt": "say hi",
            "expectedResultSchema": {},
            "verification": { "commands": [] }
        },
        "questions": []
    }))
    .expect("schedule spec")
}

struct Fixture {
    _directory: tempfile::TempDir,
    db: Arc<WorkspaceDb>,
    workspace_root: String,
    workspace_id: String,
    queue_path: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("workspace");
    fs::create_dir_all(&workspace).expect("workspace");
    let db = Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("db"));
    let workspace_root = workspace.to_string_lossy().to_string();
    let workspace_id = derive_workspace_state_id(&workspace_root);
    let queue_path = directory.path().join("ads.liteque.db");
    Fixture {
        _directory: directory,
        db,
        workspace_root,
        workspace_id,
        queue_path,
    }
}

fn create_schedule(
    fixture: &Fixture,
    spec: ScheduleSpec,
    enabled: bool,
    next_run_at: i64,
) -> ads_state::StoredSchedule {
    let now = now_unix_millis();
    let connection = fixture.db.connect().expect("connection");
    ScheduleStore::new(&connection, &fixture.workspace_id)
        .create_schedule(
            CreateSchedule {
                instruction: "do work".to_string(),
                spec: Some(spec),
                enabled,
                next_run_at: Some(next_run_at),
            },
            now,
        )
        .expect("schedule")
}

fn runtime(fixture: &Fixture, executor: Arc<FakeExecutor>) -> Arc<SchedulerRuntime> {
    runtime_with_notifier(fixture, executor, None)
}

fn runtime_with_notifier(
    fixture: &Fixture,
    executor: Arc<FakeExecutor>,
    notifier: Option<Arc<dyn ScheduleNotifier>>,
) -> Arc<SchedulerRuntime> {
    let mut options = SchedulerRuntimeOptions::new(fixture.db.clone(), executor);
    options.enabled = true;
    options.tick_ms = 10;
    options.runner_poll_ms = 10;
    options.runner_timeout_secs = 5;
    options.lease_ttl_ms = 30_000;
    options.due_limit = 10;
    options.queue_db_path_override = Some(fixture.queue_path.clone());
    options.notifier = notifier;
    SchedulerRuntime::new(options)
}

#[derive(Default)]
struct FakeNotifier {
    events: Mutex<Vec<ScheduleTerminalEvent>>,
}

impl ScheduleNotifier for FakeNotifier {
    fn notify(&self, event: ScheduleTerminalEvent) {
        self.events.lock().expect("events").push(event);
    }
}

async fn wait_for_terminal(fixture: &Fixture, external_id: &str) -> StoredScheduleRun {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let run = {
                let connection = fixture.db.connect().expect("connection");
                ScheduleStore::new(&connection, &fixture.workspace_id)
                    .get_run_by_external_id(external_id)
                    .expect("run")
            };
            if let Some(run) = run
                && matches!(
                    run.status,
                    ScheduleRunStatus::Completed | ScheduleRunStatus::Failed
                )
            {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("schedule run did not finish")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn due_schedule_runs_and_advances_next_run() {
    let fixture = fixture();
    let old_run_at = now_unix_millis() - 60_000;
    let schedule = create_schedule(&fixture, schedule_spec(0), true, old_run_at);
    let executor = Arc::new(FakeExecutor::success());
    let runtime = runtime(&fixture, Arc::clone(&executor));

    runtime.tick_workspace(&fixture.workspace_root).await;
    let external_id = build_external_id(&schedule, old_run_at);
    let run = wait_for_terminal(&fixture, &external_id).await;

    assert_eq!(run.status, ScheduleRunStatus::Completed);
    assert_eq!(run.result.as_deref(), Some("完成"));
    assert!(run.started_at.is_some());
    assert!(run.completed_at.is_some());
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);

    let prompts = executor.prompts.lock().expect("prompts");
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("Scheduler runtime context:"));
    assert!(prompts[0].contains(&format!("- runAtMs: {old_run_at}")));
    assert!(prompts[0].ends_with("say hi"));

    let updated = {
        let connection = fixture.db.connect().expect("connection");
        ScheduleStore::new(&connection, &fixture.workspace_id)
            .get_schedule(&schedule.id)
            .expect("schedule")
            .expect("schedule")
    };
    assert!(updated.next_run_at.is_some_and(|value| value > old_run_at));
    runtime.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telegram_terminal_notifier_receives_completed_schedule() {
    let fixture = fixture();
    let old_run_at = now_unix_millis() - 60_000;
    let mut spec = schedule_spec(0);
    spec.delivery.channels = vec![DeliveryChannel::Telegram];
    spec.delivery.telegram.chat_id = Some(Some("chat-42".to_string()));
    let schedule = create_schedule(&fixture, spec, true, old_run_at);
    let executor = Arc::new(FakeExecutor::success());
    let notifier = Arc::new(FakeNotifier::default());
    let runtime = runtime_with_notifier(&fixture, Arc::clone(&executor), Some(notifier.clone()));

    runtime.tick_workspace(&fixture.workspace_root).await;
    let external_id = build_external_id(&schedule, old_run_at);
    wait_for_terminal(&fixture, &external_id).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if !notifier.events.lock().expect("events").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("terminal event");
    let events = notifier.events.lock().expect("events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].task_id, external_id);
    assert_eq!(events[0].status, "completed");
    assert_eq!(events[0].title, "Test task");
    assert_eq!(events[0].workspace_root, fixture.workspace_root);
    assert_eq!(events[0].telegram_chat_id.as_deref(), Some("chat-42"));
    runtime.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_runs_retry_then_mark_failed() {
    let fixture = fixture();
    let old_run_at = now_unix_millis() - 60_000;
    let schedule = create_schedule(&fixture, schedule_spec(1), true, old_run_at);
    let executor = Arc::new(FakeExecutor::failure("boom"));
    let runtime = runtime(&fixture, Arc::clone(&executor));

    runtime.tick_workspace(&fixture.workspace_root).await;
    let external_id = build_external_id(&schedule, old_run_at);
    let run = wait_for_terminal(&fixture, &external_id).await;

    assert_eq!(run.status, ScheduleRunStatus::Failed);
    assert_eq!(run.error.as_deref(), Some("boom"));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 2);
    runtime.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_cron_disables_the_schedule() {
    let fixture = fixture();
    let old_run_at = now_unix_millis() - 60_000;
    let mut spec = schedule_spec(0);
    spec.schedule.cron = "not-a-cron".to_string();
    let schedule = create_schedule(&fixture, spec, true, old_run_at);
    let executor = Arc::new(FakeExecutor::success());
    let runtime = runtime(&fixture, Arc::clone(&executor));

    runtime.tick_workspace(&fixture.workspace_root).await;

    let updated = {
        let connection = fixture.db.connect().expect("connection");
        ScheduleStore::new(&connection, &fixture.workspace_id)
            .get_schedule(&schedule.id)
            .expect("schedule")
            .expect("schedule")
    };
    assert!(!updated.enabled);
    assert!(updated.next_run_at.is_none());
    assert!(
        updated
            .spec
            .questions
            .iter()
            .any(|question| question.contains("not supported by runtime"))
    );
    runtime.stop();
}
