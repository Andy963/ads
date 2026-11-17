use std::error::Error;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
  base_sha TEXT,
  head_sha TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'delivered', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  source_created_at INTEGER NOT NULL,
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
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub payload: Map<String, Value>,
    pub status: AgentMessageStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub source_created_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub delivered_at: Option<i64>,
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
    pub base_sha: Option<String>,
    pub head_sha: Option<String>,
    pub payload: Map<String, Value>,
    pub source_created_at: i64,
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
        let transaction = self.connection.unchecked_transaction()?;
        if let Some(existing) = get_agent_message_by_id_on(&transaction, input.message_id.trim())? {
            transaction.commit()?;
            return Ok(EnqueueAgentMessageResult {
                message: existing,
                duplicate: true,
                superseded_ids: Vec::new(),
            });
        }

        let mut superseded_ids = Vec::new();
        let mut incoming_superseded = false;
        if input.kind == "review_verdict" {
            incoming_superseded = transaction.query_row(
                "SELECT EXISTS (
                   SELECT 1 FROM agent_messages
                   WHERE auth_user_id = ?1
                     AND project_id = ?2
                     AND to_lane = ?3
                     AND kind = ?4
                     AND issue_id IS ?5
                     AND pr_number IS ?6
                     AND (source_created_at > ?7
                          OR (source_created_at = ?7 AND message_id > ?8))
                     AND status <> 'superseded'
                 )",
                params![
                    input.auth_user_id,
                    input.project_id,
                    input.to_lane,
                    input.kind,
                    input.issue_id,
                    input.pr_number,
                    input.source_created_at,
                    input.message_id.trim(),
                ],
                |row| row.get(0),
            )?;
        }
        if input.kind == "review_verdict" && !incoming_superseded {
            let mut statement = transaction.prepare(
                "SELECT message_id FROM agent_messages
                 WHERE auth_user_id = ?1
                   AND project_id = ?2
                   AND to_lane = ?3
                   AND kind = ?4
                   AND issue_id IS ?5
                   AND pr_number IS ?6
                   AND (source_created_at < ?7
                        OR (source_created_at = ?7 AND message_id < ?8))
                   AND status IN ('pending', 'failed', 'running')
                   AND message_id <> ?8",
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
                        input.source_created_at,
                        input.message_id.trim(),
                    ],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            if !superseded_ids.is_empty() {
                transaction.execute(
                    "UPDATE agent_messages
                     SET status = 'superseded', updated_at = ?1, lease_owner = NULL, lease_expires_at = NULL
                     WHERE auth_user_id = ?2
                       AND project_id = ?3
                       AND to_lane = ?4
                       AND kind = ?5
                       AND issue_id IS ?6
                       AND pr_number IS ?7
                       AND (source_created_at < ?8
                            OR (source_created_at = ?8 AND message_id < ?9))
                       AND status IN ('pending', 'failed', 'running')
                       AND message_id <> ?9",
                    params![
                        now,
                        input.auth_user_id,
                        input.project_id,
                        input.to_lane,
                        input.kind,
                        input.issue_id,
                        input.pr_number,
                        input.source_created_at,
                        input.message_id.trim(),
                    ],
                )?;
            }
        }

        transaction.execute(
            "INSERT INTO agent_messages (
               message_id, auth_user_id, user_id, project_id, chat_session_id,
               history_key, logical_history_key, lane_namespace, lane_generation,
               workspace_root, from_lane, from_role, to_lane, to_role, kind,
               correlation_id, issue_id, issue_title, issue_url, pr_number, base_sha,
               head_sha, payload_json, status, attempts, source_created_at,
               created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
               ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, 0, ?25, ?26, ?27
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
                input.head_sha,
                serde_json::to_string(&Value::Object(input.payload))?,
                if incoming_superseded {
                    "superseded"
                } else {
                    "pending"
                },
                input.source_created_at,
                input.created_at,
                now,
            ],
        )?;
        let created = get_agent_message_by_id_on(&transaction, input.message_id.trim())?
            .ok_or_else(|| {
                StateError::InvalidInput("Agent message insert disappeared".to_string())
            })?;
        transaction.commit()?;
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
             WHERE status = 'pending'
                OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1))
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
                 lease_expires_at = ?3
             WHERE message_id = ?4
               AND (status = 'pending'
                    OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)))",
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
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2
               AND auth_user_id = ?3
               AND project_id = ?4
               AND to_lane = ?5
               AND lane_generation = ?6
               AND status = 'failed'",
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
             WHERE message_id = ?3 AND status = 'running' AND lease_owner = ?4",
            params![lease_expires_at, now, message_id, worker_id],
        )? == 1)
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
             SET status = 'superseded', updated_at = ?1, lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2
               AND (status IN ('pending', 'failed')
                    OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)))",
            params![now, message_id],
        )? == 1)
    }

    pub fn mark_running_superseded(
        &self,
        message_id: &str,
        worker_id: &str,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let changed = self.connection.execute(
            "UPDATE agent_messages
             SET status = 'superseded', updated_at = ?1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?2 AND status = 'running' AND lease_owner = ?3",
            params![now, message_id, worker_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_by_message_id(message_id)
    }

    fn finish(
        &self,
        message_id: &str,
        worker_id: &str,
        status: AgentMessageStatus,
        error: Option<&str>,
        now: i64,
    ) -> StateResult<Option<AgentMessageRecord>> {
        let changed = self.connection.execute(
            "UPDATE agent_messages
             SET status = ?1, updated_at = ?2, last_error = ?3,
                 delivered_at = CASE WHEN ?1 = 'delivered' THEN ?2 ELSE delivered_at END,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE message_id = ?4 AND status = 'running' AND lease_owner = ?5",
            params![status, now, error, message_id, worker_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_by_message_id(message_id)
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
        base_sha: row.get("base_sha")?,
        head_sha: row.get("head_sha")?,
        payload,
        status: row.get("status")?,
        attempts: row.get("attempts")?,
        last_error: row.get("last_error")?,
        source_created_at: row.get("source_created_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        claimed_at: row.get("claimed_at")?,
        delivered_at: row.get("delivered_at")?,
    })
}
