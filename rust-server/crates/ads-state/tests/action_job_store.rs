use ads_state::{
    ActionJobIssueSnapshot, ActionJobKind, ActionJobPinnedTarget, ActionJobStatus,
    ActionJobStatusUpdate, CreateActionJob, StateDb, SupersedeReviewJobsInput, create_action_job,
    get_action_job, list_action_jobs, supersede_review_jobs_for_new_head,
    update_action_job_pinned_target, update_action_job_status,
};
use tempfile::tempdir;

fn state() -> (tempfile::TempDir, StateDb) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    (directory, db)
}

fn snapshot() -> ActionJobIssueSnapshot {
    ActionJobIssueSnapshot {
        title: "Issue".to_string(),
        description: "Description".to_string(),
        acceptance_criteria: vec!["Criterion".to_string()],
        adrs: Vec::new(),
    }
}

fn job(id: &str, head: &str, _now: i64) -> CreateActionJob {
    CreateActionJob {
        id: id.to_string(),
        project_id: "project-1".to_string(),
        lane_generation: None,
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

#[test]
fn creates_jobs_with_database_defaults_and_clamps_lane_generation() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    let created =
        create_action_job(&connection, job("job-a", "head-a", 1_000), 1_000).expect("create job");
    assert_eq!(created.id, "job-a");
    assert_eq!(created.lane_generation, 1);
    assert_eq!(created.status, ActionJobStatus::Queued);
    assert_eq!(
        created.issue_snapshot_json,
        serde_json::to_string(&snapshot()).unwrap()
    );
    assert_eq!(created.steps_json, "[]");
    assert_eq!(created.review_verdicts_json, "[]");
    assert_eq!(created.attempts_json, "[]");
    assert_eq!(created.verification_report_json, "");
    assert_eq!(created.rework_count, 0);
    assert_eq!(created.created_at, 1_000);
    assert_eq!(created.updated_at, 1_000);

    let mut low = job("job-low", "head-low", 1_100);
    low.lane_generation = Some(0);
    assert_eq!(
        create_action_job(&connection, low, 1_100)
            .expect("low lane")
            .lane_generation,
        1
    );
    let mut high = job("job-high", "head-high", 1_200);
    high.lane_generation = Some(3);
    assert_eq!(
        create_action_job(&connection, high, 1_200)
            .expect("high lane")
            .lane_generation,
        3
    );
}

#[test]
fn lists_jobs_by_status_order_and_owner() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    create_action_job(&connection, job("job-a", "head-a", 100), 100).expect("a");
    let mut second = job("job-b", "head-b", 200);
    second.auth_user_id = "alice".to_string();
    create_action_job(&connection, second, 200).expect("b");
    let mut third = job("job-c", "head-c", 300);
    third.auth_user_id = "bob".to_string();
    third.status = Some(ActionJobStatus::Completed);
    create_action_job(&connection, third, 300).expect("c");

    let all = list_action_jobs(&connection, "project-1", None, None).expect("all");
    assert_eq!(
        all.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
        ["job-c", "job-b", "job-a"]
    );

    let queued = list_action_jobs(
        &connection,
        "project-1",
        Some(ActionJobStatus::Queued),
        None,
    )
    .expect("queued");
    assert_eq!(
        queued.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
        ["job-a", "job-b"]
    );

    let owned = list_action_jobs(&connection, "project-1", None, Some("  alice  ")).expect("owned");
    assert_eq!(
        owned.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
        ["job-b"]
    );
    assert!(
        list_action_jobs(&connection, "project-1", None, Some("other"))
            .expect("other")
            .is_empty()
    );
}

#[test]
fn updates_pinned_targets_only_before_supersession() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    create_action_job(&connection, job("job-a", "head-a", 100), 100).expect("create");

    let target = ActionJobPinnedTarget {
        issue_id: 42,
        issue_title: "Pinned".to_string(),
        issue_snapshot: ActionJobIssueSnapshot {
            title: "Pinned".to_string(),
            description: "Pinned description".to_string(),
            acceptance_criteria: vec!["Done".to_string()],
            adrs: Vec::new(),
        },
        branch: "codex/issue-42".to_string(),
        base_sha: "base-42".to_string(),
        head_sha: "head-42".to_string(),
        pr_number: 43,
        pr_url: "https://github.com/example/pull/43".to_string(),
    };
    assert!(update_action_job_pinned_target(&connection, "job-a", &target, 200).expect("pin"));
    let pinned = get_action_job(&connection, "job-a")
        .expect("read")
        .expect("exists");
    assert_eq!(pinned.issue_id, Some(42));
    assert_eq!(pinned.issue_title, "Pinned");
    assert_eq!(pinned.head_sha.as_deref(), Some("head-42"));
    assert_eq!(pinned.pr_number, Some(43));
    assert_eq!(pinned.updated_at, 200);

    supersede_review_jobs_for_new_head(
        &connection,
        &SupersedeReviewJobsInput {
            project_id: "project-1".to_string(),
            pr_number: Some(43),
            branch: None,
            keep_head_sha: "new-head".to_string(),
            superseded_by_job_id: "job-new".to_string(),
        },
        300,
    )
    .expect("supersede");

    assert!(!update_action_job_pinned_target(&connection, "job-a", &target, 400).expect("re-pin"));
    let superseded = get_action_job(&connection, "job-a")
        .expect("read")
        .expect("exists");
    assert_eq!(superseded.head_sha.as_deref(), Some("head-42"));
    assert_eq!(superseded.updated_at, 300);
}

#[test]
fn applies_partial_status_updates_and_supersession_guard() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    create_action_job(&connection, job("job-a", "head-a", 100), 100).expect("create");

    assert!(
        update_action_job_status(
            &connection,
            "job-a",
            ActionJobStatus::Reviewing,
            ActionJobStatusUpdate {
                current_step: Some(Some("Reviewing".to_string())),
                review_verdicts_json: Some(None),
                verification_report_json: Some(None),
                error_message: Some(None),
            },
            200,
            false,
        )
        .expect("update")
    );
    let updated = get_action_job(&connection, "job-a")
        .expect("read")
        .expect("exists");
    assert_eq!(updated.status, ActionJobStatus::Reviewing);
    assert_eq!(updated.current_step.as_deref(), Some("Reviewing"));
    assert_eq!(updated.review_verdicts_json, "[]");
    assert_eq!(updated.verification_report_json, "");
    assert_eq!(updated.error_message, None);
    assert_eq!(updated.updated_at, 200);

    supersede_review_jobs_for_new_head(
        &connection,
        &SupersedeReviewJobsInput {
            project_id: "project-1".to_string(),
            pr_number: Some(12),
            branch: None,
            keep_head_sha: "new-head".to_string(),
            superseded_by_job_id: "job-new".to_string(),
        },
        300,
    )
    .expect("supersede");
    assert!(
        !update_action_job_status(
            &connection,
            "job-a",
            ActionJobStatus::Completed,
            ActionJobStatusUpdate::default(),
            400,
            true,
        )
        .expect("guarded update")
    );
    assert!(
        update_action_job_status(
            &connection,
            "job-a",
            ActionJobStatus::Cancelled,
            ActionJobStatusUpdate::default(),
            400,
            false,
        )
        .expect("unguarded update")
    );
}

#[test]
fn supersedes_only_older_review_jobs_for_the_same_target() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    create_action_job(&connection, job("old", "head-old", 100), 100).expect("old");
    create_action_job(&connection, job("current", "head-new", 200), 200).expect("current");

    let mut completed = job("completed", "head-completed", 150);
    completed.status = Some(ActionJobStatus::Completed);
    create_action_job(&connection, completed, 150).expect("completed");

    let mut cancelled = job("cancelled", "head-cancelled", 160);
    cancelled.status = Some(ActionJobStatus::Cancelled);
    create_action_job(&connection, cancelled, 160).expect("cancelled");

    let mut already = job("already", "head-already", 170);
    already.status = Some(ActionJobStatus::Cancelled);
    create_action_job(&connection, already, 170).expect("already");
    connection
        .execute(
            "UPDATE action_jobs SET superseded_at = 171, superseded_by_job_id = 'prior' WHERE id = 'already'",
            [],
        )
        .expect("mark already superseded");

    let mut local = job("local", "head-local", 180);
    local.job_kind = ActionJobKind::LocalPrompt;
    create_action_job(&connection, local, 180).expect("local");

    let mut other_head = job("other-head", "head-other", 190);
    other_head.pr_number = 99;
    create_action_job(&connection, other_head, 190).expect("other");

    let changed = supersede_review_jobs_for_new_head(
        &connection,
        &SupersedeReviewJobsInput {
            project_id: "project-1".to_string(),
            pr_number: Some(12),
            branch: None,
            keep_head_sha: "head-new".to_string(),
            superseded_by_job_id: "current".to_string(),
        },
        300,
    )
    .expect("supersede pr");
    assert_eq!(changed, 2);

    let old = get_action_job(&connection, "old")
        .expect("read")
        .expect("old");
    assert_eq!(old.status, ActionJobStatus::Cancelled);
    assert_eq!(old.superseded_at, Some(300));
    assert_eq!(old.superseded_by_job_id.as_deref(), Some("current"));
    assert_eq!(
        old.current_step.as_deref(),
        Some("Superseded by a newer head commit")
    );

    let completed = get_action_job(&connection, "completed")
        .expect("read")
        .expect("completed");
    assert_eq!(completed.status, ActionJobStatus::Completed);
    assert_eq!(completed.superseded_at, Some(300));
    assert_eq!(completed.current_step, None);

    let already = get_action_job(&connection, "already")
        .expect("read")
        .expect("job");
    assert_eq!(already.superseded_at, Some(171));
    assert_eq!(already.superseded_by_job_id.as_deref(), Some("prior"));

    for id in ["current", "cancelled", "local", "other-head"] {
        let job = get_action_job(&connection, id).expect("read").expect("job");
        assert_eq!(job.superseded_at, None, "{id} must not be superseded");
    }
}

#[test]
fn supersedes_branch_targets_when_no_pull_request_number_is_recorded() {
    let (_directory, db) = state();
    let connection = db.connect().expect("connection");
    let mut branch_a = job("branch-a", "head-a", 100);
    branch_a.pr_number = 0;
    branch_a.branch = "codex/issue-7".to_string();
    create_action_job(&connection, branch_a, 100).expect("branch a");
    let mut branch_b = job("branch-b", "head-b", 110);
    branch_b.pr_number = 0;
    branch_b.branch = "codex/issue-8".to_string();
    create_action_job(&connection, branch_b, 110).expect("branch b");

    let changed = supersede_review_jobs_for_new_head(
        &connection,
        &SupersedeReviewJobsInput {
            project_id: " project-1 ".to_string(),
            pr_number: None,
            branch: Some(" codex/issue-7 ".to_string()),
            keep_head_sha: " head-new ".to_string(),
            superseded_by_job_id: " new-job ".to_string(),
        },
        300,
    )
    .expect("supersede branch");
    assert_eq!(changed, 1);
    assert!(
        get_action_job(&connection, "branch-a")
            .expect("read")
            .expect("a")
            .superseded_at
            .is_some()
    );
    assert_eq!(
        get_action_job(&connection, "branch-b")
            .expect("read")
            .expect("b")
            .superseded_at,
        None
    );

    assert_eq!(
        supersede_review_jobs_for_new_head(
            &connection,
            &SupersedeReviewJobsInput {
                project_id: "project-1".to_string(),
                pr_number: None,
                branch: None,
                keep_head_sha: "head".to_string(),
                superseded_by_job_id: "job".to_string(),
            },
            400,
        )
        .expect("missing target"),
        0
    );
}
