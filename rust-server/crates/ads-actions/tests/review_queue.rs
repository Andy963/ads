use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ads_actions::{
    IssueCommentRequest, LaneMessage, ResolvedReview, ReviewDispatchRequest, ReviewError,
    ReviewQueue, ReviewQueueOptions, ReviewerRequest, TargetResolver,
};
use ads_reviewer::{ReviewIssue, ReviewTestReport, ReviewVerdict, ReviewVerdictStatus};
use ads_state::{
    ActionJobKind, ActionJobStatus, ActionJobStatusUpdate, CreateActionJob, StateDb,
    UpsertWebProject, WEB_ACTIONS_NAMESPACE, acquire_review_queue_lease, bump_lane_generation,
    create_action_job, ensure_web_project_tables, get_action_job, list_action_jobs,
    logical_history_key, supersede_review_jobs_for_new_head, update_action_job_status,
    upsert_web_project,
};
use serde_json::Value;
use tempfile::{TempDir, tempdir};

const BASE_FAKE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_OLD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD_NEW: &str = "cccccccccccccccccccccccccccccccccccccccc";

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn repo() -> (TempDir, PathBuf, String, String) {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().to_path_buf();
    git(&path, &["init", "-q"]);
    git(&path, &["config", "user.email", "reviewer@example.com"]);
    git(&path, &["config", "user.name", "Reviewer"]);
    std::fs::write(path.join("a.txt"), "one\n").expect("write a");
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "base"]);
    let base = git(&path, &["rev-parse", "HEAD"]);
    std::fs::write(path.join("b.txt"), "two\n").expect("write b");
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "head"]);
    let head = git(&path, &["rev-parse", "HEAD"]);
    (directory, path, base, head)
}

fn options() -> ReviewQueueOptions {
    ReviewQueueOptions::default()
}

fn resolved(repo: &Path, base: &str, head: &str) -> ResolvedReview {
    let project_id = ads_state::derive_project_session_id(&repo.to_string_lossy());
    ResolvedReview {
        project_id,
        repo_path: repo.to_path_buf(),
        auth_user_id: "user-1".to_string(),
        branch: "codex/issue-7".to_string(),
        pr_number: 12,
        pr_url: "https://github.com/example/pull/12".to_string(),
        target: ads_reviewer::ReviewTarget {
            issue: ReviewIssue {
                id: Some(7),
                title: "Fix the bug".to_string(),
                description: Some("The bug description".to_string()),
                acceptance_criteria: Some(vec!["Criterion".to_string()]),
            },
            adrs: None,
            base_ref: "dev".to_string(),
            head_ref: "HEAD".to_string(),
            base_commit: Some(base.to_string()),
            head_commit: Some(head.to_string()),
        },
    }
}

fn fixed_resolver(target: ResolvedReview) -> TargetResolver {
    Arc::new(move |_request| {
        let target = target.clone();
        Box::pin(async move { Ok(target) })
    })
}

fn changed_resolver(first: ResolvedReview, second: ResolvedReview) -> TargetResolver {
    let calls = Arc::new(AtomicUsize::new(0));
    Arc::new(move |_request| {
        let first = first.clone();
        let second = second.clone();
        let calls = calls.clone();
        Box::pin(async move {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(first)
            } else {
                Ok(second)
            }
        })
    })
}

fn pass_reviewer() -> ads_actions::ReviewerRunner {
    pass_reviewer_with_verification(true, 0)
}

fn pass_reviewer_with_verification(started: bool, exit_code: i64) -> ads_actions::ReviewerRunner {
    Arc::new(move |request: ReviewerRequest| {
        request
            .verification_report
            .lock()
            .expect("verification report")
            .commands
            .push(ReviewTestReport {
                command: "[\"cargo\",\"test\"]".to_string(),
                exit_code,
                summary: if exit_code == 0 {
                    "passed".to_string()
                } else {
                    format!("failed with exit code {exit_code}")
                },
                output: Some("ok".to_string()),
                started,
            });
        Box::pin(async {
            Ok(ReviewVerdict {
                status: ReviewVerdictStatus::Pass,
                summary: "All good".to_string(),
                defects: Vec::new(),
                reviewer_profile_id: None,
                reviewed_at: 1_700_000_000_000,
            })
        })
    })
}

fn failing_reviewer(message: &'static str) -> ads_actions::ReviewerRunner {
    let message = message.to_string();
    Arc::new(move |_request: ReviewerRequest| {
        let message = message.clone();
        Box::pin(async move { Err(ReviewError::Other(message)) })
    })
}

fn incomplete_reviewer() -> ads_actions::ReviewerRunner {
    Arc::new(|_request: ReviewerRequest| {
        Box::pin(async { Err(ReviewError::Incomplete("missing evidence".to_string())) })
    })
}

fn state() -> (TempDir, StateDb) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    (directory, db)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as i64
}

fn dispatch_request(
    project_id: String,
    repo: &Path,
    branch: Option<&str>,
    pr_number: Option<i64>,
) -> ReviewDispatchRequest {
    ReviewDispatchRequest {
        project_id,
        repo_path: repo.to_path_buf(),
        auth_user_id: "user-1".to_string(),
        branch: branch.map(str::to_string),
        pr_number,
        lane_generation: 1,
        chat_session_id: Some("main".to_string()),
        rework_declaration: None,
        current_head_sha: Some("test-head".to_string()),
        automatic: false,
    }
}

#[tokio::test]
async fn dispatches_review_jobs_and_deduplicates() {
    let (_directory, db) = state();
    let queue = ReviewQueue::new(db.clone(), "worker-1", options());
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());

    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    assert!(ack.ok);
    assert_eq!(ack.status, ActionJobStatus::Queued);
    assert_eq!(ack.issue_id, Some(7));
    assert!(!ack.job_id.is_empty());
    assert_eq!(ack.note, ads_actions::REVIEW_QUEUE_NOTE);

    let first_job_id = ack.job_id.clone();
    let duplicate = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            2_000,
        )
        .expect("dedupe");
    assert_eq!(duplicate.job_id, first_job_id);

    let same_branch_no_pr = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), None),
            3_000,
        )
        .expect("dedupe branch");
    assert_eq!(same_branch_no_pr.job_id, first_job_id);

    let other_branch = queue
        .dispatch(
            dispatch_request(project, &repo, Some("codex/issue-8"), None),
            4_000,
        )
        .expect("other dispatch");
    assert_ne!(other_branch.job_id, first_job_id);
    assert_eq!(other_branch.issue_id, Some(8));
}

#[test]
fn requires_rework_for_latest_reject_and_does_not_reuse_an_older_reject() {
    let (_directory, db) = state();
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    let connection = db.connect().expect("connection");
    for (id, status, step, verdict, created_at) in [
        (
            "reject",
            ActionJobStatus::Completed,
            "REJECT: defect",
            ReviewVerdictStatus::Reject,
            1_000,
        ),
        (
            "pass",
            ActionJobStatus::Completed,
            "PASS: fixed",
            ReviewVerdictStatus::Pass,
            2_000,
        ),
    ] {
        let job = create_action_job(
            &connection,
            CreateActionJob {
                id: id.to_string(),
                project_id: project.clone(),
                lane_generation: Some(1),
                acopilot_lane_generation: 1,
                job_kind: ActionJobKind::PullRequestReview,
                issue_id: 7,
                issue_title: "Fix the bug".to_string(),
                issue_snapshot: Default::default(),
                status: Some(ActionJobStatus::Queued),
                branch: "codex/issue-7".to_string(),
                base_sha: BASE_FAKE.to_string(),
                head_sha: HEAD_OLD.to_string(),
                reviewer_profile_ids_json: "[]".to_string(),
                pr_number: 12,
                pr_url: "https://github.com/example/pull/12".to_string(),
                auth_user_id: "user-1".to_string(),
                chat_session_id: "main".to_string(),
                rework_declaration_json: None,
                rework_root_job_id: None,
            },
            created_at,
        )
        .expect("review job");
        update_action_job_status(
            &connection,
            &job.id,
            status,
            ActionJobStatusUpdate {
                current_step: Some(Some(step.to_string())),
                review_verdicts_json: Some(Some(
                    serde_json::to_string(&[ReviewVerdict {
                        status: verdict,
                        summary: step.to_string(),
                        defects: Vec::new(),
                        reviewer_profile_id: None,
                        reviewed_at: created_at,
                    }])
                    .expect("verdict json"),
                )),
                ..ActionJobStatusUpdate::default()
            },
            created_at,
            false,
        )
        .expect("review outcome");
    }

    let queue = ReviewQueue::new(db, "worker-1", options());
    let mut request = dispatch_request(project, &repo, Some("codex/issue-7"), Some(12));
    request.rework_declaration = Some(serde_json::json!({
        "prior_job_id": "reject",
        "issue_id": 7,
        "pr_number": 12,
        "base_sha": BASE_FAKE,
        "rejected_head_sha": HEAD_OLD,
        "new_head_sha": HEAD_NEW,
        "root_cause": "fixed",
        "invariant": "preserved",
        "audited_scope": ["src"],
        "changed_behavior": "corrected",
        "regression_cases": ["reject stale declaration"],
        "verification_evidence": ["tests pass"],
        "residual_risks": []
    }));
    let error = queue
        .dispatch(request, 3_000)
        .expect_err("declaration from an older REJECT cannot be reused");
    assert!(error.to_string().contains("only valid after a REJECT"));
}

#[tokio::test]
async fn carries_rework_declaration_across_operational_review_retries() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    let connection = db.connect().expect("connection");
    let rejected = create_action_job(
        &connection,
        CreateActionJob {
            id: "reject".to_string(),
            project_id: project.clone(),
            lane_generation: Some(1),
            acopilot_lane_generation: 1,
            job_kind: ActionJobKind::PullRequestReview,
            issue_id: 7,
            issue_title: "Fix the bug".to_string(),
            issue_snapshot: Default::default(),
            status: Some(ActionJobStatus::Completed),
            branch: "codex/issue-7".to_string(),
            base_sha: base.clone(),
            head_sha: base.clone(),
            reviewer_profile_ids_json: "[]".to_string(),
            pr_number: 12,
            pr_url: "https://github.com/example/pull/12".to_string(),
            auth_user_id: "user-1".to_string(),
            chat_session_id: "main".to_string(),
            rework_declaration_json: None,
            rework_root_job_id: None,
        },
        1_000,
    )
    .expect("reject job");
    update_action_job_status(
        &connection,
        &rejected.id,
        ActionJobStatus::Completed,
        ActionJobStatusUpdate {
            current_step: Some(Some("REJECT: defect".to_string())),
            review_verdicts_json: Some(Some(
                serde_json::to_string(&[ReviewVerdict {
                    status: ReviewVerdictStatus::Reject,
                    summary: "defect".to_string(),
                    defects: Vec::new(),
                    reviewer_profile_id: None,
                    reviewed_at: 1_000,
                }])
                .expect("verdict json"),
            )),
            ..ActionJobStatusUpdate::default()
        },
        1_000,
        false,
    )
    .expect("reject verdict");
    drop(connection);

    let declaration = serde_json::json!({
        "prior_job_id": "reject",
        "issue_id": 7,
        "pr_number": 12,
        "base_sha": base,
        "rejected_head_sha": base,
        "new_head_sha": head,
        "root_cause": "root cause",
        "invariant": "invariant",
        "audited_scope": ["source"],
        "changed_behavior": "behavior",
        "regression_cases": ["regression"],
        "verification_evidence": ["tests pass"],
        "residual_risks": []
    });
    let mut first_options = options();
    first_options.target_resolver = Some(fixed_resolver(resolved(&repo, &base, &head)));
    first_options.reviewer = Some(incomplete_reviewer());
    let first_queue = ReviewQueue::new(db.clone(), "worker-1", first_options);
    let mut first_retry = dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12));
    first_retry.rework_declaration = Some(declaration.clone());
    first_retry.current_head_sha = Some(head.clone());
    let first_ack = first_queue
        .dispatch(first_retry, 2_000)
        .expect("declared retry");
    first_queue
        .process(&project, &repo)
        .await
        .expect("first operational retry");
    let connection = db.connect().expect("connection");
    let first_retry_job = get_action_job(&connection, &first_ack.job_id)
        .expect("read first retry")
        .expect("first retry job");
    assert_eq!(first_retry_job.status, ActionJobStatus::Completed);
    assert!(
        first_retry_job
            .current_step
            .as_deref()
            .is_some_and(|step| step.starts_with("INCOMPLETE:"))
    );
    let rejected = get_action_job(&connection, "reject")
        .expect("read rejected job")
        .expect("rejected job");
    assert!(rejected.superseded_at.is_some());
    drop(connection);

    std::fs::write(repo.join("c.txt"), "three\n").expect("write newer head");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "newer review head"]);
    let newer_head = git(&repo, &["rev-parse", "HEAD"]);
    let mut updated_declaration = declaration.clone();
    updated_declaration["new_head_sha"] = Value::String(newer_head.clone());
    updated_declaration["verification_evidence"] =
        serde_json::json!(["verification rerun for updated head"]);

    let mut second_retry =
        dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12));
    second_retry.current_head_sha = Some(newer_head.clone());
    second_retry.rework_declaration = Some(updated_declaration.clone());
    let second_ack = first_queue
        .dispatch(second_retry, 4_000)
        .expect("operational retry with updated head declaration");
    let connection = db.connect().expect("connection");
    let retry = get_action_job(&connection, &second_ack.job_id)
        .expect("read retry")
        .expect("retry job");
    assert_eq!(
        retry.rework_declaration_json.as_deref(),
        Some(updated_declaration.to_string().as_str())
    );
    assert_eq!(retry.rework_root_job_id.as_deref(), Some("reject"));
    drop(connection);

    let mut second_options = options();
    second_options.target_resolver = Some(fixed_resolver(resolved(&repo, &base, &newer_head)));
    second_options.reviewer = Some(pass_reviewer());
    let second_queue = ReviewQueue::new(db.clone(), "worker-2", second_options);
    second_queue
        .process(&project, &repo)
        .await
        .expect("process retry after supersession");

    let connection = db.connect().expect("connection");
    let completed_retry = get_action_job(&connection, &second_ack.job_id)
        .expect("read completed retry")
        .expect("completed retry job");
    assert_eq!(completed_retry.status, ActionJobStatus::Completed);
    assert!(
        completed_retry
            .current_step
            .as_deref()
            .is_some_and(|step| step.starts_with("PASS:")),
        "unexpected retry outcome: {:?}",
        completed_retry.current_step
    );
}

#[tokio::test]
async fn blocks_automatic_retry_after_repeated_operational_failures() {
    let (_directory, db) = state();
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    {
        let connection = db.connect().expect("connection");
        for (index, created_at) in [(1_i64, 8_000_i64), (2_i64, 9_000_i64)] {
            let job = create_action_job(
                &connection,
                ads_state::CreateActionJob {
                    id: format!("failed-{index}"),
                    project_id: project.clone(),
                    lane_generation: Some(1),
                    acopilot_lane_generation: 1,
                    job_kind: ActionJobKind::PullRequestReview,
                    issue_id: 7,
                    issue_title: "Fix the bug".to_string(),
                    issue_snapshot: Default::default(),
                    status: Some(ActionJobStatus::Queued),
                    branch: "codex/issue-7".to_string(),
                    base_sha: String::new(),
                    head_sha: String::new(),
                    reviewer_profile_ids_json: "[]".to_string(),
                    pr_number: 12,
                    pr_url: String::new(),
                    auth_user_id: "user-1".to_string(),
                    chat_session_id: "main".to_string(),
                    rework_declaration_json: None,
                    rework_root_job_id: None,
                },
                created_at,
            )
            .expect("job");
            update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Failed,
                ActionJobStatusUpdate {
                    error_message: Some(Some(
                        "Native upstream request failed with status 503".to_string(),
                    )),
                    ..ActionJobStatusUpdate::default()
                },
                created_at,
                false,
            )
            .expect("failed status");
        }
    }

    let queue = ReviewQueue::new(db.clone(), "worker-1", options());
    let mut automatic = dispatch_request(project.clone(), &repo, Some("codex/issue-7"), None);
    automatic.automatic = true;
    let error = queue
        .dispatch(automatic, 10_000)
        .expect_err("circuit breaker");
    assert!(error.to_string().contains("Automatic review retry paused"));
    let connection = db.connect().expect("connection");
    assert_eq!(
        list_action_jobs(&connection, &project, None, Some("user-1"))
            .expect("jobs")
            .len(),
        2
    );

    let manual = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), None),
            10_000,
        )
        .expect("manual retry");
    assert_eq!(manual.status, ActionJobStatus::Queued);
}

#[tokio::test]
async fn production_resolution_rejects_unowned_project_workspaces() {
    let (_directory, db) = state();
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    let queue = ReviewQueue::new(db.clone(), "worker-1", options());
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), None),
            1_000,
        )
        .expect("dispatch");
    queue.process(&project, &repo).await.expect("process");
    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Failed);
    assert_eq!(
        job.error_message.as_deref(),
        Some("Interactive review is limited to the authenticated project workspace.")
    );
}

#[test]
fn dispatch_uses_the_project_actions_lane_identity() {
    let (_directory, db) = state();
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    let logical_key = logical_history_key("user-1", &project, "chat-42");
    {
        let mut connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
                 VALUES ('user-1', 'admin', 'hash', 1, 1)",
                [],
            )
            .expect("user");
        ensure_web_project_tables(&connection).expect("project tables");
        upsert_web_project(
            &connection,
            UpsertWebProject {
                user_id: "user-1",
                project_id: &project,
                workspace_root: &repo.to_string_lossy(),
                name: "Review project",
                chat_session_id: Some("chat-42"),
            },
            1_000,
        )
        .expect("project");
        assert_eq!(
            bump_lane_generation(&mut connection, WEB_ACTIONS_NAMESPACE, &logical_key, 2_000)
                .expect("generation"),
            2
        );
    }

    let queue = ReviewQueue::new(db.clone(), "worker-1", options());
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), None),
            3_000,
        )
        .expect("dispatch");
    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.chat_session_id.as_deref(), Some("chat-42"));
    assert_eq!(job.lane_generation, 2);
}

#[tokio::test]
async fn processes_a_review_end_to_end() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();

    let comments = Arc::new(Mutex::new(Vec::new()));
    let messages = Arc::new(Mutex::new(Vec::new()));
    let wakes = Arc::new(Mutex::new(Vec::new()));
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target.clone()));
    options.reviewer = Some(pass_reviewer());
    options.publisher = Some(Arc::new({
        let comments = comments.clone();
        move |request: IssueCommentRequest| {
            let comments = comments.clone();
            Box::pin(async move {
                comments.lock().expect("comments").push(request);
                Ok(())
            })
        }
    }));
    options.messenger = Some(Arc::new({
        let messages = messages.clone();
        move |message: LaneMessage| {
            messages.lock().expect("messages").push(message);
        }
    }));
    options.waker = Some(Arc::new({
        let wakes = wakes.clone();
        move |wake: ads_actions::AcopilotWake| {
            wakes.lock().expect("wakes").push(wake);
        }
    }));

    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    let acquired = queue.process(&project, &repo).await.expect("process");
    assert!(acquired);

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert!(
        job.current_step
            .as_deref()
            .unwrap_or("")
            .starts_with("PASS: All good")
    );
    assert_eq!(job.issue_id, Some(7));
    assert_eq!(job.head_sha.as_deref(), Some(head.as_str()));
    assert_eq!(job.base_sha.as_deref(), Some(base.as_str()));
    assert_eq!(job.pr_number, Some(12));
    let verdicts: Value = serde_json::from_str(&job.review_verdicts_json).expect("verdicts");
    assert_eq!(verdicts[0]["status"], "PASS");
    let report: Value = serde_json::from_str(&job.verification_report_json).expect("report");
    assert_eq!(report["commands"][0]["command"], "[\"cargo\",\"test\"]");
    assert_eq!(report["commands"][0]["exitCode"], 0);
    assert_eq!(report["commands"][0]["started"], true);

    let comments = comments.lock().expect("comments");
    assert_eq!(comments.len(), 1);
    assert!(comments[0].body.contains("<!-- ads:review-verdict -->"));
    assert!(comments[0].body.contains("## ADS Reviewer verdict: PASS"));
    let messages = messages.lock().expect("messages");
    let kinds = messages
        .iter()
        .map(|message| message.kind.as_str())
        .collect::<Vec<_>>();
    assert!(kinds.iter().any(|kind| kind.ends_with(":started")));
    assert!(kinds.iter().any(|kind| kind.ends_with(":verification")));
    assert!(kinds.iter().any(|kind| kind.ends_with(":completed")));
    assert!(kinds.iter().any(|kind| kind.ends_with(":result")));
    let wakes = wakes.lock().expect("wakes");
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].issue_id, 7);
    assert_eq!(
        wakes[0].issue_url.as_deref(),
        Some("https://github.com/example/issues/7")
    );
    assert_eq!(wakes[0].status.as_str(), "PASS");
}

#[tokio::test]
async fn allows_pass_after_started_successful_verification() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(pass_reviewer_with_verification(true, 0));
    options.publisher = Some(Arc::new(|_request: IssueCommentRequest| {
        Box::pin(async { Ok(()) })
    }));

    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    assert!(queue.process(&project, &repo).await.expect("process"));

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert!(
        job.current_step
            .as_deref()
            .unwrap_or("")
            .starts_with("PASS:")
    );
    let verdicts: Value = serde_json::from_str(&job.review_verdicts_json).expect("verdicts");
    assert_eq!(verdicts[0]["status"], "PASS");
    let report: Value = serde_json::from_str(&job.verification_report_json).expect("report");
    assert_eq!(report["commands"][0]["started"], true);
}

#[tokio::test]
async fn refuses_pass_when_reviewer_verification_fails() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(pass_reviewer_with_verification(true, 1));
    options.publisher = Some(Arc::new(|_request: IssueCommentRequest| {
        Box::pin(async { Ok(()) })
    }));

    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    assert!(queue.process(&project, &repo).await.expect("process"));

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert!(
        job.current_step
            .as_deref()
            .unwrap_or("")
            .starts_with("INCOMPLETE:")
    );
    let verdicts: Value = serde_json::from_str(&job.review_verdicts_json).expect("verdicts");
    assert_eq!(verdicts[0]["status"], "INCOMPLETE");
    let report: Value = serde_json::from_str(&job.verification_report_json).expect("report");
    assert_eq!(report["commands"][0]["exitCode"], 1);
    assert_eq!(report["commands"][0]["started"], true);
}

#[tokio::test]
async fn validates_and_delivers_rework_declaration_on_the_pinned_target() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let connection = db.connect().expect("connection");
    let rejected = create_action_job(
        &connection,
        CreateActionJob {
            id: "reject".to_string(),
            project_id: project.clone(),
            lane_generation: Some(1),
            acopilot_lane_generation: 1,
            job_kind: ActionJobKind::PullRequestReview,
            issue_id: 7,
            issue_title: "Fix the bug".to_string(),
            issue_snapshot: Default::default(),
            status: Some(ActionJobStatus::Completed),
            branch: "codex/issue-7".to_string(),
            base_sha: base.clone(),
            head_sha: base.clone(),
            reviewer_profile_ids_json: "[]".to_string(),
            pr_number: 12,
            pr_url: "https://github.com/example/pull/12".to_string(),
            auth_user_id: "user-1".to_string(),
            chat_session_id: "main".to_string(),
            rework_declaration_json: None,
            rework_root_job_id: None,
        },
        1_000,
    )
    .expect("reject job");
    update_action_job_status(
        &connection,
        &rejected.id,
        ActionJobStatus::Completed,
        ActionJobStatusUpdate {
            current_step: Some(Some("REJECT: defect".to_string())),
            review_verdicts_json: Some(Some(
                serde_json::to_string(&[ReviewVerdict {
                    status: ReviewVerdictStatus::Reject,
                    summary: "defect".to_string(),
                    defects: Vec::new(),
                    reviewer_profile_id: None,
                    reviewed_at: 1_000,
                }])
                .expect("verdict json"),
            )),
            ..ActionJobStatusUpdate::default()
        },
        1_000,
        false,
    )
    .expect("reject verdict");
    drop(connection);

    let declaration = serde_json::json!({
        "prior_job_id": "reject",
        "issue_id": 7,
        "pr_number": 12,
        "base_sha": base,
        "rejected_head_sha": base,
        "new_head_sha": head,
        "root_cause": "root cause",
        "invariant": "invariant",
        "audited_scope": ["source"],
        "changed_behavior": "behavior",
        "regression_cases": ["regression"],
        "verification_evidence": ["tests pass"],
        "residual_risks": []
    });
    let observed_declaration = Arc::new(Mutex::new(None));
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(Arc::new({
        let observed_declaration = observed_declaration.clone();
        move |request: ReviewerRequest| {
            let observed_declaration = observed_declaration.clone();
            Box::pin(async move {
                request
                    .verification_report
                    .lock()
                    .expect("verification report")
                    .commands
                    .push(ReviewTestReport {
                        command: "[\"cargo\",\"test\"]".to_string(),
                        exit_code: 0,
                        summary: "passed".to_string(),
                        output: Some("ok".to_string()),
                        started: true,
                    });
                *observed_declaration.lock().expect("declaration") =
                    request.payload.rework_declaration;
                Ok(ReviewVerdict {
                    status: ReviewVerdictStatus::Pass,
                    summary: "Rework verified".to_string(),
                    defects: Vec::new(),
                    reviewer_profile_id: None,
                    reviewed_at: 2_000,
                })
            })
        }
    }));
    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let mut request = dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12));
    request.rework_declaration = Some(declaration.clone());
    request.current_head_sha = Some(head);
    let ack = queue.dispatch(request, 2_000).expect("declared review");
    queue
        .process(&project, &repo)
        .await
        .expect("process review");

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read job")
        .expect("review job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert!(job.review_verdicts_json.contains("PASS"));
    assert_eq!(
        job.rework_declaration_json.as_deref(),
        Some(declaration.to_string().as_str())
    );
    assert_eq!(job.rework_root_job_id.as_deref(), Some("reject"));
    assert_eq!(
        *observed_declaration.lock().expect("declaration"),
        Some(declaration)
    );
}

#[tokio::test]
async fn fails_the_job_when_the_reviewer_errors() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(failing_reviewer("boom"));
    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    queue.process(&project, &repo).await.expect("process");
    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Failed);
    assert_eq!(job.error_message.as_deref(), Some("boom"));
    assert_eq!(
        job.current_step.as_deref(),
        Some("Review job failed before producing an authoritative verdict")
    );
    assert_eq!(job.review_verdicts_json, "[]");
}

#[tokio::test]
async fn completes_incomplete_verdicts_and_publishes_outcome() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let comments = Arc::new(Mutex::new(Vec::new()));
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(incomplete_reviewer());
    options.publisher = Some(Arc::new({
        let comments = comments.clone();
        move |request: IssueCommentRequest| {
            let comments = comments.clone();
            Box::pin(async move {
                comments.lock().expect("comments").push(request);
                Ok(())
            })
        }
    }));
    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    queue.process(&project, &repo).await.expect("process");

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert_eq!(
        job.current_step.as_deref(),
        Some("INCOMPLETE: missing evidence")
    );
    let verdicts: Value = serde_json::from_str(&job.review_verdicts_json).expect("verdicts");
    assert_eq!(verdicts[0]["status"], "INCOMPLETE");
    assert_eq!(verdicts[0]["summary"], "missing evidence");
    let comments = comments.lock().expect("comments");
    assert_eq!(comments.len(), 1);
    assert!(comments[0].body.contains("INCOMPLETE"));
    assert!(comments[0].body.contains("No code was rejected"));
}

#[tokio::test]
async fn does_not_publish_when_the_job_was_superseded_during_review() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let project = target.project_id.clone();
    let comments = Arc::new(Mutex::new(Vec::new()));
    let messages = Arc::new(Mutex::new(Vec::new()));
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.reviewer = Some(Arc::new({
        let db = db.clone();
        let project = project.clone();
        move |request: ReviewerRequest| {
            let db = db.clone();
            let project = project.clone();
            Box::pin(async move {
                request
                    .verification_report
                    .lock()
                    .expect("verification report")
                    .commands
                    .push(ReviewTestReport {
                        command: "[\"cargo\",\"test\"]".to_string(),
                        exit_code: 0,
                        summary: "passed".to_string(),
                        output: Some("ok".to_string()),
                        started: true,
                    });
                let connection = db.connect().expect("connection");
                supersede_review_jobs_for_new_head(
                    &connection,
                    &ads_state::SupersedeReviewJobsInput {
                        project_id: project,
                        pr_number: Some(12),
                        branch: Some("codex/issue-7".to_string()),
                        keep_head_sha: "never-seen-head".to_string(),
                        superseded_by_job_id: "newer-job".to_string(),
                    },
                    5_000,
                )
                .expect("supersede");
                Ok(ReviewVerdict {
                    status: ReviewVerdictStatus::Pass,
                    summary: "too late".to_string(),
                    defects: Vec::new(),
                    reviewer_profile_id: None,
                    reviewed_at: 1_700_000_000_000,
                })
            })
        }
    }));
    options.publisher = Some(Arc::new({
        let comments = comments.clone();
        move |request: IssueCommentRequest| {
            let comments = comments.clone();
            Box::pin(async move {
                comments.lock().expect("comments").push(request);
                Ok(())
            })
        }
    }));
    options.messenger = Some(Arc::new({
        let messages = messages.clone();
        move |message: LaneMessage| {
            messages.lock().expect("messages").push(message);
        }
    }));
    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    queue.process(&project, &repo).await.expect("process");

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.superseded_at, Some(5_000));
    assert!(comments.lock().expect("comments").is_empty());
    let messages = messages.lock().expect("messages");
    assert!(
        messages
            .iter()
            .any(|message| message.kind.ends_with(":superseded"))
    );
}

#[tokio::test]
async fn marks_incomplete_when_the_target_changed_during_review() {
    let (_directory, db) = state();
    let (_temp, repo, base, head) = repo();
    let target = resolved(&repo, &base, &head);
    let changed_target = ResolvedReview {
        target: ads_reviewer::ReviewTarget {
            head_commit: Some(HEAD_NEW.to_string()),
            ..target.target.clone()
        },
        ..target.clone()
    };
    let project = target.project_id.clone();
    let mut options = options();
    options.target_resolver = Some(changed_resolver(target, changed_target));
    options.reviewer = Some(pass_reviewer());
    let queue = ReviewQueue::new(db.clone(), "worker-1", options);
    let ack = queue
        .dispatch(
            dispatch_request(project.clone(), &repo, Some("codex/issue-7"), Some(12)),
            1_000,
        )
        .expect("dispatch");
    queue.process(&project, &repo).await.expect("process");

    let connection = db.connect().expect("connection");
    let job = get_action_job(&connection, &ack.job_id)
        .expect("read")
        .expect("job");
    assert_eq!(job.status, ActionJobStatus::Completed);
    assert!(
        job.current_step
            .as_deref()
            .unwrap_or("")
            .starts_with("INCOMPLETE: Interactive review target changed during")
    );
}

#[tokio::test]
async fn fails_interrupted_jobs_and_respects_external_leases() {
    let (_directory, db) = state();
    let (_temp, repo, _base, _head) = repo();
    let project = ads_state::derive_project_session_id(&repo.to_string_lossy());
    let connection = db.connect().expect("connection");
    let target = resolved(&repo, BASE_FAKE, HEAD_OLD);
    create_action_job(
        &connection,
        ads_state::CreateActionJob {
            id: "job-1".to_string(),
            project_id: project.clone(),
            lane_generation: Some(1),
            acopilot_lane_generation: 1,
            job_kind: ActionJobKind::PullRequestReview,
            issue_id: 7,
            issue_title: "Fix".to_string(),
            issue_snapshot: ads_state::ActionJobIssueSnapshot::default(),
            status: Some(ActionJobStatus::Reviewing),
            branch: "codex/issue-7".to_string(),
            base_sha: String::new(),
            head_sha: String::new(),
            reviewer_profile_ids_json: "[]".to_string(),
            pr_number: 12,
            pr_url: String::new(),
            auth_user_id: "user-1".to_string(),
            chat_session_id: "main".to_string(),
            rework_declaration_json: None,
            rework_root_job_id: None,
        },
        1_000,
    )
    .expect("create");

    let messages = Arc::new(Mutex::new(Vec::new()));
    let mut options = options();
    options.target_resolver = Some(fixed_resolver(target));
    options.messenger = Some(Arc::new({
        let messages = messages.clone();
        move |message: LaneMessage| {
            messages.lock().expect("messages").push(message);
        }
    }));
    let queue = ReviewQueue::new(db.clone(), "worker-1", options.clone());
    let acquired = queue.process(&project, &repo).await.expect("process");
    assert!(acquired);
    let connection = db.connect().expect("connection");
    let interrupted = get_action_job(&connection, "job-1")
        .expect("read")
        .expect("job");
    assert_eq!(interrupted.status, ActionJobStatus::Failed);
    assert_eq!(
        interrupted.error_message.as_deref(),
        Some(
            "The review job has no active worker. Dispatch a new review to retry the pinned target."
        )
    );
    {
        let messages = messages.lock().expect("messages");
        assert!(
            messages
                .iter()
                .any(|message| message.kind.ends_with(":interrupted"))
        );
    }

    let other = ReviewQueue::new(db.clone(), "worker-2", options);
    let acquired = other.process(&project, &repo).await.expect("process");
    assert!(acquired);

    let connection = db.connect().expect("connection");
    acquire_review_queue_lease(&connection, &project, "owner-x", 90_000, now_ms()).expect("lease");
    let blocked = ReviewQueue::new(db.clone(), "worker-3", ReviewQueueOptions::default());
    let acquired = blocked.process(&project, &repo).await.expect("process");
    assert!(!acquired);
}
