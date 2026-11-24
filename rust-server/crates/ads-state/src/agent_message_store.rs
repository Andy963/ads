use std::error::Error;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{StateError, StateResult};

const AGENT_MESSAGE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  auth_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  history_key TEXT NOT NULL,
  logical_history_key TEXT NOT NULL,
  lane_namespace TEXT NOT NULL,
  lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
  workspace_root TEXT NOT NULL,
  from_lane TEXT NOT NULL,
  from_role TEXT NOT NULL,
  to_lane TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  issue_id INTEGER,
  issue_title TEXT NOT NULL DEFAULT '',
  issue_url TEXT,
  pr_number INTEGER,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'delivered', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  source_created_at INTEGER NOT NULL,
  transition_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  delivered_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_correlation
  ON agent_messages(auth_user_id, project_id, to_lane, kind, correlation_id);

CREATE INDEX IF NOT EXISTS idx_agent_messages_lane
  ON agent_messages(auth_user_id, project_id, to_lane, lane_generation, status, id);

CREATE INDEX IF NOT EXISTS idx_agent_messages_review
  ON agent_messages(auth_user_id, project_id, kind, issue_id, pr_number, status, id);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageStatus {
    Pending,
    Running,
    Delivered,
    Failed,
    Superseded,
}

impl AgentMessageStatus {
    fn parse(value: &str) -> Self {
        match value.trim() {
            "running" => Self::Running,
            "delivered" => Self::Delivered,
            "failed" => Self::Failed,
            "superseded" => Self::Superseded,
            _ => Self::Pending,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Delivered => "delivered",
            Self::Failed => "failed",
            Self::Superseded => "superseded",
        }
    }
}

impl FromStr for AgentMessageStatus {
    type Err = StateError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let normalized = value.trim();
        if matches!(
            normalized,
            "pending" | "running" | "delivered" | "failed" | "superseded"
        ) {
            Ok(Self::parse(normalized))
        } else {
            Err(StateError::InvalidInput(format!(
                "Unknown agent message status: {value}"
            )))
        }
    }
}

impl ToSql for AgentMessageStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for AgentMessageStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let value = value.as_str()?;
        Self::from_str(value)
            .map_err(|error| FromSqlError::Other(Box::new(error) as Box<dyn Error + Send + Sync>))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageRecord {
    pub id: i64,
    pub message_id: String,
    pub auth_user_id: String,
    pub user_id: i64,
    pub project_id: String,
    pub chat_session_id: String,
    pub history_key: String,
    pub logical_history_key: String,
    pub lane_namespace: String,
    pub lane_generation: i64,
    pub workspace_root: String,
    pub from_lane: String,
    pub from_role: String,
    pub to_lane: String,
    pub to_role: String,
    pub kind: String,
    pub correlation_id: String,
    pub issue_id: Option<i64>,
    pub issue_title: String,
    pub issue_url: Option<String>,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub payload: Map<String, Value>,
    pub status: AgentMessageStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub source_created_at: i64,
    pub transition_revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub delivered_at: Option<i64>,
}

pub const REVIEW_VERDICT_HANDOFF_KIND: &str = "review_verdict";
pub const REVIEW_VERDICT_COMMENT_MARKER: &str = "ads:review-verdict";
pub const AGENT_HANDOFF_SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ReviewVerdictStatus {
    Pass,
    Reject,
    Incomplete,
    Error,
}

impl ReviewVerdictStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_uppercase().as_str() {
            "PASS" => Some(Self::Pass),
            "REJECT" => Some(Self::Reject),
            "INCOMPLETE" => Some(Self::Incomplete),
            "ERROR" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Reject => "REJECT",
            Self::Incomplete => "INCOMPLETE",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdictCommentLocator {
    pub marker: String,
    pub issue_id: i64,
    pub job_id: String,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdictHandoff {
    pub status: ReviewVerdictStatus,
    pub issue_id: i64,
    pub issue_title: String,
    pub issue_url: Option<String>,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub job_id: String,
    pub verdict_comment: ReviewVerdictCommentLocator,
}

impl ReviewVerdictHandoff {
    pub fn to_payload_map(&self) -> Map<String, Value> {
        Map::from_iter([
            (
                "schemaVersion".to_string(),
                json!(AGENT_HANDOFF_SCHEMA_VERSION),
            ),
            ("origin".to_string(), json!("agent")),
            ("agentId".to_string(), json!("codex")),
            ("reviewStatus".to_string(), json!(self.status.as_str())),
            ("issueId".to_string(), json!(self.issue_id)),
            ("issueTitle".to_string(), json!(self.issue_title)),
            ("issueUrl".to_string(), json!(self.issue_url)),
            ("prNumber".to_string(), json!(self.pr_number)),
            ("branch".to_string(), json!(self.branch)),
            ("baseSha".to_string(), json!(self.base_sha)),
            ("headSha".to_string(), json!(self.head_sha)),
            ("jobId".to_string(), json!(self.job_id)),
            (
                "verdictComment".to_string(),
                json!({
                    "marker": self.verdict_comment.marker,
                    "issueId": self.verdict_comment.issue_id,
                    "jobId": self.verdict_comment.job_id,
                    "baseSha": self.verdict_comment.base_sha,
                    "headSha": self.verdict_comment.head_sha,
                }),
            ),
        ])
    }

    pub fn from_record(record: &AgentMessageRecord) -> Option<Self> {
        if record.kind != REVIEW_VERDICT_HANDOFF_KIND {
            return None;
        }
        let issue_id = record
            .issue_id
            .or_else(|| record.payload.get("issueId").and_then(Value::as_i64))
            .filter(|id| *id > 0)?;
        let job_id = if !record.correlation_id.trim().is_empty() {
            record.correlation_id.trim().to_string()
        } else {
            record
                .payload
                .get("jobId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string()
        };
        let status = record
            .payload
            .get("reviewStatus")
            .and_then(Value::as_str)
            .and_then(ReviewVerdictStatus::parse)
            .or_else(|| {
                record
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .and_then(parse_legacy_review_status)
            })
            .unwrap_or(ReviewVerdictStatus::Error);
        let issue_title = if !record.issue_title.trim().is_empty() {
            record.issue_title.trim().to_string()
        } else {
            record
                .payload
                .get("issueTitle")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        let issue_url = record.issue_url.clone().or_else(|| {
            record
                .payload
                .get("issueUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let pr_number = record
            .pr_number
            .or_else(|| record.payload.get("prNumber").and_then(Value::as_i64))
            .filter(|number| *number > 0);
        let branch = record.branch.clone().or_else(|| {
            record
                .payload
                .get("branch")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let base_sha = record.base_sha.clone().or_else(|| {
            record
                .payload
                .get("baseSha")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let head_sha = record.head_sha.clone().or_else(|| {
            record
                .payload
                .get("headSha")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
        let marker = record
            .payload
            .get("verdictComment")
            .and_then(|value| value.get("marker"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(REVIEW_VERDICT_COMMENT_MARKER)
            .to_string();
        Some(Self {
            status,
            issue_id,
            issue_title,
            issue_url,
            pr_number,
            branch,
            base_sha: base_sha.clone(),
            head_sha: head_sha.clone(),
            job_id: job_id.clone(),
            verdict_comment: ReviewVerdictCommentLocator {
                marker,
                issue_id,
                job_id,
                base_sha,
                head_sha,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AgentHandoffPayload {
    ReviewVerdict(ReviewVerdictHandoff),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoff {
    pub id: i64,
    pub message_id: String,
    pub auth_user_id: String,
    pub user_id: i64,
    pub project_id: String,
    pub chat_session_id: String,
    pub history_key: String,
    pub logical_history_key: String,
    pub lane_namespace: String,
    pub lane_generation: i64,
    pub workspace_root: String,
    pub from_lane: String,
    pub from_role: String,
    pub to_lane: String,
    pub to_role: String,
    pub correlation_id: String,
    pub payload: AgentHandoffPayload,
    pub status: AgentMessageStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub source_created_at: i64,
    pub transition_revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub delivered_at: Option<i64>,
}

impl AgentHandoff {
    pub fn from_record(record: &AgentMessageRecord) -> Option<Self> {
        let payload = ReviewVerdictHandoff::from_record(record)
            .map(AgentHandoffPayload::ReviewVerdict)?;
        Some(Self {
            id: record.id,
            message_id: record.message_id.clone(),
            auth_user_id: record.auth_user_id.clone(),
            user_id: record.user_id,
            project_id: record.project_id.clone(),
            chat_session_id: record.chat_session_id.clone(),
            history_key: record.history_key.clone(),
            logical_history_key: record.logical_history_key.clone(),
            lane_namespace: record.lane_namespace.clone(),
            lane_generation: record.lane_generation,
            workspace_root: record.workspace_root.clone(),
            from_lane: record.from_lane.clone(),
            from_role: record.from_role.clone(),
            to_lane: record.to_lane.clone(),
            to_role: record.to_role.clone(),
            correlation_id: record.correlation_id.clone(),
            payload,
            status: record.status,
            attempts: record.attempts,
            last_error: record.last_error.clone(),
            source_created_at: record.source_created_at,
            transition_revision: record.transition_revision,
            created_at: record.created_at,
            updated_at: record.updated_at,
            claimed_at: record.claimed_at,
            delivered_at: record.delivered_at,
        })
    }

    pub fn is_unstarted_superseded(&self) -> bool {
        self.status == AgentMessageStatus::Superseded && self.attempts == 0
    }
}

impl AgentMessageRecord {
    pub fn is_unstarted_superseded(&self) -> bool {
        self.status == AgentMessageStatus::Superseded && self.attempts == 0
    }

    pub fn to_handoff(&self) -> Option<AgentHandoff> {
        AgentHandoff::from_record(self)
    }
}

fn parse_legacy_review_status(text: &str) -> Option<ReviewVerdictStatus> {
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("Status:") {
            let token = rest.trim().trim_end_matches('.');
            if let Some(status) = ReviewVerdictStatus::parse(token) {
                return Some(status);
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct NewAgentMessage {
    pub message_id: String,
    pub auth_user_id: String,
    pub user_id: i64,
    pub project_id: String,
    pub chat_session_id: String,
    pub history_key: String,
    pub logical_history_key: String,
    pub lane_namespace: String,
    pub lane_generation: i64,
    pub workspace_root: String,
    pub from_lane: String,
    pub from_role: String,
    pub to_lane: String,
    pub to_role: String,
    pub kind: String,
    pub correlation_id: String,
    pub issue_id: Option<i64>,
    pub issue_title: String,
    pub issue_url: Option<String>,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub payload: Map<String, Value>,
    pub source_created_at: i64,
    pub force_superseded: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueAgentMessageResult {
    pub message: AgentMessageRecord,
    pub duplicate: bool,
    pub superseded_ids: Vec<String>,
}

pub fn ensure_agent_message_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(AGENT_MESSAGE_SCHEMA_SQL)?;
    Ok(())
}

pub struct AgentMessageStore<'a> {
    connection: &'a Connection,
}

impl<'a> AgentMessageStore<'a> {
    pub fn new(connection: &'a Connection) -> StateResult<Self> {
        Ok(Self { connection })
    }

    pub fn enqueue(
        &self,
        input: NewAgentMessage,
        now: i64,
    ) -> StateResult<EnqueueAgentMessageResult> {
        let transaction = self.connection.unchecked_transaction()?;
        let result = self.enqueue_on(&transaction, input, now, true)?;
        transaction.commit()?;
        Ok(result)
    }

    pub(crate) fn enqueue_in_transaction(
        &self,
        input: NewAgentMessage,
        now: i64,
    ) -> StateResult<EnqueueAgentMessageResult> {
        self.enqueue_on(self.connection, input, now, false)
    }

    fn enqueue_on(
        &self,
        connection: &Connection,
        input: NewAgentMessage,
        now: i64,
        enforce_review_eligibility: bool,
    ) -> StateResult<EnqueueAgentMessageResult> {
        let message_id = input.message_id.trim();
        if message_id.is_empty() {
            return Err(StateError::InvalidInput(
                "Agent message id is required".to_string(),
            ));
        }
        if input.auth_user_id.trim().is_empty()
            || input.project_id.trim().is_empty()
            || input.to_lane.trim().is_empty()
            || input.kind.trim().is_empty()
            || input.correlation_id.trim().is_empty()
            || input.source_created_at < 1
        {
            return Err(StateError::InvalidInput(
                "Agent message requires authenticated project, destination lane, kind, and correlation id"
                    .to_string(),
            ));
        }
        if let Some(existing) = get_agent_message_by_id_on(connection, input.message_id.trim())? {
            return Ok(EnqueueAgentMessageResult {
                message: existing,
                duplicate: true,
                superseded_ids: Vec::new(),
            });
        }
        if input.kind == "review_verdict" {
            let job_state: Option<(String, String, Option<i64>, i64)> = connection
                .query_row(
                    "SELECT job_kind, status, superseded_at, agent_handoff_ready
                     FROM action_jobs
                     WHERE id = ?1",
                    params![input.correlation_id.trim()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let Some((job_kind, job_status, superseded_at, handoff_ready)) = job_state else {
                return Err(StateError::InvalidInput(
                    "Review job was not found before its handoff was enqueued".to_string(),
                ));
            };
            if superseded_at.is_some() {
                return Err(StateError::InvalidInput(
                    "Review job was superseded before its handoff was enqueued".to_string(),
                ));
            }
            if enforce_review_eligibility {
                if job_kind != "pull_request_review"
                    || !matches!(job_status.as_str(), "completed" | "failed")
                {
                    return Err(StateError::InvalidInput(
                        "Review job must reach a terminal status before its handoff is enqueued"
                            .to_string(),
                    ));
                }
                if handoff_ready != 1 {
                    return Err(StateError::InvalidInput(
                        "Review verdict comment must be published before its handoff is enqueued"
                            .to_string(),
                    ));
                }
            }
        }

        let mut superseded_ids = Vec::new();
        let mut incoming_superseded = input.force_superseded;
        if input.kind == "review_verdict" && !input.force_superseded {
            incoming_superseded = connection.query_row(
                "SELECT EXISTS (
                   SELECT 1 FROM agent_messages
                   WHERE auth_user_id = ?1
                     AND project_id = ?2
                     AND to_lane = ?3
                     AND kind = ?4
                     AND issue_id IS ?5
                     AND (
                       (?6 IS NOT NULL AND ?6 > 0 AND pr_number = ?6)
                       OR (COALESCE(pr_number, 0) = 0 AND COALESCE(?6, 0) = 0 AND branch IS ?7)
                     )
                     AND (source_created_at > ?8
                          OR (source_created_at = ?8 AND message_id > ?9))
                     AND status <> 'superseded'
                 )",
                params![
                    input.auth_user_id,
                    input.project_id,
                    input.to_lane,
                    input.kind,
                    input.issue_id,
                    input.pr_number,
                    input.branch.as_deref(),
                    input.source_created_at,
                    input.message_id.trim(),
                ],
                |row| row.get(0),
            )?;
        }
        if input.kind == "review_verdict" && !incoming_superseded {
            let mut statement = connection.prepare(
                "SELECT message_id FROM agent_messages
                 WHERE auth_user_id = ?1
                   AND project_id = ?2
                   AND to_lane = ?3
                   AND kind = ?4
                   AND issue_id IS ?5
                   AND (
                     (?6 IS NOT NULL AND ?6 > 0 AND pr_number = ?6)
                     OR (COALESCE(pr_number, 0) = 0 AND COALESCE(?6, 0) = 0 AND branch IS ?7)
                   )
                   AND (source_created_at < ?8
                        OR (source_created_at = ?8 AND message_id < ?9))
                   AND status IN ('pending', 'failed', 'running')
                   AND message_id <> ?9",
            )?;
            superseded_ids = statement
                .query_map(
                    params![
                        input.auth_user_id,
                        input.project_id,
                        input.to_lane,
                        input.kind,
                        input.issue_id,
                        input.pr_number,
                        input.branch.as_deref(),
                        input.source_created_at,
                        input.message_id.trim(),
                    ],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            if !superseded_ids.is_empty() {
                connection.execute(
                    "UPDATE agent_messages
                     SET status = 'superseded', updated_at = ?1,
                         transition_revision = transition_revision + 1,
                         lease_owner = NULL, lease_expires_at = NULL
                     WHERE auth_user_id = ?2
                       AND project_id = ?3
                       AND to_lane = ?4
                       AND kind = ?5
                       AND issue_id IS ?6
                       AND (
                         (?7 IS NOT NULL AND ?7 > 0 AND pr_number = ?7)
                         OR (COALESCE(pr_number, 0) = 0 AND COALESCE(?7, 0) = 0 AND branch IS ?8)
                       )
                       AND (source_created_at < ?9
                            OR (source_created_at = ?9 AND message_id < ?10))
                       AND status IN ('pending', 'failed', 'running')
                       AND message_id <> ?10",
                    params![
                        now,
                        input.auth_user_id,
                        input.project_id,
                        input.to_lane,
                        input.kind,
                        input.issue_id,
                        input.pr_number,
                        input.branch.as_deref(),
                        input.source_created_at,
                        input.message_id.trim(),
                    ],
                )?;
            }
        }

        connection.execute(
            "INSERT INTO agent_messages (
               message_id, auth_user_id, user_id, project_id, chat_session_id,
               history_key, logical_history_key, lane_namespace, lane_generation,
               workspace_root, from_lane, from_role, to_lane, to_role, kind,
               correlation_id, issue_id, issue_title, issue_url, pr_number, base_sha,
               branch, head_sha, payload_json, status, attempts, source_created_at,
               transition_revision, created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
               ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, 0, ?26, ?27, ?28, ?29
             )",
            params![
                input.message_id.trim(),
                input.auth_user_id.trim(),
                input.user_id,
                input.project_id.trim(),
                input.chat_session_id.trim(),
                input.history_key.trim(),
                input.logical_history_key.trim(),
                input.lane_namespace.trim(),
                input.lane_generation.max(1),
                input.workspace_root.trim(),
                input.from_lane.trim(),
                input.from_role.trim(),
                input.to_lane.trim(),
                input.to_role.trim(),
                input.kind.trim(),
                input.correlation_id.trim(),
                input.issue_id,
                input.issue_title.trim(),
                input.issue_url,
                input.pr_number,
                input.base_sha,
                input.branch,
                input.head_sha,
                serde_json::to_string(&Value::Object(input.payload))?,
                if incoming_superseded {
                    "superseded"
                } else {
                    "pending"
                },
                input.source_created_at,
                if incoming_superseded { 30 } else { 1 },
                input.created_at,
                now,
            ],
        )?;
        let created =
            get_agent_message_by_id_on(connection, input.message_id.trim())?.ok_or_else(|| {
                StateError::InvalidInput("Agent message insert disappeared".to_string())
            })?;
        Ok(EnqueueAgentMessageResult {
            message: created,
            duplicate: false,
            superseded_ids,
        })
    }

    pub fn get_by_message_id(&self, message_id: &str) -> StateResult<Option<AgentMessageRecord>> {
        get_agent_message_by_id_on(self.connection, message_id)
    }

    pub fn list_recoverable(&self, now: i64) -> StateResult<Vec<AgentMessageRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM agent_messages
             WHERE (status = 'pending'
                OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)))
               AND (
                 kind <> 'review_verdict'
                 OR EXISTS (
                   SELECT 1
                   FROM action_jobs j
                   WHERE j.id = agent_messages.correlation_id
                     AND j.superseded_at IS NULL
                 )
               )
             ORDER BY id ASC",
        )?;
        let rows = statement.query_map(params![now], map_agent_message)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_for_lane(
        &self,
        auth_user_id: &str,
        project_id: &str,
        to_lane: &str,
        lane_generation: i64,
        limit: usize,
    ) -> StateResult<Vec<AgentMessageRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM agent_messages
             WHERE auth_user_id = ?1
               AND project_id = ?2
               AND to_lane = ?3
               AND lane_generation = ?4
             ORDER BY id DESC
             LIMIT ?5",
        )?;
        let rows = statement.query_map(
            params![
                auth_user_id,
                project_id,
                to_lane,
                lane_generation.max(1),
                limit.max(1) as i64
            ],
            map_agent_message,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_visible_for_lane(
        &self,
        auth_user_id: &str,
        project_id: &str,
        to_lane: &str,
        lane_generation: i64,
        limit: usize,
    ) -> StateResult<Vec<AgentMessageRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT * FROM (
               SELECT * FROM agent_messages
               WHERE auth_user_id = ?1
                 AND project_id = ?2
                 AND to_lane = ?3
                 AND lane_generation = ?4
                 AND NOT (status = 'superseded' AND attempts = 0)
               ORDER BY id DESC
               LIMIT ?5
             )
             ORDER BY id ASC",
        )?;
        let rows = statement.query_map(
            params![
                auth_user_id,
                project_id,
                to_lane,
                lane_generation.max(1),
                limit.max(1) as i64
            ],
            map_agent_message,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn claim(
        &self,
        message_id: &str,
        worker_id: &str,
        lease_expires_at: i64,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let changed = self.connection.execute(
            "UPDATE agent_messages
             SET status = 'running', attempts = attempts + 1, claimed_at = ?1,
                 updated_at = ?1, last_error = NULL, lease_owner = ?2,
                 transition_revision = transition_revision + 1,
                 lease_expires_at = ?3
             WHERE message_id = ?4
               AND (status = 'pending'
                    OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)))
               AND (
                 kind <> 'review_verdict'
                 OR EXISTS (
                   SELECT 1 FROM action_jobs j
                   WHERE j.id = agent_messages.correlation_id
                     AND j.superseded_at IS NULL
                 )
               )",
            params![now, worker_id, lease_expires_at, message_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_by_message_id(message_id)
    }

    pub fn retry_failed(
        &self,
        message_id: &str,
        auth_user_id: &str,
        project_id: &str,
        to_lane: &str,
        lane_generation: i64,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let changed = self.connection.execute(
            "UPDATE agent_messages
             SET status = 'pending', updated_at = ?1, last_error = NULL,
                 transition_revision = transition_revision + 1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2
               AND auth_user_id = ?3
               AND project_id = ?4
               AND to_lane = ?5
               AND lane_generation = ?6
               AND status = 'failed'
               AND (
                 kind <> 'review_verdict'
                 OR EXISTS (
                   SELECT 1
                   FROM action_jobs j
                   WHERE j.id = agent_messages.correlation_id
                     AND j.superseded_at IS NULL
                 )
               )",
            params![
                now,
                message_id,
                auth_user_id,
                project_id,
                to_lane,
                lane_generation.max(1)
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_by_message_id(message_id)
    }

    pub fn renew(
        &self,
        message_id: &str,
        worker_id: &str,
        lease_expires_at: i64,
        now: i64,
    ) -> StateResult<bool> {
        Ok(self.connection.execute(
            "UPDATE agent_messages
             SET lease_expires_at = ?1, updated_at = ?2
             WHERE message_id = ?3 AND status = 'running' AND lease_owner = ?4
               AND lease_expires_at > ?2
               AND agent_messages.lane_generation = COALESCE((
                 SELECT generation FROM web_lane_generations
                 WHERE namespace = agent_messages.lane_namespace
                   AND lane_key = agent_messages.logical_history_key
               ), 1)
               AND (
                 kind <> 'review_verdict'
                 OR EXISTS (
                   SELECT 1 FROM action_jobs j
                   WHERE j.id = agent_messages.correlation_id
                     AND j.superseded_at IS NULL
                 )
               )",
            params![lease_expires_at, now, message_id, worker_id],
        )? == 1)
    }

    pub fn is_current_running(&self, message_id: &str) -> StateResult<bool> {
        Ok(self.connection.query_row(
            "SELECT EXISTS (
               SELECT 1 FROM agent_messages m
               WHERE m.message_id = ?1 AND m.status = 'running'
                 AND (
                   m.kind <> 'review_verdict'
                   OR EXISTS (
                     SELECT 1 FROM action_jobs j
                     WHERE j.id = m.correlation_id
                       AND j.superseded_at IS NULL
                   )
                 )
             )",
            params![message_id],
            |row| row.get(0),
        )?)
    }

    pub fn mark_delivered(
        &self,
        message_id: &str,
        worker_id: &str,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        self.finish(
            message_id,
            worker_id,
            AgentMessageStatus::Delivered,
            None,
            now,
        )
    }

    pub fn mark_failed(
        &self,
        message_id: &str,
        worker_id: &str,
        error: &str,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        self.finish(
            message_id,
            worker_id,
            AgentMessageStatus::Failed,
            Some(error),
            now,
        )
    }

    pub fn mark_superseded(&self, message_id: &str, now: i64) -> StateResult<bool> {
        Ok(self.connection.execute(
            "UPDATE agent_messages
             SET status = 'superseded', updated_at = ?1, lease_owner = NULL, lease_expires_at = NULL,
                 transition_revision = transition_revision + 1
             WHERE message_id = ?2
               AND (status IN ('pending', 'failed')
                    OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)))",
            params![now, message_id],
        )? == 1)
    }

    pub fn supersede_messages_for_superseded_review_jobs(
        &self,
        now: i64,
    ) -> StateResult<Vec<AgentMessageRecord>> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut statement = transaction.prepare(
            "SELECT message_id FROM agent_messages
             WHERE kind = 'review_verdict'
               AND status IN ('pending', 'failed', 'running')
               AND EXISTS (
                 SELECT 1 FROM action_jobs j
                 WHERE j.id = agent_messages.correlation_id
                   AND j.superseded_at IS NOT NULL
               )",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        if !ids.is_empty() {
            transaction.execute(
                "UPDATE agent_messages
                 SET status = 'superseded', updated_at = ?1,
                     transition_revision = transition_revision + 1,
                     lease_owner = NULL, lease_expires_at = NULL
                 WHERE kind = 'review_verdict'
                   AND status IN ('pending', 'failed', 'running')
                   AND EXISTS (
                     SELECT 1 FROM action_jobs j
                     WHERE j.id = agent_messages.correlation_id
                       AND j.superseded_at IS NOT NULL
                   )",
                params![now],
            )?;
        }
        let mut updated = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(msg) = get_agent_message_by_id_on(&transaction, &id)? {
                updated.push(msg);
            }
        }
        transaction.commit()?;
        Ok(updated)
    }

    pub fn mark_running_superseded(
        &self,
        message_id: &str,
        worker_id: &str,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let transaction = self.connection.unchecked_transaction()?;
        let superseded = transaction.execute(
            "UPDATE agent_messages
             SET status = 'superseded', updated_at = ?1,
                 transition_revision = transition_revision + 1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2 AND status = 'running' AND lease_owner = ?3
               AND kind = 'review_verdict'
               AND NOT EXISTS (
                 SELECT 1 FROM action_jobs j
                 WHERE j.id = agent_messages.correlation_id
                   AND j.superseded_at IS NULL
               )",
            params![now, message_id, worker_id],
        )?;
        if superseded > 0 {
            let message = get_agent_message_by_id_on(&transaction, message_id)?;
            transaction.commit()?;
            return Ok(message);
        }
        let changed = transaction.execute(
            "UPDATE agent_messages
             SET status = 'superseded', updated_at = ?1,
                 transition_revision = transition_revision + 1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2 AND status = 'running' AND lease_owner = ?3",
            params![now, message_id, worker_id],
        )?;
        if changed == 0 {
            transaction.commit()?;
            return Ok(None);
        }
        let message = get_agent_message_by_id_on(&transaction, message_id)?;
        transaction.commit()?;
        Ok(message)
    }

    fn finish(
        &self,
        message_id: &str,
        worker_id: &str,
        status: AgentMessageStatus,
        error: Option<&str>,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let transaction = self.connection.unchecked_transaction()?;
        let review_superseded = transaction.query_row(
            "SELECT EXISTS (
                   SELECT 1 FROM agent_messages m
                   WHERE m.message_id = ?1 AND m.kind = 'review_verdict'
                     AND NOT EXISTS (
                       SELECT 1 FROM action_jobs j
                       WHERE j.id = m.correlation_id
                         AND j.superseded_at IS NULL
                     )
                 )",
            params![message_id],
            |row| row.get::<_, bool>(0),
        )?;
        if review_superseded {
            transaction.execute(
                "UPDATE agent_messages
                 SET status = 'superseded', updated_at = ?1,
                     transition_revision = transition_revision + 1,
                     lease_owner = NULL, lease_expires_at = NULL
                 WHERE message_id = ?2 AND status = 'running' AND lease_owner = ?3",
                params![now, message_id, worker_id],
            )?;
            let message = get_agent_message_by_id_on(&transaction, message_id)?;
            transaction.commit()?;
            return Ok(message);
        }
        let changed = transaction.execute(
            "UPDATE agent_messages
             SET status = ?1, updated_at = ?2, last_error = ?3,
                 delivered_at = CASE WHEN ?1 = 'delivered' THEN ?2 ELSE delivered_at END,
                 lease_owner = NULL, lease_expires_at = NULL,
                 transition_revision = transition_revision + 1
             WHERE message_id = ?4 AND status = 'running' AND lease_owner = ?5
               AND lease_expires_at > ?2
               AND agent_messages.lane_generation = COALESCE((
                 SELECT generation FROM web_lane_generations
                 WHERE namespace = agent_messages.lane_namespace
                   AND lane_key = agent_messages.logical_history_key
               ), 1)",
            params![status, now, error, message_id, worker_id],
        )?;
        if changed == 0 {
            transaction.commit()?;
            return Ok(None);
        }
        let message = get_agent_message_by_id_on(&transaction, message_id)?;
        transaction.commit()?;
        Ok(message)
    }
}

fn get_agent_message_by_id_on(
    connection: &Connection,
    message_id: &str,
) -> StateResult<Option<AgentMessageRecord>> {
    connection
        .query_row(
            "SELECT * FROM agent_messages WHERE message_id = ?1",
            params![message_id],
            map_agent_message,
        )
        .optional()
        .map_err(StateError::from)
}

fn map_agent_message(row: &Row<'_>) -> rusqlite::Result<AgentMessageRecord> {
    let payload_json: String = row.get("payload_json")?;
    let payload = serde_json::from_str::<Value>(&payload_json)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    Ok(AgentMessageRecord {
        id: row.get("id")?,
        message_id: row.get("message_id")?,
        auth_user_id: row.get("auth_user_id")?,
        user_id: row.get("user_id")?,
        project_id: row.get("project_id")?,
        chat_session_id: row.get("chat_session_id")?,
        history_key: row.get("history_key")?,
        logical_history_key: row.get("logical_history_key")?,
        lane_namespace: row.get("lane_namespace")?,
        lane_generation: row.get("lane_generation")?,
        workspace_root: row.get("workspace_root")?,
        from_lane: row.get("from_lane")?,
        from_role: row.get("from_role")?,
        to_lane: row.get("to_lane")?,
        to_role: row.get("to_role")?,
        kind: row.get("kind")?,
        correlation_id: row.get("correlation_id")?,
        issue_id: row.get("issue_id")?,
        issue_title: row.get("issue_title")?,
        issue_url: row.get("issue_url")?,
        pr_number: row.get("pr_number")?,
        branch: row.get("branch")?,
        base_sha: row.get("base_sha")?,
        head_sha: row.get("head_sha")?,
        payload,
        status: row.get("status")?,
        attempts: row.get("attempts")?,
        last_error: row.get("last_error")?,
        source_created_at: row.get("source_created_at")?,
        transition_revision: row.get("transition_revision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        claimed_at: row.get("claimed_at")?,
        delivered_at: row.get("delivered_at")?,
    })
}
