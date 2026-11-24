use std::path::{Path, PathBuf};
use std::process::Command;

use ads_state::{
    ActionJobIssueSnapshot, ActionJobKind, ActionJobStatus, ActionJobStatusUpdate, CreateActionJob,
    StateDb, SupersedeReviewJobsInput, acquire_review_queue_lease, create_action_job,
    get_action_job, get_review_queue_lease, list_action_jobs, release_review_queue_lease,
    renew_review_queue_lease, supersede_review_jobs_for_new_head, update_action_job_status,
};
use serde_json::Value;
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repo root")
        .to_path_buf()
}

fn ts_server_root() -> PathBuf {
    repo_root().join("ts-server")
}

fn run_fixture(mode: &str, db_path: &Path) -> Value {
    let ts_server_root = ts_server_root();
    let output = Command::new("node")
        .arg("--import")
        .arg(ts_server_root.join("node_modules/tsx/dist/loader.mjs"))
        .arg(repo_root().join("rust-server/scripts/action-job-store-fixture.ts"))
        .arg(mode)
        .arg(db_path)
        .current_dir(ts_server_root)
        .output()
        .expect("run node fixture");
    assert!(
        output.status.success(),
        "fixture {mode} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or_else(|| panic!("fixture {mode} produced no JSON:\n{stdout}"));
    serde_json::from_str(line).expect("fixture json")
}

fn snapshot() -> ActionJobIssueSnapshot {
    ActionJobIssueSnapshot {
        title: "Issue".to_string(),
        description: "Description".to_string(),
        acceptance_criteria: vec!["Criterion".to_string()],
        adrs: Vec::new(),
    }
}

fn job(id: &str, head: &str) -> CreateActionJob {
    CreateActionJob {
        id: id.to_string(),
        project_id: "project-1".to_string(),
        lane_generation: Some(0),
        acopilot_lane_generation: 1,
        job_kind: ActionJobKind::PullRequestReview,
        issue_id: 11,
        issue_title: "Issue".to_string(),
        issue_snapshot: snapshot(),
        status: None,
        branch: "codex/issue-11".to_string(),
        base_sha: "base".to_string(),
        head_sha: head.to_string(),
        reviewer_profile_ids_json: "[]".to_string(),
        pr_number: 12,
        pr_url: "https://github.com/example/pull/12".to_string(),
        auth_user_id: "user-1".to_string(),
        chat_session_id: "chat-1".to_string(),
        rework_declaration_json: None,
        rework_root_job_id: None,
    }
}

fn write_rust_rows(connection: &rusqlite::Connection) {
    create_action_job(connection, job("job-a", "head-a"), 1_000).expect("job a");
    update_action_job_status(
        connection,
        "job-a",
        ActionJobStatus::Reviewing,
        ActionJobStatusUpdate {
            current_step: Some(Some("Reviewing".to_string())),
            ..ActionJobStatusUpdate::default()
        },
        1_100,
        false,
    )
    .expect("reviewing");
    create_action_job(connection, job("job-b", "head-b"), 1_200).expect("job b");
    supersede_review_jobs_for_new_head(
        connection,
        &SupersedeReviewJobsInput {
            project_id: "project-1".to_string(),
            pr_number: Some(12),
            branch: Some("codex/issue-11".to_string()),
            keep_head_sha: "head-b".to_string(),
            superseded_by_job_id: "job-b".to_string(),
        },
        1_300,
    )
    .expect("supersede");
    assert!(
        acquire_review_queue_lease(connection, "project-1", "owner-a", 1_000, 2_000)
            .expect("lease a")
    );
    assert!(
        !acquire_review_queue_lease(connection, "project-1", "owner-b", 1_000, 2_500)
            .expect("lease conflict")
    );
    assert!(
        renew_review_queue_lease(connection, "project-1", "owner-a", 1_000, 2_600).expect("renew")
    );
    release_review_queue_lease(connection, "project-1", "owner-a").expect("release");
    assert!(
        acquire_review_queue_lease(connection, "project-1", "owner-b", 1_000, 3_000)
            .expect("lease b")
    );
}

#[test]
fn typescript_reads_rows_written_by_rust() {
    let directory = tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");
    let db = StateDb::open(&db_path).expect("state db");
    let connection = db.connect().expect("connection");
    write_rust_rows(&connection);

    let expected = run_fixture("verify", &db_path);
    let jobs =
        serde_json::to_value(list_action_jobs(&connection, "project-1", None, None).expect("jobs"))
            .expect("jobs json");
    let queued = serde_json::to_value(
        list_action_jobs(
            &connection,
            "project-1",
            Some(ActionJobStatus::Queued),
            None,
        )
        .expect("queued"),
    )
    .expect("queued json");
    let lease = serde_json::to_value(
        get_review_queue_lease(&connection, "project-1")
            .expect("lease")
            .expect("lease exists"),
    )
    .expect("lease json");
    assert_eq!(jobs, expected["jobs"]);
    assert_eq!(queued, expected["queuedJobs"]);
    assert_eq!(lease, expected["lease"]);
}

#[test]
fn rust_reads_rows_written_by_typescript() {
    let directory = tempdir().expect("temp dir");
    let db_path = directory.path().join("state.db");
    let db = StateDb::open(&db_path).expect("state db");
    drop(db);

    run_fixture("write", &db_path);

    let db = StateDb::open(&db_path).expect("reopen state db");
    let connection = db.connect().expect("connection");
    let jobs = list_action_jobs(&connection, "project-1", None, None).expect("jobs");
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[0].id, "job-b");
    assert_eq!(jobs[1].id, "job-a");
    assert_eq!(jobs[1].status, ActionJobStatus::Cancelled);
    assert_eq!(jobs[1].superseded_at, Some(1_300));
    assert_eq!(jobs[1].superseded_by_job_id.as_deref(), Some("job-b"));
    assert_eq!(
        jobs[1].current_step.as_deref(),
        Some("Superseded by a newer head commit")
    );
    assert_eq!(jobs[0].status, ActionJobStatus::Queued);
    assert_eq!(jobs[0].lane_generation, 1);
    assert_eq!(jobs[1].lane_generation, 1);

    let queued = list_action_jobs(
        &connection,
        "project-1",
        Some(ActionJobStatus::Queued),
        None,
    )
    .expect("queued");
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, "job-b");

    let lease = get_review_queue_lease(&connection, "project-1")
        .expect("lease")
        .expect("lease exists");
    assert_eq!(lease.owner_id, "owner-b");
    assert_eq!(lease.expires_at, 4_000);
    assert_eq!(lease.updated_at, 3_000);

    let pinned = get_action_job(&connection, "job-a")
        .expect("read")
        .expect("exists");
    assert_eq!(
        pinned.issue_snapshot_json,
        serde_json::to_string(&snapshot()).unwrap()
    );
}
