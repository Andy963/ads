use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_reviewer::{
    IssueVerdictCommentInput, IssueVerdictStatus, ReviewTestReport, ReviewVerdict,
    ReviewVerdictStatus, build_issue_verdict_comment, capture_review_payload_async,
    format_review_verdict_presentation,
};
use ads_state::{
    ActionJobAdr, ActionJobIssueSnapshot, ActionJobKind, ActionJobPinnedTarget, ActionJobRecord,
    ActionJobStatus, ActionJobStatusUpdate, StateDb, SupersedeReviewJobsInput,
    acquire_review_queue_lease, claim_queued_review_job, fail_interrupted_review_jobs,
    get_action_job, list_action_jobs, release_review_queue_lease, renew_review_queue_lease,
    supersede_review_jobs_for_new_head, update_action_job_pinned_target, update_action_job_status,
};
use chrono::Utc;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::defaults::{default_publisher, default_reviewer_runner, default_verification_runner};
use crate::dispatch::{canonical_project_id, issue_id_from_branch};
use crate::types::{
    AcopilotWake, BoxFuture, IssueCommentRequest, LaneMessage, LaneMessageRole,
    ResolveReviewRequest, ResolvedReview, ReviewError, ReviewQueueAck, ReviewQueueOptions,
    ReviewerRequest, ReviewerRunner, TargetResolver, VerificationRunner,
};

const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(90);
const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(30);
const DEFAULT_VERIFICATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DEFAULT_REVIEWER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DEFAULT_TEST_COMMAND: &str = "npm test";

#[derive(Clone)]
pub struct ReviewQueue {
    db: StateDb,
    worker_id: String,
    options: ReviewQueueOptions,
    active: Arc<Mutex<HashSet<String>>>,
}

impl ReviewQueue {
    pub fn new(db: StateDb, worker_id: impl Into<String>, options: ReviewQueueOptions) -> Self {
        let worker_id = worker_id.into().trim().to_string();
        Self {
            db,
            worker_id: if worker_id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                worker_id
            },
            options,
            active: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn dispatch(
        &self,
        request: crate::dispatch::ReviewDispatchRequest,
        now: i64,
    ) -> Result<ReviewQueueAck, ReviewError> {
        crate::dispatch::dispatch_review_job(&self.db, request, now)
    }

    pub async fn process(&self, project_id: &str, repo_path: &Path) -> Result<bool, ReviewError> {
        let canonical = canonical_project_id(project_id, Some(repo_path));
        {
            let mut active = self.active.lock().expect("active lock");
            if !active.insert(canonical.clone()) {
                return Ok(false);
            }
        }
        let result = self.run_review_queue(&canonical, repo_path).await;
        {
            let mut active = self.active.lock().expect("active lock");
            active.remove(&canonical);
        }
        result
    }

    pub fn spawn_process(&self, project_id: &str, repo_path: &Path) {
        let queue = self.clone();
        let project_id = project_id.to_string();
        let repo_path = repo_path.to_path_buf();
        tokio::spawn(async move {
            let _ = queue.process(&project_id, &repo_path).await;
        });
    }

    async fn run_review_queue(
        &self,
        project_id: &str,
        repo_path: &Path,
    ) -> Result<bool, ReviewError> {
        let ttl = self
            .options
            .lease_ttl
            .unwrap_or(DEFAULT_LEASE_TTL)
            .max(Duration::from_millis(1));
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !acquire_review_queue_lease(
                &connection,
                project_id,
                &self.worker_id,
                ttl.as_millis() as i64,
                now,
            )? {
                return Ok(false);
            }
        }
        let heartbeat_interval = self
            .options
            .heartbeat
            .unwrap_or(DEFAULT_HEARTBEAT)
            .min(ttl / 2)
            .max(Duration::from_millis(1));
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let heartbeat = spawn_heartbeat(
            self.db.clone(),
            project_id.to_string(),
            self.worker_id.clone(),
            ttl.as_millis() as i64,
            heartbeat_interval,
            stop_rx,
        );
        let outcome = async {
            let connection = self.db.connect()?;
            let interrupted = fail_interrupted_review_jobs(&connection, project_id, now_ms())?;
            drop(connection);
            for job in interrupted {
                self.record_action_message(
                    &job,
                    repo_path,
                    format!(
                        "Review was interrupted before producing a verdict for {}. Dispatch a new review to retry.",
                        review_target_label(&job)
                    ),
                    format!("action_step:{}:interrupted", job.id),
                    LaneMessageRole::Status,
                );
            }
            loop {
                let connection = self.db.connect()?;
                let next = list_action_jobs(&connection, project_id, None, None)?
                    .into_iter()
                    .filter(|job| {
                        job.job_kind == ActionJobKind::PullRequestReview
                            && job.status == ActionJobStatus::Queued
                            && job.superseded_at.is_none()
                    })
                    .min_by_key(|job| job.created_at);
                drop(connection);
                let Some(job) = next else {
                    break;
                };
                self.execute_queued_review(&job, repo_path).await?;
            }
            Ok::<(), ReviewError>(())
        }
        .await;
        let _ = stop_tx.send(());
        let _ = heartbeat.await;
        if let Ok(connection) = self.db.connect() {
            let _ = release_review_queue_lease(&connection, project_id, &self.worker_id);
        }
        outcome?;
        Ok(true)
    }

    async fn execute_queued_review(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
    ) -> Result<(), ReviewError> {
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !claim_queued_review_job(&connection, &job.id, now)? {
                return Ok(());
            }
        }
        let step = if job.pr_number.unwrap_or(0) > 0 {
            format!(
                "Checking pinned target for PR #{}",
                job.pr_number.unwrap_or(0)
            )
        } else {
            "Resolving the review target when the job starts".to_string()
        };
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Verifying,
                ActionJobStatusUpdate {
                    current_step: Some(Some(step)),
                    error_message: Some(None),
                    verification_report_json: Some(None),
                    review_verdicts_json: Some(None),
                },
                now,
                true,
            )? {
                return Ok(());
            }
        }
        let result = self.run_review(job, repo_path).await;
        match result {
            Ok(()) => Ok(()),
            Err(ReviewError::Superseded(_)) => {
                self.record_superseded_message(job, repo_path).await;
                Ok(())
            }
            Err(_) if self.is_superseded(&job.id)? => {
                self.record_superseded_message(job, repo_path).await;
                Ok(())
            }
            Err(ReviewError::Incomplete(message)) => {
                self.finish_incomplete(job, repo_path, &message).await?;
                Ok(())
            }
            Err(error) => {
                self.finish_failed(job, repo_path, &error.to_string())
                    .await?;
                Ok(())
            }
        }
    }

    async fn run_review(&self, job: &ActionJobRecord, repo_path: &Path) -> Result<(), ReviewError> {
        if self.options.target_resolver.is_none() {
            let mut connection = self.db.connect()?;
            let canonical = canonical_project_id(&job.project_id, Some(repo_path));
            if crate::dispatch::resolve_actions_lane(
                &mut connection,
                &canonical,
                repo_path,
                job.auth_user_id.as_deref().unwrap_or(""),
                now_ms(),
            )?
            .is_none()
            {
                return Err(ReviewError::Other(
                    "Interactive review is limited to the authenticated project workspace."
                        .to_string(),
                ));
            }
        }
        let request = ResolveReviewRequest {
            project_id: job.project_id.clone(),
            repo_path: repo_path.to_path_buf(),
            auth_user_id: job.auth_user_id.clone().unwrap_or_default(),
            branch: job.branch.clone().filter(|branch| !branch.is_empty()),
            pr_number: job.pr_number.filter(|pr_number| *pr_number > 0),
        };
        let session = (self.resolver())(request.clone()).await?;
        let mut current = job.clone();
        if job_needs_pinning(&current) {
            let now = now_ms();
            let connection = self.db.connect()?;
            let transaction = connection.unchecked_transaction()?;
            let pinned = update_action_job_pinned_target(
                &transaction,
                &current.id,
                &pinned_target(&session),
                now,
            )?;
            if !pinned {
                return Err(ReviewError::Superseded(
                    "The review job was superseded by a newer head commit.".to_string(),
                ));
            }
            self.supersede_older_review_jobs(&transaction, &current, &session)?;
            transaction.commit()?;
            current = get_action_job(&connection, &current.id)?.unwrap_or_else(|| current.clone());
        } else if !review_target_matches_job(&current, &session) {
            return Err(ReviewError::Incomplete(
                "The pull request, Issue, base, head, or ADR snapshot changed after dispatch."
                    .to_string(),
            ));
        } else {
            let connection = self.db.connect()?;
            self.supersede_older_review_jobs(&connection, &current, &session)?;
        }
        self.record_action_message(
            &current,
            repo_path,
            format!("Review started for {}.", review_target_label(&current)),
            format!("action_step:{}:started", current.id),
            LaneMessageRole::Status,
        );
        let cancellation = ads_native::Cancellation::new();
        let session_key = review_key(&session);
        let (verdict, test_report) = self
            .run_interactive_review(&current, &session, &session_key, repo_path, cancellation)
            .await?;
        if self.is_superseded(&current.id)? {
            return Err(ReviewError::Superseded(
                "The review job was superseded by a newer head commit.".to_string(),
            ));
        }
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &current.id,
                ActionJobStatus::Completed,
                ActionJobStatusUpdate {
                    current_step: Some(Some(format!(
                        "{}: {}",
                        verdict.status.as_str(),
                        verdict.summary
                    ))),
                    review_verdicts_json: Some(Some(
                        serde_json::to_string(&[&verdict]).expect("verdict json"),
                    )),
                    verification_report_json: Some(Some(
                        serde_json::to_string(&test_report).expect("report json"),
                    )),
                    error_message: Some(None),
                },
                now,
                true,
            )? {
                return Err(ReviewError::Superseded(
                    "The review job was superseded by a newer head commit.".to_string(),
                ));
            }
        }
        let completed = self.read_job(&current.id)?.unwrap_or(current);
        self.publish_verdict_presentation(&completed, repo_path, &verdict);
        self.publish_outcome(&completed, repo_path, &verdict).await;
        Ok(())
    }

    async fn run_interactive_review(
        &self,
        job: &ActionJobRecord,
        session: &ResolvedReview,
        session_key: &str,
        repo_path: &Path,
        cancellation: ads_native::Cancellation,
    ) -> Result<(ReviewVerdict, ReviewTestReport), ReviewError> {
        let test_report =
            (self.verification())(session.repo_path.clone(), cancellation.clone()).await?;
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Verifying,
                ActionJobStatusUpdate {
                    current_step: Some(Some(format!(
                        "Verification completed: {} (exit {})",
                        test_report.command, test_report.exit_code
                    ))),
                    verification_report_json: Some(Some(serde_json::to_string(&test_report)?)),
                    ..ActionJobStatusUpdate::default()
                },
                now,
                true,
            )? {
                return Err(ReviewError::Superseded(
                    "The review job was superseded by a newer head commit.".to_string(),
                ));
            }
        }
        let target = review_target_label(job);
        self.record_action_message(
            job,
            repo_path,
            if test_report.exit_code == 0 {
                format!("Checks passed for {target}.")
            } else {
                format!(
                    "Checks failed for {target} (exit {}): {}",
                    test_report.exit_code, test_report.summary
                )
            },
            format!("action_step:{}:verification", job.id),
            LaneMessageRole::Status,
        );
        self.assert_current_session(session, session_key, "verification")
            .await?;
        let payload = capture_review_payload_async(
            &session.target,
            &session.repo_path,
            &ads_reviewer::ReviewCaptureOptions {
                require_pinned_evidence: true,
                test_report: Some(test_report.clone()),
                diff_override: None,
            },
        )
        .await;
        let evidence = payload.diff_range.clone().ok_or_else(|| {
            ReviewError::Incomplete(
                "Reviewer evidence capture produced no pinned range.".to_string(),
            )
        })?;
        if evidence.base_commit.as_deref() != session.target.base_commit.as_deref()
            || evidence.head_commit.as_deref() != session.target.head_commit.as_deref()
        {
            return Err(ReviewError::Incomplete(
                "Reviewer evidence did not remain pinned to the interactive review target."
                    .to_string(),
            ));
        }
        self.assert_current_session(session, session_key, "target check")
            .await?;
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Reviewing,
                ActionJobStatusUpdate {
                    current_step: Some(Some(format!("Running read-only Reviewer for {target}"))),
                    ..ActionJobStatusUpdate::default()
                },
                now_ms(),
                true,
            )? {
                return Err(ReviewError::Superseded(
                    "The review job was superseded by a newer head commit.".to_string(),
                ));
            }
        }
        let verdict = (self.reviewer())(ReviewerRequest {
            payload,
            repo_path: session.repo_path.clone(),
            profile_id: parse_reviewer_profile_id(job),
            job_id: job.id.clone(),
            owner: session.auth_user_id.clone(),
            cancellation: cancellation.clone(),
        })
        .await?;
        self.assert_current_session(session, session_key, "review")
            .await?;
        Ok((verdict, test_report))
    }

    async fn assert_current_session(
        &self,
        session: &ResolvedReview,
        expected_key: &str,
        phase: &str,
    ) -> Result<(), ReviewError> {
        let request = ResolveReviewRequest {
            project_id: session.project_id.clone(),
            repo_path: session.repo_path.clone(),
            auth_user_id: session.auth_user_id.clone(),
            branch: Some(session.branch.clone()),
            pr_number: (session.pr_number > 0).then_some(session.pr_number),
        };
        let current = (self.resolver())(request).await.map_err(
            |_error| {
                ReviewError::Incomplete(format!(
                    "Interactive review target changed during {phase}; no authoritative verdict is available."
                ))
            },
        )?;
        if review_key(&current) != expected_key {
            return Err(ReviewError::Incomplete(format!(
                "Interactive review target changed during {phase}; no authoritative verdict is available."
            )));
        }
        Ok(())
    }

    async fn finish_incomplete(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
        message: &str,
    ) -> Result<(), ReviewError> {
        let verdict = ReviewVerdict {
            status: ReviewVerdictStatus::Incomplete,
            summary: message.to_string(),
            defects: Vec::new(),
            reviewer_profile_id: None,
            reviewed_at: now_ms(),
        };
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Completed,
                ActionJobStatusUpdate {
                    current_step: Some(Some(format!("INCOMPLETE: {message}"))),
                    review_verdicts_json: Some(Some(
                        serde_json::to_string(&[&verdict]).expect("verdict json"),
                    )),
                    error_message: Some(None),
                    ..ActionJobStatusUpdate::default()
                },
                now,
                true,
            )? {
                self.record_superseded_message(job, repo_path).await;
                return Ok(());
            }
        }
        let completed = self.read_job(&job.id)?.unwrap_or_else(|| job.clone());
        self.publish_verdict_presentation(&completed, repo_path, &verdict);
        self.publish_outcome(&completed, repo_path, &verdict).await;
        Ok(())
    }

    async fn finish_failed(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
        message: &str,
    ) -> Result<(), ReviewError> {
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Failed,
                ActionJobStatusUpdate {
                    current_step: Some(Some(
                        "Review job failed before producing an authoritative verdict".to_string(),
                    )),
                    error_message: Some(Some(message.to_string())),
                    review_verdicts_json: Some(None),
                    ..ActionJobStatusUpdate::default()
                },
                now,
                true,
            )? {
                self.record_superseded_message(job, repo_path).await;
                return Ok(());
            }
        }
        self.record_action_message(
            job,
            repo_path,
            format!("Review failed for {}: {message}", review_target_label(job)),
            format!("action_step:{}:failed", job.id),
            LaneMessageRole::Status,
        );
        self.publish_outcome_error(job, repo_path, message).await;
        Ok(())
    }

    fn publish_verdict_presentation(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
        verdict: &ReviewVerdict,
    ) {
        self.record_action_message(
            job,
            repo_path,
            format!(
                "Review complete for {}.\n\n{}",
                review_target_label(job),
                format_review_verdict_presentation(verdict, None)
            ),
            format!("action_step:{}:completed", job.id),
            LaneMessageRole::Status,
        );
        self.record_action_message(
            job,
            repo_path,
            format_review_verdict_presentation(verdict, None),
            format!("action_step:{}:result", job.id),
            LaneMessageRole::Assistant,
        );
    }

    async fn publish_outcome(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
        verdict: &ReviewVerdict,
    ) {
        self.publish_outcome_with(
            job,
            repo_path,
            issue_verdict_status(verdict.status),
            &verdict.summary,
            &verdict.defects,
        )
        .await;
    }

    async fn publish_outcome_error(&self, job: &ActionJobRecord, repo_path: &Path, message: &str) {
        self.publish_outcome_with(job, repo_path, IssueVerdictStatus::Error, message, &[])
            .await;
    }

    async fn publish_outcome_with(
        &self,
        job: &ActionJobRecord,
        repo_path: &Path,
        status: IssueVerdictStatus,
        summary: &str,
        defects: &[ads_reviewer::ReviewDefect],
    ) {
        if self.is_superseded(&job.id).unwrap_or(true) {
            self.record_action_message(
                job,
                repo_path,
                format!(
                    "The {} verdict for {} was not published because the job was superseded.",
                    status.as_str(),
                    review_target_label(job)
                ),
                format!("action_step:{}:superseded", job.id),
                LaneMessageRole::Status,
            );
            return;
        }
        let issue_id = job
            .issue_id
            .filter(|issue_id| *issue_id > 0)
            .or_else(|| issue_id_from_branch(job.branch.as_deref()))
            .unwrap_or(0);
        if issue_id < 1 {
            self.record_action_message(
                job,
                repo_path,
                format!(
                    "The {} verdict for {} could not be published because no Issue is pinned.",
                    status.as_str(),
                    review_target_label(job)
                ),
                format!("action_step:{}:comment_skipped", job.id),
                LaneMessageRole::Status,
            );
            return;
        }
        let body = build_issue_verdict_comment(&IssueVerdictCommentInput {
            job_id: job.id.clone(),
            pr_number: job
                .pr_number
                .and_then(|pr_number| (pr_number > 0).then_some(pr_number as u64)),
            head_sha: job.head_sha.clone(),
            base_sha: job.base_sha.clone(),
            status,
            summary: summary.to_string(),
            defects: Some(defects.to_vec()),
            published_at: Some(now_ms()),
        });
        let request = IssueCommentRequest {
            repo_path: repo_path.to_path_buf(),
            issue_id,
            body,
        };
        let failure = if let Some(publisher) = self.options.publisher.clone() {
            publisher(request).await.err()
        } else {
            default_publisher()(request).await.err()
        };
        if let Some(failure) = failure {
            self.record_action_message(
                job,
                repo_path,
                format!(
                    "Publishing the {} verdict for {} to Issue #{} failed: {failure}",
                    status.as_str(),
                    review_target_label(job),
                    issue_id
                ),
                format!("action_step:{}:comment_failed", job.id),
                LaneMessageRole::Status,
            );
        }
        if let Some(waker) = self.options.waker.clone() {
            waker(AcopilotWake {
                project_id: job.project_id.clone(),
                repo_path: repo_path.to_path_buf(),
                auth_user_id: job.auth_user_id.clone().unwrap_or_default(),
                issue_id,
                issue_title: job.issue_title.clone(),
                issue_url: issue_url_from_pr_url(job.pr_url.as_deref(), issue_id),
                pr_number: job.pr_number,
                base_sha: job.base_sha.clone(),
                status,
                job_id: job.id.clone(),
                head_sha: job.head_sha.clone(),
            });
        }
    }

    async fn record_superseded_message(&self, job: &ActionJobRecord, repo_path: &Path) {
        let current = self
            .read_job(&job.id)
            .ok()
            .flatten()
            .unwrap_or_else(|| job.clone());
        self.record_action_message(
            &current,
            repo_path,
            format!(
                "Review for {} was superseded by a newer head commit and was not published.",
                review_target_label(&current)
            ),
            format!("action_step:{}:superseded", current.id),
            LaneMessageRole::Status,
        );
    }

    fn record_action_message(
        &self,
        job: &ActionJobRecord,
        _repo_path: &Path,
        text: String,
        kind: String,
        role: LaneMessageRole,
    ) {
        let Some(messenger) = self.options.messenger.clone() else {
            return;
        };
        messenger(LaneMessage {
            job_id: job.id.clone(),
            project_id: job.project_id.clone(),
            lane_generation: job.lane_generation,
            auth_user_id: job.auth_user_id.clone().unwrap_or_default(),
            chat_session_id: job.chat_session_id.clone().unwrap_or_default(),
            text,
            kind,
            role,
        });
    }

    fn is_superseded(&self, job_id: &str) -> Result<bool, ReviewError> {
        Ok(self
            .read_job(job_id)?
            .map(|job| job.superseded_at.is_some())
            .unwrap_or(false))
    }

    fn read_job(&self, job_id: &str) -> Result<Option<ActionJobRecord>, ReviewError> {
        let connection = self.db.connect()?;
        Ok(get_action_job(&connection, job_id)?)
    }

    fn supersede_older_review_jobs(
        &self,
        connection: &rusqlite::Connection,
        job: &ActionJobRecord,
        session: &ResolvedReview,
    ) -> Result<(), ReviewError> {
        supersede_review_jobs_for_new_head(
            connection,
            &SupersedeReviewJobsInput {
                project_id: job.project_id.clone(),
                pr_number: (session.pr_number > 0).then_some(session.pr_number),
                branch: Some(session.branch.clone()),
                keep_head_sha: session.target.head_commit.clone().unwrap_or_default(),
                superseded_by_job_id: job.id.clone(),
            },
            now_ms(),
        )?;
        Ok(())
    }

    fn resolver(&self) -> TargetResolver {
        self.options
            .target_resolver
            .clone()
            .unwrap_or_else(crate::resolver::default_target_resolver)
    }

    fn verification(&self) -> VerificationRunner {
        self.options.verification.clone().unwrap_or_else(|| {
            let command = self
                .options
                .test_command
                .clone()
                .unwrap_or_else(|| DEFAULT_TEST_COMMAND.to_string());
            let timeout = self
                .options
                .verification_timeout
                .unwrap_or(DEFAULT_VERIFICATION_TIMEOUT);
            default_verification_runner(command, timeout)
        })
    }

    fn reviewer(&self) -> ReviewerRunner {
        self.options.reviewer.clone().unwrap_or_else(|| {
            let timeout = self
                .options
                .reviewer_timeout
                .unwrap_or(DEFAULT_REVIEWER_TIMEOUT);
            default_reviewer_runner(self.db.clone(), timeout)
        })
    }
}

pub fn unconfigured_resolver() -> TargetResolver {
    std::sync::Arc::new(|_request: ResolveReviewRequest| {
        Box::pin(async {
            Err(ReviewError::Other(
                "Interactive review target resolution is not configured.".to_string(),
            ))
        }) as BoxFuture<Result<ResolvedReview, ReviewError>>
    })
}

fn spawn_heartbeat(
    db: StateDb,
    project_id: String,
    owner_id: String,
    ttl_ms: i64,
    interval: Duration,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = ticker.tick() => {
                    if let Ok(connection) = db.connect() {
                        let _ = renew_review_queue_lease(&connection, &project_id, &owner_id, ttl_ms, now_ms());
                    }
                }
            }
        }
    })
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn job_needs_pinning(job: &ActionJobRecord) -> bool {
    job.base_sha.as_deref().unwrap_or("").is_empty()
        || job.head_sha.as_deref().unwrap_or("").is_empty()
        || job.pr_number.unwrap_or(0) == 0
        || job.issue_id.unwrap_or(0) == 0
}

fn pinned_target(session: &ResolvedReview) -> ActionJobPinnedTarget {
    let issue = &session.target.issue;
    ActionJobPinnedTarget {
        issue_id: issue.id.unwrap_or(0),
        issue_title: issue.title.clone(),
        issue_snapshot: ActionJobIssueSnapshot {
            title: issue.title.clone(),
            description: issue
                .description
                .clone()
                .unwrap_or_else(|| issue.title.clone()),
            acceptance_criteria: issue.acceptance_criteria.clone().unwrap_or_default(),
            adrs: session
                .target
                .adrs
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|adr| ActionJobAdr {
                    id: adr.id,
                    title: adr.title,
                    decision: adr.decision,
                })
                .collect(),
        },
        branch: session.branch.clone(),
        base_sha: session.target.base_commit.clone().unwrap_or_default(),
        head_sha: session.target.head_commit.clone().unwrap_or_default(),
        pr_number: session.pr_number,
        pr_url: session.pr_url.clone(),
    }
}

fn review_target_matches_job(job: &ActionJobRecord, session: &ResolvedReview) -> bool {
    if job.job_kind != ActionJobKind::PullRequestReview {
        return false;
    }
    if job.issue_id != session.target.issue.id
        || job.branch.as_deref() != Some(session.branch.as_str())
        || job.pr_number != Some(session.pr_number)
        || job.pr_url.as_deref() != Some(session.pr_url.as_str())
        || job.base_sha.as_deref() != session.target.base_commit.as_deref()
        || job.head_sha.as_deref() != session.target.head_commit.as_deref()
    {
        return false;
    }
    let Ok(snapshot) = serde_json::from_str::<ActionJobIssueSnapshot>(&job.issue_snapshot_json)
    else {
        return false;
    };
    snapshot.title == session.target.issue.title
        && snapshot.description.as_str()
            == session
                .target
                .issue
                .description
                .as_deref()
                .unwrap_or_default()
        && snapshot.acceptance_criteria.as_slice()
            == session
                .target
                .issue
                .acceptance_criteria
                .as_deref()
                .unwrap_or_default()
        && snapshot
            .adrs
            .iter()
            .map(|adr| (&adr.id, &adr.title, &adr.decision))
            .collect::<Vec<_>>()
            == session
                .target
                .adrs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|adr| (&adr.id, &adr.title, &adr.decision))
                .collect::<Vec<_>>()
}

fn issue_url_from_pr_url(pr_url: Option<&str>, issue_id: i64) -> Option<String> {
    if issue_id < 1 {
        return None;
    }
    let pr_url = pr_url?.trim();
    let (repository_url, _) = pr_url.split_once("/pull/")?;
    let repository_url = repository_url.trim_end_matches('/');
    repository_url
        .starts_with("https://github.com/")
        .then(|| format!("{repository_url}/issues/{issue_id}"))
}

fn review_target_label(job: &ActionJobRecord) -> String {
    let pr_number = job.pr_number.unwrap_or(0);
    let issue_id = job.issue_id.unwrap_or(0);
    let anchor = if pr_number > 0 {
        format!("PR #{pr_number}")
    } else if issue_id > 0 {
        format!("Issue #{issue_id}")
    } else {
        "review".to_string()
    };
    let title = job.issue_title.trim();
    if title.is_empty() {
        anchor
    } else {
        format!("{anchor} · {title}")
    }
}

pub fn parse_reviewer_profile_id(job: &ActionJobRecord) -> Option<String> {
    let ids = serde_json::from_str::<serde_json::Value>(&job.reviewer_profile_ids_json).ok()?;
    ids.as_array()?.first()?.as_str().map(str::to_string)
}

pub fn review_key(session: &ResolvedReview) -> String {
    let mut hasher = Sha256::new();
    hasher.update(
        serde_json::to_string(&json!({
            "repoPath": session.repo_path,
            "authUserId": session.auth_user_id,
            "branch": session.branch,
            "prNumber": session.pr_number,
            "prUrl": session.pr_url,
            "issue": session.target.issue,
            "adrs": session.target.adrs,
            "baseRef": session.target.base_ref,
            "headRef": session.target.head_ref,
            "baseCommit": session.target.base_commit,
            "headCommit": session.target.head_commit,
        }))
        .expect("review key json"),
    );
    hex::encode(hasher.finalize())
}

fn issue_verdict_status(status: ReviewVerdictStatus) -> IssueVerdictStatus {
    match status {
        ReviewVerdictStatus::Pass => IssueVerdictStatus::Pass,
        ReviewVerdictStatus::Reject => IssueVerdictStatus::Reject,
        ReviewVerdictStatus::Incomplete => IssueVerdictStatus::Incomplete,
    }
}
