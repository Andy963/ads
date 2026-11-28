use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_reviewer::{
    IssueVerdictCommentInput, IssueVerdictStatus, ReviewVerdict, ReviewVerdictStatus,
    ReviewVerificationReport, build_issue_verdict_comment, capture_review_payload_async,
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
use tokio::process::Command;

use crate::defaults::{
    default_publisher, default_reviewer_runner, resolve_reviewer_idle_timeout,
    resolve_reviewer_max_duration,
};
use crate::dispatch::{canonical_project_id, is_operational_review_outcome, issue_id_from_branch};
use crate::types::{
    AcopilotWake, BoxFuture, IssueCommentRequest, LaneMessage, LaneMessageRole,
    ResolveReviewRequest, ResolvedReview, ReviewError, ReviewQueueAck, ReviewQueueOptions,
    ReviewerRequest, ReviewerRunner, ReworkDeclaration, TargetResolver,
};

const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(90);
const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(30);

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

    pub fn resolve_acopilot_lane_generation(
        &self,
        project_id: &str,
        repo_path: &Path,
        auth_user_id: &str,
        now: i64,
    ) -> Result<i64, ReviewError> {
        crate::dispatch::resolve_acopilot_lane_generation(
            &self.db,
            project_id,
            repo_path,
            auth_user_id,
            now,
        )
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
            self.validate_rework_target(&current, &session)?;
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
        let (verdict, verification_report) = self
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
                        serde_json::to_string(&verification_report).expect("report json"),
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

    fn validate_rework_target(
        &self,
        job: &ActionJobRecord,
        session: &ResolvedReview,
    ) -> Result<(), ReviewError> {
        let Some(serialized) = job.rework_declaration_json.as_deref() else {
            return Ok(());
        };
        let declaration: crate::types::ReworkDeclaration = serde_json::from_str(serialized)?;
        let complete = !declaration.root_cause.trim().is_empty()
            && !declaration.invariant.trim().is_empty()
            && !declaration.audited_scope.is_empty()
            && declaration
                .audited_scope
                .iter()
                .all(|item| !item.trim().is_empty())
            && !declaration.changed_behavior.trim().is_empty()
            && !declaration.regression_cases.is_empty()
            && declaration
                .regression_cases
                .iter()
                .all(|item| !item.trim().is_empty())
            && !declaration.verification_evidence.is_empty()
            && declaration
                .verification_evidence
                .iter()
                .all(|item| !item.trim().is_empty())
            && declaration
                .residual_risks
                .iter()
                .all(|item| !item.trim().is_empty());
        let prior_matches = {
            let connection = self.db.connect()?;
            let latest_review = list_action_jobs(
                &connection,
                &job.project_id,
                None,
                job.auth_user_id.as_deref(),
            )?
            .into_iter()
            .find(|candidate| {
                candidate.id != job.id
                    && candidate.job_kind == ActionJobKind::PullRequestReview
                    && candidate.branch.as_deref() == Some(session.branch.as_str())
                    && candidate.pr_number == Some(session.pr_number)
                    && candidate.superseded_at.is_none()
            });
            let declaration_is_latest = latest_review.as_ref().is_some_and(|candidate| {
                candidate.id == declaration.prior_job_id
                    || (is_operational_review_outcome(candidate)
                        && candidate
                            .rework_declaration_json
                            .as_deref()
                            .and_then(|value| serde_json::from_str::<ReworkDeclaration>(value).ok())
                            .is_some_and(|candidate_declaration| {
                                candidate.rework_root_job_id.as_deref()
                                    == Some(declaration.prior_job_id.as_str())
                                    && candidate_declaration.targets_same_rejection(&declaration)
                            }))
            });
            let inherited_from_operational_retry =
                latest_review.as_ref().is_some_and(|candidate| {
                    is_operational_review_outcome(candidate)
                        && candidate
                            .rework_declaration_json
                            .as_deref()
                            .and_then(|value| serde_json::from_str::<ReworkDeclaration>(value).ok())
                            .is_some_and(|candidate_declaration| {
                                candidate.rework_root_job_id.as_deref()
                                    == Some(declaration.prior_job_id.as_str())
                                    && candidate_declaration.targets_same_rejection(&declaration)
                            })
                });
            match get_action_job(&connection, &declaration.prior_job_id)? {
                Some(prior) if prior.job_kind == ActionJobKind::PullRequestReview => {
                    declaration_is_latest
                        && prior.status == ActionJobStatus::Completed
                        && (prior.superseded_at.is_none() || inherited_from_operational_retry)
                        && prior
                            .current_step
                            .as_deref()
                            .is_some_and(|step| step.starts_with("REJECT:"))
                        && prior.project_id == job.project_id
                        && prior.issue_id == Some(declaration.issue_id)
                        && prior.pr_number == Some(declaration.pr_number)
                        && prior.branch.as_deref() == Some(session.branch.as_str())
                        && prior.base_sha.as_deref() == Some(declaration.base_sha.as_str())
                        && prior.head_sha.as_deref() == Some(declaration.rejected_head_sha.as_str())
                        && serde_json::from_str::<Vec<ReviewVerdict>>(&prior.review_verdicts_json)
                            .is_ok_and(|verdicts| {
                                verdicts
                                    .iter()
                                    .any(|verdict| verdict.status == ReviewVerdictStatus::Reject)
                            })
                }
                _ => false,
            }
        };
        let matches = complete
            && job.rework_root_job_id.as_deref() == Some(declaration.prior_job_id.as_str())
            && prior_matches
            && declaration.issue_id == session.target.issue.id.unwrap_or_default()
            && declaration.pr_number == session.pr_number
            && declaration.base_sha == session.target.base_commit.as_deref().unwrap_or_default()
            && declaration.new_head_sha
                == session.target.head_commit.as_deref().unwrap_or_default()
            && declaration.rejected_head_sha != declaration.new_head_sha
            && job.project_id == session.project_id
            && job.branch.as_deref().unwrap_or("") == session.branch;
        if !matches {
            return Err(ReviewError::Incomplete(
                "The rework declaration does not match the resolved Issue, PR, base, branch, or new head. No follow-up review was run.".to_string(),
            ));
        }
        Ok(())
    }

    async fn run_interactive_review(
        &self,
        job: &ActionJobRecord,
        session: &ResolvedReview,
        session_key: &str,
        repo_path: &Path,
        cancellation: ads_native::Cancellation,
    ) -> Result<(ReviewVerdict, ReviewVerificationReport), ReviewError> {
        let target = review_target_label(job);
        self.assert_current_session(session, session_key, "target check")
            .await?;
        let mut payload = capture_review_payload_async(
            &session.target,
            &session.repo_path,
            &ads_reviewer::ReviewCaptureOptions {
                require_pinned_evidence: true,
                verification_report: None,
                diff_override: None,
            },
        )
        .await;
        payload.rework_declaration = job
            .rework_declaration_json
            .as_deref()
            .and_then(|declaration| serde_json::from_str(declaration).ok());
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
        let verification_report =
            std::sync::Arc::new(std::sync::Mutex::new(ReviewVerificationReport::default()));
        let reviewer_result = (self.reviewer())(ReviewerRequest {
            payload,
            repo_path: session.repo_path.clone(),
            profile_id: parse_reviewer_profile_id(job),
            job_id: job.id.clone(),
            owner: session.auth_user_id.clone(),
            cancellation: cancellation.clone(),
            verification_report: verification_report.clone(),
        })
        .await;
        let verification_report = verification_report
            .lock()
            .expect("verification report lock")
            .clone();
        let now = now_ms();
        {
            let connection = self.db.connect()?;
            if !update_action_job_status(
                &connection,
                &job.id,
                ActionJobStatus::Reviewing,
                ActionJobStatusUpdate {
                    current_step: Some(Some(format!(
                        "Reviewer ran {} verification command(s)",
                        verification_report.commands.len()
                    ))),
                    verification_report_json: Some(Some(serde_json::to_string(
                        &verification_report,
                    )?)),
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
        let verification_summary = verification_report
            .commands
            .iter()
            .map(|report| {
                format!(
                    "{} (exit {}, started={})",
                    report.command, report.exit_code, report.started
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        self.record_action_message(
            job,
            repo_path,
            if verification_summary.is_empty() {
                format!("Reviewer selected no verification command for {target}.")
            } else {
                format!("Reviewer verification for {target}: {verification_summary}")
            },
            format!("action_step:{}:verification", job.id),
            LaneMessageRole::Status,
        );
        if reviewer_result
            .as_ref()
            .is_ok_and(|verdict| verdict.status == ReviewVerdictStatus::Pass)
        {
            if verification_report.commands.is_empty() {
                return Err(ReviewError::Incomplete(
                    "Reviewer did not run a verification command; no PASS verdict is authoritative."
                        .to_string(),
                ));
            }
            if !verification_report
                .commands
                .iter()
                .any(|command| command.started)
            {
                return Err(ReviewError::Incomplete(
                    "Reviewer did not start an available verification command; no PASS verdict is authoritative."
                        .to_string(),
                ));
            }
            if !verification_report.has_successful_command() {
                return Err(ReviewError::Incomplete(
                    "Reviewer PASS requires at least one selected verification command to complete successfully."
                        .to_string(),
                ));
            }
        }
        let verdict = reviewer_result?;
        self.assert_current_session(session, session_key, "review")
            .await?;
        Ok((verdict, verification_report))
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
                "Review complete for {} ({}).",
                review_target_label(job),
                verdict.status.as_str()
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
            return;
        }
        let mut ready = Err(ads_state::StateError::InvalidInput(
            "handoff readiness was not attempted".to_string(),
        ));
        for attempt in 0..20 {
            ready = self.db.connect().and_then(|connection| {
                let changed = connection.execute(
                    "UPDATE action_jobs
                     SET agent_handoff_ready = 1, updated_at = ?1
                     WHERE id = ?2 AND requires_agent_handoff = 1
                       AND status IN ('completed', 'failed')
                       AND superseded_at IS NULL",
                    rusqlite::params![now_ms(), job.id],
                )?;
                if changed == 1 {
                    Ok(())
                } else {
                    Err(ads_state::StateError::InvalidInput(
                        "review job was superseded before handoff readiness".to_string(),
                    ))
                }
            });
            if ready.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
        }
        if let Err(error) = ready {
            self.record_action_message(
                job,
                repo_path,
                format!(
                    "Marking the {} handoff ready for {} failed: {error}",
                    status.as_str(),
                    review_target_label(job)
                ),
                format!("action_step:{}:handoff_ready_failed", job.id),
                LaneMessageRole::Status,
            );
            return;
        }
        if let Some(waker) = self.options.waker.clone() {
            let issue_url = resolve_issue_url(job.pr_url.as_deref(), repo_path, issue_id).await;
            waker(AcopilotWake {
                project_id: job.project_id.clone(),
                repo_path: repo_path.to_path_buf(),
                auth_user_id: job.auth_user_id.clone().unwrap_or_default(),
                issue_id,
                issue_title: job.issue_title.clone(),
                issue_url,
                pr_number: job.pr_number,
                branch: job.branch.clone(),
                base_sha: job.base_sha.clone(),
                status,
                job_id: job.id.clone(),
                source_created_at: job.created_at,
                lane_generation: job.acopilot_lane_generation,
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

    fn reviewer(&self) -> ReviewerRunner {
        self.options.reviewer.clone().unwrap_or_else(|| {
            let idle_timeout = resolve_reviewer_idle_timeout();
            let max_duration = self
                .options
                .reviewer_timeout
                .filter(|duration| !duration.is_zero())
                .or_else(resolve_reviewer_max_duration);
            default_reviewer_runner(self.db.clone(), idle_timeout, max_duration)
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

pub fn issue_url_from_pr_url(pr_url: Option<&str>, issue_id: i64) -> Option<String> {
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

pub async fn issue_url_from_repository(repo_path: &Path, issue_id: i64) -> Option<String> {
    if issue_id < 1 {
        return None;
    }
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(["config", "--get", "remote.origin.url"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    github_repository_url(&String::from_utf8_lossy(&output.stdout))
        .map(|repository_url| format!("{repository_url}/issues/{issue_id}"))
}

pub fn github_repository_url(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("http://github.com/"))?;
    let path = path.trim_matches('/');
    (path.split('/').filter(|part| !part.is_empty()).count() >= 2)
        .then(|| format!("https://github.com/{path}"))
}

pub async fn resolve_issue_url(
    pr_url: Option<&str>,
    repo_path: &Path,
    issue_id: i64,
) -> Option<String> {
    if let Some(url) = issue_url_from_pr_url(pr_url, issue_id) {
        return Some(url);
    }
    issue_url_from_repository(repo_path, issue_id).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_github_remotes_for_issue_links() {
        for remote in [
            "git@github.com:Andy963/ads.git",
            "ssh://git@github.com/Andy963/ads.git",
            "https://github.com/Andy963/ads.git",
            "https://github.com/Andy963/ads/",
        ] {
            assert_eq!(
                github_repository_url(remote).as_deref(),
                Some("https://github.com/Andy963/ads")
            );
        }
        assert_eq!(github_repository_url("https://example.com/ads.git"), None);
    }

    #[tokio::test]
    async fn derives_issue_links_from_repository_identity() {
        let directory = tempfile::tempdir().expect("temp dir");
        let output = Command::new("git")
            .args(["init", "-q"])
            .current_dir(directory.path())
            .output()
            .await
            .expect("git init");
        assert!(output.status.success());
        let output = Command::new("git")
            .args(["remote", "add", "origin", "git@github.com:Andy963/ads.git"])
            .current_dir(directory.path())
            .output()
            .await
            .expect("git remote");
        assert!(output.status.success());

        assert_eq!(
            issue_url_from_repository(directory.path(), 648)
                .await
                .as_deref(),
            Some("https://github.com/Andy963/ads/issues/648")
        );
    }
}
