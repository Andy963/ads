use ads_contract::schedule::ScheduleSpec;
use ads_state::{
    CreateSchedule, InsertScheduleRun, ScheduleRunStatus, ScheduleStore, StateError,
    UpdateSchedule, UpdateScheduleRun, WorkspaceDb,
};
use serde_json::json;
use tempfile::tempdir;

fn sample_spec(name: &str) -> ScheduleSpec {
    let value = json!({
        "version": 1,
        "name": name,
        "enabled": true,
        "schedule": {
            "type": "cron",
            "cron": "0 9 * * *",
            "timezone": "Asia/Shanghai",
            "unknownSchedule": "kept"
        },
        "instruction": "summarize the inbox",
        "delivery": {
            "channels": ["web", "telegram"],
            "web": {"audience": "owner"},
            "telegram": {"chatId": null}
        },
        "policy": {
            "workspaceWrite": true,
            "network": "deny",
            "maxDurationMs": 60000,
            "maxRetries": 2,
            "concurrencyKey": "inbox",
            "idempotencyKeyTemplate": "inbox-{runAt}"
        },
        "compiledTask": {
            "title": "Inbox summary",
            "prompt": "Summarize the inbox",
            "expectedResultSchema": {"type": "object"},
            "verification": {"commands": ["true"]}
        },
        "questions": [],
        "unknownTopLevel": 42
    });
    let spec: ScheduleSpec = serde_json::from_value(value).expect("sample spec");
    spec.validate().expect("valid sample spec");
    spec
}

#[test]
fn schedule_lifecycle_due_lease_and_listing_match_the_typescript_store() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = ScheduleStore::new(&connection, "workspace-test");

    let second = store
        .create_schedule(
            CreateSchedule {
                instruction: "second".to_string(),
                spec: Some(sample_spec("Second")),
                enabled: true,
                next_run_at: Some(200),
            },
            20,
        )
        .expect("second schedule");
    let first = store
        .create_schedule(
            CreateSchedule {
                instruction: "first".to_string(),
                spec: Some(sample_spec("First")),
                enabled: true,
                next_run_at: Some(100),
            },
            10,
        )
        .expect("first schedule");

    assert_eq!(first.instruction, "first");
    assert!(first.enabled);
    assert_eq!(first.next_run_at, Some(100));
    assert!(first.lease_owner.is_none());
    assert_eq!(first.spec.extra["unknownTopLevel"], json!(42));
    assert_eq!(first.spec.schedule.extra["unknownSchedule"], json!("kept"));

    let listed = store.list_schedules(None).expect("list schedules");
    assert_eq!(
        listed
            .iter()
            .map(|schedule| schedule.id.as_str())
            .collect::<Vec<_>>(),
        vec![second.id.as_str(), first.id.as_str()]
    );

    let due = store
        .list_due_schedule_ids(150, None)
        .expect("list due schedules");
    assert_eq!(due, vec![first.id.clone()]);

    assert!(
        store
            .claim_schedule_lease(&first.id, "worker-a", 300, 100)
            .expect("claim lease")
    );
    assert!(
        !store
            .claim_schedule_lease(&first.id, "worker-b", 400, 100)
            .expect("second claim blocked")
    );
    assert!(
        store
            .list_due_schedule_ids(150, None)
            .expect("leased schedule hidden")
            .is_empty()
    );

    store
        .release_schedule_lease(&first.id, Some("worker-b"), 160)
        .expect("wrong owner release");
    assert_eq!(
        store
            .get_schedule(&first.id)
            .expect("read schedule")
            .expect("schedule exists")
            .lease_owner
            .as_deref(),
        Some("worker-a")
    );
    store
        .release_schedule_lease(&first.id, Some("worker-a"), 170)
        .expect("owner release");
    let released = store
        .get_schedule(&first.id)
        .expect("read released schedule")
        .expect("schedule exists");
    assert!(released.lease_owner.is_none());
    assert!(released.lease_until.is_none());
    assert_eq!(released.updated_at, 170);

    assert!(
        store
            .claim_schedule_lease(&first.id, "worker-a", 500, 200)
            .expect("claim expired lease")
    );
    let updated = store
        .update_schedule(
            &first.id,
            UpdateSchedule {
                instruction: Some("updated".to_string()),
                spec: Some(sample_spec("Updated")),
                enabled: Some(false),
                next_run_at: Some(None),
                lease_owner: Some(None),
                lease_until: Some(None),
            },
            600,
        )
        .expect("update schedule");
    assert_eq!(updated.instruction, "updated");
    assert!(!updated.enabled);
    assert!(updated.next_run_at.is_none());
    assert!(updated.lease_owner.is_none());
    assert!(updated.lease_until.is_none());
    assert_eq!(updated.spec.name, "Updated");
    assert_eq!(updated.updated_at, 600);

    assert_eq!(
        store
            .list_due_schedule_ids(1_000, Some(10))
            .expect("disabled schedule is not due"),
        vec![second.id.clone()]
    );
}

#[test]
fn schedule_runs_are_idempotent_and_update_fields_like_typescript() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = ScheduleStore::new(&connection, "workspace-test");
    let schedule = store
        .create_schedule(
            CreateSchedule {
                instruction: "run me".to_string(),
                spec: Some(sample_spec("Runs")),
                enabled: true,
                next_run_at: Some(100),
            },
            10,
        )
        .expect("schedule");

    let first_run_id = store
        .insert_run(
            InsertScheduleRun {
                schedule_id: schedule.id.clone(),
                external_id: "external-1".to_string(),
                run_at: 100,
                task_id: None,
                status: ScheduleRunStatus::Running,
            },
            110,
        )
        .expect("insert run")
        .expect("first run inserted");
    assert!(
        store
            .insert_run(
                InsertScheduleRun {
                    schedule_id: schedule.id.clone(),
                    external_id: "external-1".to_string(),
                    run_at: 999,
                    task_id: None,
                    status: ScheduleRunStatus::Failed,
                },
                111,
            )
            .expect("duplicate insert")
            .is_none()
    );

    let run = store
        .get_run_by_external_id("external-1")
        .expect("get run")
        .expect("run exists");
    assert_eq!(run.id, first_run_id);
    assert_eq!(run.status, ScheduleRunStatus::Running);
    assert_eq!(run.run_at, 100);

    connection
        .execute(
            "INSERT INTO tasks (id, title, prompt, created_at, workspace_id)
             VALUES ('task-1', 'Task', 'Prompt', 115, 'workspace-test')",
            [],
        )
        .expect("insert task");

    let updated = store
        .update_run_by_external_id(
            " external-1 ",
            UpdateScheduleRun {
                status: Some(ScheduleRunStatus::Completed),
                task_id: Some(Some("task-1".to_string())),
                result: Some(Some("done".to_string())),
                error: Some(None),
                started_at: Some(Some(120)),
                completed_at: Some(Some(130)),
            },
            140,
        )
        .expect("update run");
    assert_eq!(updated.status, ScheduleRunStatus::Completed);
    assert_eq!(updated.task_id.as_deref(), Some("task-1"));
    assert_eq!(updated.result.as_deref(), Some("done"));
    assert!(updated.error.is_none());
    assert_eq!(updated.started_at, Some(120));
    assert_eq!(updated.completed_at, Some(130));
    assert_eq!(updated.updated_at, 140);

    store
        .insert_run(
            InsertScheduleRun {
                schedule_id: schedule.id.clone(),
                external_id: "external-2".to_string(),
                run_at: 200,
                task_id: None,
                status: ScheduleRunStatus::Queued,
            },
            210,
        )
        .expect("insert second run");
    let runs = store.list_runs(&schedule.id, None).expect("list runs");
    assert_eq!(
        runs.iter()
            .map(|run| run.external_id.as_str())
            .collect::<Vec<_>>(),
        vec!["external-2", "external-1"]
    );
    assert_eq!(
        store
            .list_runs(&schedule.id, Some(1))
            .expect("limited")
            .len(),
        1
    );

    connection
        .execute(
            "UPDATE schedule_runs SET status = 'nonsense' WHERE external_id = 'external-1'",
            [],
        )
        .expect("write invalid status");
    let fallback = store
        .get_run_by_external_id("external-1")
        .expect("read fallback")
        .expect("run exists");
    assert_eq!(fallback.status, ScheduleRunStatus::Queued);

    let error = store
        .insert_run(
            InsertScheduleRun {
                schedule_id: " ".to_string(),
                external_id: "external-3".to_string(),
                run_at: 300,
                task_id: None,
                status: ScheduleRunStatus::Queued,
            },
            310,
        )
        .expect_err("missing schedule id rejected");
    assert!(matches!(error, StateError::InvalidInput(_)));
}

#[test]
fn schedule_rows_reject_invalid_specs() {
    let directory = tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("ads.db")).expect("workspace db");
    let connection = db.connect().expect("connection");
    let store = ScheduleStore::new(&connection, "workspace-test");
    let schedule = store
        .create_schedule(
            CreateSchedule {
                instruction: "bad".to_string(),
                spec: Some(sample_spec("Bad")),
                enabled: false,
                next_run_at: None,
            },
            10,
        )
        .expect("schedule");
    connection
        .execute(
            "UPDATE schedules SET spec_json = ?1 WHERE id = ?2",
            rusqlite::params![
                json!({
                    "version": 1,
                    "name": "Missing fields",
                    "enabled": false,
                    "schedule": {"type": "cron", "cron": "x", "timezone": "UTC"},
                    "instruction": "",
                    "delivery": {
                        "channels": ["web"],
                        "web": {"audience": "owner"},
                        "telegram": {"chatId": null}
                    },
                    "policy": {
                        "workspaceWrite": false,
                        "network": "deny",
                        "maxDurationMs": 1,
                        "maxRetries": 0,
                        "concurrencyKey": "x",
                        "idempotencyKeyTemplate": "x"
                    },
                    "questions": []
                })
                .to_string(),
                schedule.id
            ],
        )
        .expect("write malformed spec");
    let error = store
        .get_schedule(&schedule.id)
        .expect_err("invalid spec is rejected");
    assert!(matches!(error, StateError::InvalidInput(_)));
}
