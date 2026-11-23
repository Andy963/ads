use std::error::Error;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{StateError, StateResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionJobKind {
    GithubIssue,
    LocalPrompt,
    PullRequestReview,
}

impl ActionJobKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "github_issue" => Some(Self::GithubIssue),
            "local_prompt" => Some(Self::LocalPrompt),
            "pull_request_review" => Some(Self::PullRequestReview),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::GithubIssue => "github_issue",
            Self::LocalPrompt => "local_prompt",
            Self::PullRequestReview => "pull_request_review",
        }
    }
}

impl FromStr for ActionJobKind {
    type Err = StateError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
            .ok_or_else(|| StateError::InvalidInput(format!("Unknown action job kind: {value}")))
    }
}

impl ToSql for ActionJobKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for ActionJobKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let value = value.as_str()?;
        Self::parse(value).ok_or_else(|| {
            FromSqlError::Other(Box::new(StateError::InvalidInput(format!(
                "Unknown action job kind: {value}"
            ))) as Box<dyn Error + Send + Sync>)
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionJobStatus {
    Queued,
    Running,
    Verifying,
    Reviewing,
    WaitingMerge,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

impl ActionJobStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "verifying" => Some(Self::Verifying),
            "reviewing" => Some(Self::Reviewing),
            "waiting_merge" => Some(Self::WaitingMerge),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "blocked" => Some(Self::Blocked),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Verifying => "verifying",
            Self::Reviewing => "reviewing",
            Self::WaitingMerge => "waiting_merge",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
        }
    }
}

impl FromStr for ActionJobStatus {
    type Err = StateError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
            .ok_or_else(|| StateError::InvalidInput(format!("Unknown action job status: {value}")))
    }
}

impl ToSql for ActionJobStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for ActionJobStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let value = value.as_str()?;
        Self::parse(value).ok_or_else(|| {
            FromSqlError::Other(Box::new(StateError::InvalidInput(format!(
                "Unknown action job status: {value}"
            ))) as Box<dyn Error + Send + Sync>)
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActionJobIssueSnapshot {
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
    pub adrs: Vec<ActionJobAdr>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActionJobAdr {
    pub id: String,
    pub title: String,
    pub decision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ActionJobRecord {
    pub id: String,
    pub project_id: String,
    pub lane_generation: i64,
    pub job_kind: ActionJobKind,
    pub issue_id: Option<i64>,
    pub issue_title: String,
    pub issue_snapshot_json: String,
    pub verification_report_json: String,
    pub rework_declaration_json: Option<String>,
    pub status: ActionJobStatus,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub developer_profile_id: Option<String>,
    pub reviewer_profile_ids_json: String,
    pub current_step: Option<String>,
    pub steps_json: String,
    pub review_verdicts_json: String,
    pub attempts_json: String,
    pub pr_number: Option<i64>,
    pub pr_url: Option<String>,
    pub error_message: Option<String>,
    pub rework_count: i64,
    pub blocked_at: Option<i64>,
    pub superseded_at: Option<i64>,
    pub superseded_by_job_id: Option<String>,
    pub requires_agent_handoff: i64,
    pub acopilot_lane_generation: i64,
    pub agent_handoff_ready: i64,
    pub auth_user_id: Option<String>,
    pub chat_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct CreateActionJob {
    pub id: String,
    pub project_id: String,
    pub lane_generation: Option<i64>,
    pub acopilot_lane_generation: i64,
    pub job_kind: ActionJobKind,
    pub issue_id: i64,
    pub issue_title: String,
    pub issue_snapshot: ActionJobIssueSnapshot,
    pub status: Option<ActionJobStatus>,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub reviewer_profile_ids_json: String,
    pub pr_number: i64,
    pub pr_url: String,
    pub auth_user_id: String,
    pub chat_session_id: String,
    pub rework_declaration_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActionJobPinnedTarget {
    pub issue_id: i64,
    pub issue_title: String,
    pub issue_snapshot: ActionJobIssueSnapshot,
    pub branch: String,
    pub base_sha: String,
    pub head_sha: String,
    pub pr_number: i64,
    pub pr_url: String,
}

#[derive(Debug, Clone, Default)]
pub struct ActionJobStatusUpdate {
    pub current_step: Option<Option<String>>,
    pub review_verdicts_json: Option<Option<String>>,
    pub verification_report_json: Option<Option<String>>,
    pub error_message: Option<Option<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct SupersedeReviewJobsInput {
    pub project_id: String,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub keep_head_sha: String,
    pub superseded_by_job_id: String,
}

pub fn list_action_jobs(
    connection: &Connection,
    project_id: &str,
    status: Option<ActionJobStatus>,
    auth_user_id: Option<&str>,
) -> StateResult<Vec<ActionJobRecord>> {
    let owner = auth_user_id.map(str::trim).unwrap_or_default();
    let owner_clause = if owner.is_empty() {
        ""
    } else {
        " AND auth_user_id = ?"
    };
    let sql = match status {
        Some(_) => format!(
            "SELECT * FROM action_jobs WHERE project_id = ? AND status = ?{owner_clause} ORDER BY created_at ASC"
        ),
        None => format!(
            "SELECT * FROM action_jobs WHERE project_id = ?{owner_clause} ORDER BY created_at DESC"
        ),
    };
    let mut statement = connection.prepare(&sql)?;
    let rows = match (status, owner.is_empty()) {
        (Some(status), true) => statement
            .query_map(params![project_id, status], action_job_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
        (Some(status), false) => statement
            .query_map(params![project_id, status, owner], action_job_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
        (None, true) => statement
            .query_map(params![project_id], action_job_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
        (None, false) => statement
            .query_map(params![project_id, owner], action_job_from_row)?
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok(rows)
}

pub fn get_action_job(connection: &Connection, id: &str) -> StateResult<Option<ActionJobRecord>> {
    Ok(connection
        .query_row(
            "SELECT * FROM action_jobs WHERE id = ?1 LIMIT 1",
            params![id],
            action_job_from_row,
        )
        .optional()?)
}

pub fn create_action_job(
    connection: &Connection,
    job: CreateActionJob,
    now: i64,
) -> StateResult<ActionJobRecord> {
    let status = job.status.unwrap_or(ActionJobStatus::Queued);
    let lane_generation = job.lane_generation.unwrap_or(1).max(1);
    let issue_snapshot_json = serde_json::to_string(&job.issue_snapshot)?;
    connection.execute(
        "INSERT INTO action_jobs (
           id, project_id, lane_generation, job_kind, issue_id, issue_title, issue_snapshot_json,
           verification_report_json, rework_declaration_json, status, branch, base_sha, head_sha, reviewer_profile_ids_json,
           current_step, steps_json, review_verdicts_json, attempts_json, pr_number, pr_url,
           error_message, rework_count, blocked_at, auth_user_id, chat_session_id, created_at,
           updated_at, requires_agent_handoff, acopilot_lane_generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, NULL, '[]', '[]', '[]', ?, ?, NULL, 0, NULL, ?, ?, ?, ?,
                   CASE WHEN ? = 'pull_request_review' THEN 1 ELSE 0 END, ?)",
        params![
            job.id,
            job.project_id,
            lane_generation,
            job.job_kind,
            job.issue_id,
            job.issue_title,
            issue_snapshot_json,
            job.rework_declaration_json,
            status,
            job.branch,
            job.base_sha,
            job.head_sha,
            job.reviewer_profile_ids_json,
            job.pr_number,
            job.pr_url,
            job.auth_user_id,
            job.chat_session_id,
            now,
            now,
            job.job_kind,
            job.acopilot_lane_generation.max(1),
        ],
    )?;
    get_action_job(connection, &job.id)?.ok_or_else(|| {
        StateError::InvalidInput(format!(
            "Failed to read back created action job: {}",
            job.id
        ))
    })
}

pub fn update_action_job_pinned_target(
    connection: &Connection,
    id: &str,
    target: &ActionJobPinnedTarget,
    now: i64,
) -> StateResult<bool> {
    let snapshot_json = serde_json::to_string(&target.issue_snapshot)?;
    let changes = connection.execute(
        "UPDATE action_jobs
         SET issue_id = ?, issue_title = ?, issue_snapshot_json = ?, branch = ?,
             base_sha = ?, head_sha = ?, pr_number = ?, pr_url = ?, updated_at = ?
         WHERE id = ? AND superseded_at IS NULL",
        params![
            target.issue_id,
            target.issue_title,
            snapshot_json,
            target.branch,
            target.base_sha,
            target.head_sha,
            target.pr_number,
            target.pr_url,
            now,
            id,
        ],
    )?;
    Ok(changes > 0)
}

pub fn claim_queued_review_job(connection: &Connection, id: &str, now: i64) -> StateResult<bool> {
    let changes = connection.execute(
        "UPDATE action_jobs SET status = 'verifying', updated_at = ?
         WHERE id = ? AND job_kind = 'pull_request_review' AND status = 'queued'
           AND superseded_at IS NULL",
        params![now, id],
    )?;
    Ok(changes > 0)
}

pub fn fail_interrupted_review_jobs(
    connection: &Connection,
    project_id: &str,
    now: i64,
) -> StateResult<Vec<ActionJobRecord>> {
    let mut statement = connection.prepare(
        "SELECT * FROM action_jobs
         WHERE project_id = ? AND job_kind = 'pull_request_review'
           AND status IN ('verifying', 'reviewing') AND superseded_at IS NULL",
    )?;
    let candidates = statement
        .query_map(params![project_id], action_job_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let error_message =
        "The review job has no active worker. Dispatch a new review to retry the pinned target.";
    let mut failed = Vec::new();
    for job in candidates {
        let changes = connection.execute(
            "UPDATE action_jobs
             SET status = 'failed', current_step = 'Review job interrupted before producing a verdict',
                 error_message = ?, review_verdicts_json = '[]', updated_at = ?
             WHERE id = ? AND status IN ('verifying', 'reviewing') AND superseded_at IS NULL",
            params![error_message, now, job.id],
        )?;
        if changes == 1 {
            if let Some(updated) = get_action_job(connection, &job.id)? {
                failed.push(updated);
            }
        }
    }
    Ok(failed)
}

pub fn update_action_job_status(
    connection: &Connection,
    id: &str,
    status: ActionJobStatus,
    updates: ActionJobStatusUpdate,
    now: i64,
    require_not_superseded: bool,
) -> StateResult<bool> {
    let mut fields = vec!["status = ?".to_string(), "updated_at = ?".to_string()];
    let mut values = vec![
        rusqlite::types::Value::Text(status.as_str().to_string()),
        rusqlite::types::Value::Integer(now),
    ];
    if let Some(current_step) = updates.current_step {
        fields.push("current_step = ?".to_string());
        values.push(optional_text(current_step));
    }
    if let Some(review_verdicts_json) = updates.review_verdicts_json {
        fields.push("review_verdicts_json = ?".to_string());
        values.push(rusqlite::types::Value::Text(
            review_verdicts_json.unwrap_or_else(|| "[]".to_string()),
        ));
    }
    if let Some(verification_report_json) = updates.verification_report_json {
        fields.push("verification_report_json = ?".to_string());
        values.push(rusqlite::types::Value::Text(
            verification_report_json.unwrap_or_default(),
        ));
    }
    if let Some(error_message) = updates.error_message {
        fields.push("error_message = ?".to_string());
        values.push(optional_text(error_message));
    }
    values.push(rusqlite::types::Value::Text(id.to_string()));
    let where_clause = if require_not_superseded {
        " WHERE id = ? AND superseded_at IS NULL"
    } else {
        " WHERE id = ?"
    };
    let sql = format!("UPDATE action_jobs SET {}{where_clause}", fields.join(", "));
    let changes = connection.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(changes > 0)
}

pub fn supersede_review_jobs_for_new_head(
    connection: &Connection,
    input: &SupersedeReviewJobsInput,
    now: i64,
) -> StateResult<usize> {
    let project_id = input.project_id.trim();
    let keep_head_sha = input.keep_head_sha.trim();
    let superseded_by_job_id = input.superseded_by_job_id.trim();
    let pr_number = input.pr_number.unwrap_or(0);
    let branch = input.branch.as_deref().unwrap_or("").trim();
    if project_id.is_empty() || keep_head_sha.is_empty() || superseded_by_job_id.is_empty() {
        return Ok(0);
    }
    if pr_number < 0 {
        return Ok(0);
    }
    let (target_clause, target_value) = if pr_number > 0 {
        ("pr_number = ?", pr_number.to_string())
    } else if !branch.is_empty() {
        (
            "COALESCE(pr_number, 0) = 0 AND branch = ?",
            branch.to_string(),
        )
    } else {
        return Ok(0);
    };
    let sql = format!(
        "UPDATE action_jobs
         SET superseded_at = ?,
             superseded_by_job_id = ?,
             status = CASE
               WHEN status IN ('queued', 'running', 'verifying', 'reviewing') THEN 'cancelled'
               ELSE status
             END,
             current_step = CASE
               WHEN status IN ('queued', 'running', 'verifying', 'reviewing')
                 THEN 'Superseded by a newer head commit'
               ELSE current_step
             END,
             updated_at = ?
         WHERE project_id = ?
           AND job_kind = 'pull_request_review'
           AND id <> ?
           AND superseded_at IS NULL
           AND status <> 'cancelled'
           AND COALESCE(head_sha, '') <> ?
           AND {target_clause}"
    );
    let changes = connection.execute(
        &sql,
        params![
            now,
            superseded_by_job_id,
            now,
            project_id,
            superseded_by_job_id,
            keep_head_sha,
            target_value
        ],
    )?;
    if changes > 0 && crate::table_exists(connection, "agent_messages")? {
        connection.execute(
            "UPDATE agent_messages
             SET status = 'superseded', updated_at = ?1,
                 transition_revision = transition_revision + 1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE kind = 'review_verdict'
               AND status IN ('pending', 'failed')
               AND EXISTS (
                 SELECT 1 FROM action_jobs j
                 WHERE j.id = agent_messages.correlation_id
                   AND j.superseded_at IS NOT NULL
               )",
            params![now],
        )?;
    }
    Ok(changes)
}

fn optional_text(value: Option<String>) -> rusqlite::types::Value {
    value.map_or(rusqlite::types::Value::Null, rusqlite::types::Value::Text)
}

fn action_job_from_row(row: &Row<'_>) -> rusqlite::Result<ActionJobRecord> {
    Ok(ActionJobRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        lane_generation: row.get("lane_generation")?,
        job_kind: row.get("job_kind")?,
        issue_id: row.get("issue_id")?,
        issue_title: row.get("issue_title")?,
        issue_snapshot_json: row.get("issue_snapshot_json")?,
        verification_report_json: row.get("verification_report_json")?,
        rework_declaration_json: row.get("rework_declaration_json")?,
        status: row.get("status")?,
        branch: row.get("branch")?,
        base_sha: row.get("base_sha")?,
        head_sha: row.get("head_sha")?,
        developer_profile_id: row.get("developer_profile_id")?,
        reviewer_profile_ids_json: row.get("reviewer_profile_ids_json")?,
        current_step: row.get("current_step")?,
        steps_json: row.get("steps_json")?,
        review_verdicts_json: row.get("review_verdicts_json")?,
        attempts_json: row.get("attempts_json")?,
        pr_number: row.get("pr_number")?,
        pr_url: row.get("pr_url")?,
        error_message: row.get("error_message")?,
        rework_count: row.get("rework_count")?,
        blocked_at: row.get("blocked_at")?,
        superseded_at: row.get("superseded_at")?,
        superseded_by_job_id: row.get("superseded_by_job_id")?,
        requires_agent_handoff: row.get("requires_agent_handoff")?,
        acopilot_lane_generation: row.get("acopilot_lane_generation")?,
        agent_handoff_ready: row.get("agent_handoff_ready")?,
        auth_user_id: row.get("auth_user_id")?,
        chat_session_id: row.get("chat_session_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
