use std::path::{Path, PathBuf};

use ads_state::{
    ActionJobIssueSnapshot, ActionJobKind, ActionJobRecord, ActionJobStatus, ActionJobStatusUpdate,
    CreateActionJob, StateDb, WEB_ACTIONS_NAMESPACE, create_action_job, get_lane_generation,
    list_action_jobs, logical_history_key, update_action_job_status,
};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::types::{ReviewError, ReviewQueueAck, ReworkDeclaration};

pub const REVIEW_QUEUE_NOTE: &str = "Review runs in the Actions lane. The verdict is published as a structured comment on the backing Issue and the Acopilot lane is woken when it is ready.";

#[derive(Debug, Clone)]
pub struct ReviewDispatchRequest {
    pub project_id: String,
    pub repo_path: PathBuf,
    pub auth_user_id: String,
    pub branch: Option<String>,
    pub pr_number: Option<i64>,
    pub lane_generation: i64,
    pub chat_session_id: Option<String>,
    pub automatic: bool,
    pub rework_declaration: Option<serde_json::Value>,
    pub current_head_sha: Option<String>,
}

const AUTOMATIC_REVIEW_FAILURE_WINDOW_MS: i64 = 15 * 60 * 1000;
const AUTOMATIC_REVIEW_FAILURE_LIMIT: usize = 2;

pub fn issue_id_from_branch(branch: Option<&str>) -> Option<i64> {
    let branch = branch.unwrap_or("").trim();
    let digits = branch.strip_prefix("codex/issue-")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let issue_id = digits.parse::<i64>().ok()?;
    (issue_id > 0).then_some(issue_id)
}

pub fn canonical_project_id(project_id: &str, repo_path: Option<&std::path::Path>) -> String {
    let workspace_root = repo_path
        .map(|path| path.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    if workspace_root.is_empty() {
        project_id.trim().to_string()
    } else {
        ads_state::derive_project_session_id(&workspace_root)
    }
}

pub fn dispatch_review_job(
    db: &StateDb,
    request: ReviewDispatchRequest,
    now: i64,
) -> Result<ReviewQueueAck, ReviewError> {
    let mut connection = db.connect()?;
    let project_id = canonical_project_id(&request.project_id, Some(&request.repo_path));
    let auth_user_id = request.auth_user_id.trim().to_string();
    if project_id.is_empty() || auth_user_id.is_empty() {
        return Err(ReviewError::Other(
            "Interactive review requires an authenticated project workspace.".to_string(),
        ));
    }
    let branch = request.branch.as_deref().unwrap_or("").trim().to_string();
    let pr_number = request.pr_number.filter(|value| *value > 0).unwrap_or(0);
    let (chat_session_id, lane_generation) = resolve_actions_lane(
        &mut connection,
        &project_id,
        &request.repo_path,
        &auth_user_id,
        now,
    )?
    .unwrap_or_else(|| {
        (
            request.chat_session_id.unwrap_or_default(),
            request.lane_generation.max(1),
        )
    });

    let jobs = list_action_jobs(&connection, &project_id, None, Some(&auth_user_id))?;
    let existing = jobs
        .iter()
        .find(|job| {
            job.job_kind == ActionJobKind::PullRequestReview
                && job.branch.as_deref().unwrap_or("") == branch
                && (pr_number == 0 || job.pr_number == Some(pr_number))
                && job.superseded_at.is_none()
                && matches!(
                    job.status,
                    ActionJobStatus::Queued
                        | ActionJobStatus::Verifying
                        | ActionJobStatus::Reviewing
                )
        })
        .cloned();
    if let Some(job) = existing {
        return Ok(review_queue_ack(job));
    }

    let latest_review = jobs.iter().find(|job| {
        job.job_kind == ActionJobKind::PullRequestReview
            && job.branch.as_deref().unwrap_or("") == branch
            && (pr_number == 0 || job.pr_number == Some(pr_number))
            && job.superseded_at.is_none()
    });
    let prior_reject = latest_review.filter(|job| {
        job.status == ActionJobStatus::Completed
            && job
                .current_step
                .as_deref()
                .is_some_and(|step| step.starts_with("REJECT:"))
            && serde_json::from_str::<Vec<ads_reviewer::ReviewVerdict>>(&job.review_verdicts_json)
                .is_ok_and(|verdicts| {
                    verdicts
                        .iter()
                        .any(|verdict| verdict.status == ads_reviewer::ReviewVerdictStatus::Reject)
                })
    });
    let rework_declaration = match (prior_reject, request.rework_declaration.as_ref()) {
        (None, None) => None,
        (Some(_), None) => {
            return Err(ReviewError::Conflict(
                "A complete rework declaration is required before redispatch after REJECT."
                    .to_string(),
            ));
        }
        (None, Some(_)) => {
            return Err(ReviewError::Conflict(
                "A rework declaration is only valid after a REJECT verdict.".to_string(),
            ));
        }
        (Some(prior), Some(value)) => {
            let declaration: ReworkDeclaration = serde_json::from_value(value.clone())?;
            validate_rework_declaration(
                &declaration,
                prior,
                &project_id,
                pr_number,
                &branch,
                request.current_head_sha.as_deref(),
            )?;
            Some(serde_json::to_string(&declaration)?)
        }
    };

    if request.automatic && !branch.is_empty() {
        let cutoff = now - AUTOMATIC_REVIEW_FAILURE_WINDOW_MS;
        let consecutive_failures = jobs
            .iter()
            .filter(|job| {
                job.job_kind == ActionJobKind::PullRequestReview
                    && job.branch.as_deref().unwrap_or("") == branch
                    && job.superseded_at.is_none()
                    && job.created_at >= cutoff
            })
            .take_while(|job| job.status == ActionJobStatus::Failed)
            .count();
        if consecutive_failures >= AUTOMATIC_REVIEW_FAILURE_LIMIT {
            return Err(ReviewError::Conflict(format!(
                "Automatic review retry paused after {consecutive_failures} consecutive operational failures for branch '{branch}' within 15 minutes. Fix the upstream failure and retry the review explicitly."
            )));
        }
    }

    let transaction = connection.unchecked_transaction()?;
    let job = create_action_job(
        &transaction,
        CreateActionJob {
            id: Uuid::new_v4().to_string(),
            project_id,
            lane_generation: Some(lane_generation),
            acopilot_lane_generation: request.lane_generation.max(1),
            job_kind: ActionJobKind::PullRequestReview,
            issue_id: issue_id_from_branch(Some(&branch)).unwrap_or(0),
            issue_title: String::new(),
            issue_snapshot: ActionJobIssueSnapshot::default(),
            status: None,
            branch: branch.clone(),
            base_sha: String::new(),
            head_sha: String::new(),
            reviewer_profile_ids_json: "[]".to_string(),
            pr_number,
            pr_url: String::new(),
            auth_user_id: auth_user_id.clone(),
            chat_session_id,
            rework_declaration_json: rework_declaration,
        },
        now,
    )?;
    let step = if pr_number > 0 {
        format!(
            "Queued read-only review for PR #{pr_number}; target checks run when the job starts."
        )
    } else {
        format!(
            "Queued read-only review for branch {}; target checks run when the job starts.",
            if branch.is_empty() {
                "(unknown)"
            } else {
                &branch
            }
        )
    };
    update_action_job_status(
        &transaction,
        &job.id,
        ActionJobStatus::Queued,
        ActionJobStatusUpdate {
            current_step: Some(Some(step)),
            ..ActionJobStatusUpdate::default()
        },
        now,
        false,
    )?;
    let job = ads_state::get_action_job(&transaction, &job.id)?.ok_or_else(|| {
        ReviewError::Other("Failed to read back dispatched review job.".to_string())
    })?;
    transaction.commit()?;
    Ok(review_queue_ack(job))
}

fn validate_rework_declaration(
    declaration: &ReworkDeclaration,
    prior: &ActionJobRecord,
    project_id: &str,
    pr_number: i64,
    branch: &str,
    current_head_sha: Option<&str>,
) -> Result<(), ReviewError> {
    let nonempty = |value: &str| !value.trim().is_empty();
    let valid = declaration.prior_job_id == prior.id
        && declaration.issue_id == prior.issue_id.unwrap_or_default()
        && declaration.pr_number == prior.pr_number.unwrap_or_default()
        && declaration.pr_number == pr_number
        && declaration.base_sha == prior.base_sha.as_deref().unwrap_or_default()
        && declaration.rejected_head_sha == prior.head_sha.as_deref().unwrap_or_default()
        && current_head_sha == Some(declaration.new_head_sha.as_str())
        && declaration.new_head_sha != declaration.rejected_head_sha
        && prior.project_id == project_id
        && prior.branch.as_deref().unwrap_or("") == branch
        && nonempty(&declaration.root_cause)
        && nonempty(&declaration.invariant)
        && !declaration.audited_scope.is_empty()
        && declaration.audited_scope.iter().all(|item| nonempty(item))
        && nonempty(&declaration.changed_behavior)
        && !declaration.regression_cases.is_empty()
        && declaration
            .regression_cases
            .iter()
            .all(|item| nonempty(item))
        && !declaration.verification_evidence.is_empty()
        && declaration
            .verification_evidence
            .iter()
            .all(|item| nonempty(item))
        && declaration.residual_risks.iter().all(|item| nonempty(item));
    if !valid {
        return Err(ReviewError::Conflict(
            "The rework declaration is incomplete, stale, or belongs to a different Issue, PR, branch, base, or rejected head. Provide a complete declaration for the latest REJECT job.".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn resolve_actions_lane(
    connection: &mut Connection,
    project_id: &str,
    repo_path: &Path,
    auth_user_id: &str,
    now: i64,
) -> Result<Option<(String, i64)>, ReviewError> {
    let workspace_root = repo_path.to_string_lossy();
    let chat_session_id = connection
        .query_row(
            "SELECT chat_session_id FROM web_projects
             WHERE user_id = ?1 AND (project_id = ?2 OR workspace_root = ?3)
             ORDER BY updated_at DESC LIMIT 1",
            params![auth_user_id, project_id, workspace_root.as_ref()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(chat_session_id) = chat_session_id else {
        return Ok(None);
    };
    let logical_key = logical_history_key(auth_user_id, project_id, &chat_session_id);
    let generation =
        get_lane_generation(connection, WEB_ACTIONS_NAMESPACE, &logical_key, now.max(1))?;
    Ok(Some((chat_session_id, generation)))
}

fn review_queue_ack(job: ActionJobRecord) -> ReviewQueueAck {
    ReviewQueueAck {
        ok: true,
        job_id: job.id.clone(),
        status: job.status,
        issue_id: job.issue_id.filter(|issue_id| *issue_id > 0),
        note: REVIEW_QUEUE_NOTE.to_string(),
    }
}
