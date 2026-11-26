use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{StateError, StateResult};

pub const INTERRUPTED_PROMPT_ERROR: &str = "Prompt execution was interrupted before completion. Retry explicitly to resume with incomplete-turn recovery.";

const PROMPT_QUEUE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS prompt_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_message_id TEXT NOT NULL UNIQUE,
  auth_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  history_key TEXT NOT NULL,
  logical_history_key TEXT NOT NULL,
  lane_namespace TEXT NOT NULL,
  lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
  workspace_root TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_prompt_queue_lane_fifo
  ON prompt_queue(auth_user_id, session_id, chat_session_id, logical_history_key, lane_generation, status, id);

CREATE INDEX IF NOT EXISTS idx_prompt_queue_active
  ON prompt_queue(status, id);

CREATE TABLE IF NOT EXISTS prompt_queue_ownership (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  owner_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_queue_cancellations (
  client_message_id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  logical_history_key TEXT NOT NULL,
  lane_namespace TEXT NOT NULL,
  lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
  cancelled_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_queue_cancellations_scope
  ON prompt_queue_cancellations(auth_user_id, session_id, chat_session_id, logical_history_key);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptQueueStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

impl PromptQueueStatus {
    fn parse(value: &str) -> Self {
        match value.trim() {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            _ => Self::Queued,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptIdentityDisposition {
    Pending,
    Consumed,
    Cancelled,
    Obsolete,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptQueueCancelReason {
    Cancelled,
    AlreadyCancelled,
    NotQueued,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptQueueEntry {
    pub id: i64,
    pub client_message_id: String,
    pub auth_user_id: String,
    pub user_id: i64,
    pub session_id: String,
    pub chat_session_id: String,
    pub history_key: String,
    pub logical_history_key: String,
    pub lane_namespace: String,
    pub lane_generation: i64,
    pub workspace_root: String,
    pub payload: Map<String, Value>,
    pub payload_hash: String,
    pub status: PromptQueueStatus,
    pub position: i64,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptQueueLane {
    pub auth_user_id: String,
    pub session_id: String,
    pub chat_session_id: String,
    pub history_key: String,
    pub logical_history_key: String,
    pub lane_namespace: String,
    pub lane_generation: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelPromptInput {
    pub client_message_id: String,
    pub lane: PromptQueueLane,
    pub user_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelPromptResult {
    pub cancelled: bool,
    pub reason: PromptQueueCancelReason,
    pub entry: Option<PromptQueueEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueuePromptInput {
    pub client_message_id: String,
    pub lane: PromptQueueLane,
    pub user_id: i64,
    pub workspace_root: String,
    pub payload: Map<String, Value>,
    pub retry_failed: bool,
    pub retry_original: bool,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcilePromptIdentitiesInput {
    pub lane: PromptQueueLane,
    pub user_id: i64,
    pub client_message_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptIdentityReconciliation {
    pub client_message_id: String,
    pub disposition: PromptIdentityDisposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EnqueuePromptResult {
    pub entry: PromptQueueEntry,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptQueueOwnershipClaim {
    pub claimed: bool,
    pub previous_owner_id: Option<String>,
}

pub fn ensure_prompt_queue_tables(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(PROMPT_QUEUE_SCHEMA_SQL)?;
    let mut statement = connection.prepare("PRAGMA table_info(prompt_queue)")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "payload_hash") {
        connection.execute(
            "ALTER TABLE prompt_queue ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

pub fn hash_prompt_queue_payload(payload: &Map<String, Value>) -> String {
    let canonical = canonicalize_payload(&Value::Object(payload.clone()));
    let encoded = serde_json::to_string(&canonical).unwrap_or_else(|_| "null".to_string());
    format!("{:x}", Sha256::digest(encoded.as_bytes()))
}

fn canonicalize_payload(value: &Value) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.iter().map(canonicalize_payload).collect::<Vec<_>>())
        }
        Value::Object(record) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in record {
                if key == "replay_incomplete" {
                    continue;
                }
                sorted.insert(key.clone(), canonicalize_payload(value));
            }
            Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn retry_control_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn merge_retry_controls(
    payload: &mut Map<String, Value>,
    model: Option<String>,
    effort: Option<String>,
) {
    if let Some(model) = model {
        payload.insert("model".to_string(), Value::String(model));
    }
    if let Some(effort) = effort {
        payload.remove("modelReasoningEffort");
        payload.remove("model_reasoning_effort");
        payload.insert("modelReasoningEffort".to_string(), Value::String(effort));
    }
}

fn required_text(value: &str, field: &str) -> StateResult<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(StateError::InvalidInput(format!(
            "{field} must not be empty"
        )));
    }
    Ok(normalized.to_string())
}

fn parse_payload(value: &str) -> StateResult<Map<String, Value>> {
    let parsed: Value = serde_json::from_str(if value.trim().is_empty() { "{}" } else { value })
        .map_err(|_| StateError::InvalidInput("Stored prompt payload is invalid".to_string()))?;
    match parsed {
        Value::Object(payload) => Ok(payload),
        _ => Err(StateError::InvalidInput(
            "Stored prompt payload must be an object".to_string(),
        )),
    }
}

fn normalize_lane(lane: &PromptQueueLane) -> StateResult<PromptQueueLane> {
    Ok(PromptQueueLane {
        auth_user_id: required_text(&lane.auth_user_id, "authUserId")?,
        session_id: required_text(&lane.session_id, "sessionId")?,
        chat_session_id: required_text(&lane.chat_session_id, "chatSessionId")?,
        history_key: required_text(&lane.history_key, "historyKey")?,
        logical_history_key: required_text(&lane.logical_history_key, "logicalHistoryKey")?,
        lane_namespace: required_text(&lane.lane_namespace, "laneNamespace")?,
        lane_generation: lane.lane_generation.max(1),
    })
}

fn same_prompt_scope(entry: &PromptQueueEntry, user_id: i64, lane: &PromptQueueLane) -> bool {
    entry.user_id == user_id
        && entry.auth_user_id == lane.auth_user_id
        && entry.session_id == lane.session_id
        && entry.chat_session_id == lane.chat_session_id
        && entry.logical_history_key == lane.logical_history_key
        && entry.lane_namespace == lane.lane_namespace
}

struct PromptQueueRow {
    id: i64,
    client_message_id: String,
    auth_user_id: String,
    user_id: i64,
    session_id: String,
    chat_session_id: String,
    history_key: String,
    logical_history_key: String,
    lane_namespace: String,
    lane_generation: i64,
    workspace_root: String,
    payload_json: String,
    payload_hash: String,
    status: String,
    position: i64,
    attempts: i64,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
    started_at: Option<i64>,
    completed_at: Option<i64>,
}

impl PromptQueueRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            client_message_id: row.get("client_message_id")?,
            auth_user_id: row.get("auth_user_id")?,
            user_id: row.get("user_id")?,
            session_id: row.get("session_id")?,
            chat_session_id: row.get("chat_session_id")?,
            history_key: row.get("history_key")?,
            logical_history_key: row.get("logical_history_key")?,
            lane_namespace: row.get("lane_namespace")?,
            lane_generation: row.get("lane_generation")?,
            workspace_root: row.get("workspace_root")?,
            payload_json: row.get("payload_json")?,
            payload_hash: row.get("payload_hash")?,
            status: row.get("status")?,
            position: row.get("position")?,
            attempts: row.get("attempts")?,
            last_error: row.get("last_error")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
        })
    }

    fn into_entry(self) -> StateResult<PromptQueueEntry> {
        Ok(PromptQueueEntry {
            id: self.id,
            client_message_id: self.client_message_id,
            auth_user_id: self.auth_user_id,
            user_id: self.user_id,
            session_id: self.session_id,
            chat_session_id: self.chat_session_id,
            history_key: self.history_key,
            logical_history_key: self.logical_history_key,
            lane_namespace: self.lane_namespace,
            lane_generation: self.lane_generation,
            workspace_root: self.workspace_root,
            payload: parse_payload(&self.payload_json)?,
            payload_hash: self.payload_hash,
            status: PromptQueueStatus::parse(&self.status),
            position: self.position,
            attempts: self.attempts,
            last_error: self.last_error,
            created_at: self.created_at,
            updated_at: self.updated_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
        })
    }
}

pub struct PromptQueueStore<'a> {
    connection: &'a Connection,
}

impl<'a> PromptQueueStore<'a> {
    pub fn new(connection: &'a Connection) -> StateResult<Self> {
        ensure_prompt_queue_tables(connection)?;
        Ok(Self { connection })
    }

    pub fn get_by_client_message_id(
        &self,
        client_message_id: &str,
    ) -> StateResult<Option<PromptQueueEntry>> {
        let client_message_id = required_text(client_message_id, "clientMessageId")?;
        self.connection
            .query_row(
                "SELECT *, 0 AS position FROM prompt_queue
                 WHERE client_message_id = ?1 LIMIT 1",
                params![client_message_id],
                PromptQueueRow::from_row,
            )
            .optional()?
            .map(PromptQueueRow::into_entry)
            .transpose()
    }

    pub fn enqueue(&self, input: EnqueuePromptInput, now: i64) -> StateResult<EnqueuePromptResult> {
        let client_message_id = required_text(&input.client_message_id, "clientMessageId")?;
        let lane = normalize_lane(&input.lane)?;
        if input.retry_original && !input.retry_failed {
            return Err(StateError::InvalidInput(
                "Retrying the original prompt requires an explicit replay request".to_string(),
            ));
        }

        let refreshed_model = retry_control_text(input.payload.get("model"));
        let refreshed_effort = retry_control_text(input.payload.get("modelReasoningEffort"))
            .or_else(|| retry_control_text(input.payload.get("model_reasoning_effort")));
        let mut payload = input.payload;
        let mut payload_hash = hash_prompt_queue_payload(&payload);
        if self.is_cancelled(&client_message_id, input.user_id, &lane)? {
            return Err(StateError::InvalidInput(
                "clientMessageId was cancelled".to_string(),
            ));
        }

        if let Some(existing) = self.get_by_client_message_id(&client_message_id)? {
            let same_scope = existing.user_id == input.user_id
                && existing.auth_user_id == lane.auth_user_id
                && existing.session_id == lane.session_id
                && existing.chat_session_id == lane.chat_session_id
                && existing.history_key == lane.history_key
                && existing.logical_history_key == lane.logical_history_key
                && existing.lane_namespace == lane.lane_namespace
                && existing.lane_generation == lane.lane_generation
                && existing.workspace_root == input.workspace_root;
            if !same_scope {
                return Err(StateError::InvalidInput(
                    "clientMessageId is already associated with a different prompt scope"
                        .to_string(),
                ));
            }
            if input.retry_original {
                if existing.status != PromptQueueStatus::Failed {
                    return Ok(EnqueuePromptResult {
                        entry: existing,
                        duplicate: true,
                    });
                }
                payload = existing.payload.clone();
                merge_retry_controls(&mut payload, refreshed_model, refreshed_effort);
                payload.insert("replay_incomplete".to_string(), Value::Bool(true));
                payload_hash = hash_prompt_queue_payload(&payload);
            }
            if !input.retry_original
                && !existing.payload_hash.is_empty()
                && existing.payload_hash != payload_hash
            {
                return Err(StateError::InvalidInput(
                    "clientMessageId is already associated with a different prompt payload"
                        .to_string(),
                ));
            }
            if existing.status == PromptQueueStatus::Failed && input.retry_failed {
                let payload_json = serde_json::to_string(&payload)?;
                let changed = self.connection.execute(
                    "UPDATE prompt_queue
                     SET status = 'queued', payload_json = ?1, payload_hash = ?2, attempts = 0,
                         last_error = NULL, created_at = ?3, updated_at = ?3, started_at = NULL,
                         completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL
                     WHERE id = ?4 AND status = 'failed'",
                    params![payload_json, payload_hash, now, existing.id],
                )?;
                if changed == 1 {
                    let entry = self
                        .get_by_client_message_id(&client_message_id)?
                        .ok_or_else(|| {
                            StateError::InvalidInput(
                                "Prompt queue update could not be read back".to_string(),
                            )
                        })?;
                    return Ok(EnqueuePromptResult {
                        entry,
                        duplicate: false,
                    });
                }
            }
            return Ok(EnqueuePromptResult {
                entry: existing,
                duplicate: true,
            });
        }

        if input.retry_original {
            return Err(StateError::InvalidInput(
                "The original prompt is no longer available. Please send a new message with its attachments."
                    .to_string(),
            ));
        }

        let created_at = input.created_at.unwrap_or(now);
        let payload_json = serde_json::to_string(&payload)?;
        self.connection.execute(
            "INSERT INTO prompt_queue (
               client_message_id, auth_user_id, user_id, session_id, chat_session_id,
               history_key, logical_history_key, lane_namespace, lane_generation,
               workspace_root, payload_json, payload_hash, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'queued', ?13, ?13)",
            params![
                client_message_id,
                lane.auth_user_id,
                input.user_id,
                lane.session_id,
                lane.chat_session_id,
                lane.history_key,
                lane.logical_history_key,
                lane.lane_namespace,
                lane.lane_generation,
                input.workspace_root,
                payload_json,
                payload_hash,
                created_at,
            ],
        )?;
        let entry = self
            .get_by_client_message_id(&client_message_id)?
            .ok_or_else(|| {
                StateError::InvalidInput("Prompt queue insert could not be read back".to_string())
            })?;
        Ok(EnqueuePromptResult {
            entry,
            duplicate: false,
        })
    }

    pub fn list_lane(&self, lane: &PromptQueueLane) -> StateResult<Vec<PromptQueueEntry>> {
        let lane = normalize_lane(lane)?;
        let mut statement = self.connection.prepare(
            "SELECT *, (
               SELECT COUNT(*)
               FROM prompt_queue earlier
               WHERE earlier.auth_user_id = prompt_queue.auth_user_id
                 AND earlier.session_id = prompt_queue.session_id
                 AND earlier.chat_session_id = prompt_queue.chat_session_id
                 AND earlier.logical_history_key = prompt_queue.logical_history_key
                 AND earlier.lane_generation = prompt_queue.lane_generation
                 AND earlier.status IN ('queued', 'running')
                 AND earlier.id <= prompt_queue.id
             ) AS position
             FROM prompt_queue
             WHERE auth_user_id = ?1
               AND session_id = ?2
               AND chat_session_id = ?3
               AND logical_history_key = ?4
               AND lane_generation = ?5
               AND status IN ('queued', 'running', 'completed', 'failed')
             ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(
                params![
                    lane.auth_user_id,
                    lane.session_id,
                    lane.chat_session_id,
                    lane.logical_history_key,
                    lane.lane_generation
                ],
                PromptQueueRow::from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(PromptQueueRow::into_entry).collect()
    }

    pub fn list_logical_lane(&self, lane: &PromptQueueLane) -> StateResult<Vec<PromptQueueEntry>> {
        let lane = normalize_lane(lane)?;
        let mut statement = self.connection.prepare(
            "SELECT *, (
               SELECT COUNT(*)
               FROM prompt_queue earlier
               WHERE earlier.auth_user_id = prompt_queue.auth_user_id
                 AND earlier.session_id = prompt_queue.session_id
                 AND earlier.chat_session_id = prompt_queue.chat_session_id
                 AND earlier.logical_history_key = prompt_queue.logical_history_key
                 AND earlier.status IN ('queued', 'running')
                 AND earlier.id <= prompt_queue.id
             ) AS position
             FROM prompt_queue
             WHERE auth_user_id = ?1
               AND session_id = ?2
               AND chat_session_id = ?3
               AND logical_history_key = ?4
               AND status IN ('queued', 'running', 'completed', 'failed')
             ORDER BY id ASC",
        )?;
        let rows = statement
            .query_map(
                params![
                    lane.auth_user_id,
                    lane.session_id,
                    lane.chat_session_id,
                    lane.logical_history_key
                ],
                PromptQueueRow::from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(PromptQueueRow::into_entry).collect()
    }

    pub fn list_recoverable(&self) -> StateResult<Vec<PromptQueueEntry>> {
        self.query_entries(
            "SELECT *, 0 AS position FROM prompt_queue
             WHERE status = 'queued' ORDER BY id ASC",
            [],
        )
    }

    pub fn list_interrupted(
        &self,
        previous_owner_id: Option<&str>,
        now: i64,
    ) -> StateResult<Vec<PromptQueueEntry>> {
        self.query_entries(
            "SELECT *, 0 AS position FROM prompt_queue
             WHERE status = 'running'
               AND (lease_owner IS NULL OR lease_expires_at IS NULL
                    OR lease_expires_at <= ?1 OR lease_owner = ?2)
             ORDER BY id ASC",
            params![now, previous_owner_id],
        )
    }

    pub fn mark_running(
        &self,
        id: i64,
        lease_owner: &str,
        now: i64,
        lease_ms: i64,
    ) -> StateResult<bool> {
        let owner = required_text(lease_owner, "leaseOwner")?;
        let changed = self.connection.execute(
            "UPDATE prompt_queue
             SET status = 'running', attempts = attempts + 1, started_at = ?1, updated_at = ?1,
                 lease_owner = ?2, lease_expires_at = ?3, last_error = NULL
             WHERE id = ?4 AND status = 'queued'
               AND EXISTS (
                 SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?2 AND lease_expires_at > ?1
               )",
            params![now, owner, now + lease_ms, id],
        )?;
        Ok(changed == 1)
    }

    pub fn mark_completed(&self, id: i64, lease_owner: &str, now: i64) -> StateResult<bool> {
        let owner = required_text(lease_owner, "leaseOwner")?;
        let changed = self.connection.execute(
            "UPDATE prompt_queue
             SET status = 'completed', payload_json = '{}', updated_at = ?1, completed_at = ?1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ?2 AND status = 'running' AND lease_owner = ?3
               AND EXISTS (
                 SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?3 AND lease_expires_at > ?1
               )",
            params![now, id, owner],
        )?;
        Ok(changed == 1)
    }

    pub fn mark_failed(
        &self,
        id: i64,
        error: impl Into<String>,
        lease_owner: &str,
        now: i64,
    ) -> StateResult<bool> {
        let message = truncate_error(error.into());
        let owner = required_text(lease_owner, "leaseOwner")?;
        let changed = self.connection.execute(
            "UPDATE prompt_queue
             SET status = 'failed', updated_at = ?1, completed_at = ?1, last_error = ?2,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ?3 AND status IN ('queued', 'running')
               AND EXISTS (
                 SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?4 AND lease_expires_at > ?1
               )",
            params![now, message, id, owner],
        )?;
        Ok(changed == 1)
    }

    pub fn cancel(&self, input: CancelPromptInput, now: i64) -> StateResult<CancelPromptResult> {
        let client_message_id = required_text(&input.client_message_id, "clientMessageId")?;
        let lane = normalize_lane(&input.lane)?;
        let transaction = write_transaction(self.connection)?;
        let existing = transaction
            .query_row(
                "SELECT *, 0 AS position FROM prompt_queue
                 WHERE client_message_id = ?1 LIMIT 1",
                params![client_message_id],
                PromptQueueRow::from_row,
            )
            .optional()?
            .map(PromptQueueRow::into_entry)
            .transpose()?;
        if let Some(entry) = existing.as_ref() {
            if !same_prompt_scope(entry, input.user_id, &lane) {
                return Err(StateError::InvalidInput(
                    "clientMessageId is already associated with a different prompt scope"
                        .to_string(),
                ));
            }
            if entry.status != PromptQueueStatus::Queued
                && !(entry.status == PromptQueueStatus::Failed && entry.attempts == 0)
            {
                return Ok(CancelPromptResult {
                    cancelled: false,
                    reason: PromptQueueCancelReason::NotQueued,
                    entry: existing,
                });
            }
        }
        if is_cancelled_on(&transaction, &client_message_id, input.user_id, &lane)? {
            return Ok(CancelPromptResult {
                cancelled: false,
                reason: PromptQueueCancelReason::AlreadyCancelled,
                entry: existing,
            });
        }
        transaction.execute(
            "INSERT INTO prompt_queue_cancellations (
               client_message_id, auth_user_id, user_id, session_id, chat_session_id,
               logical_history_key, lane_namespace, lane_generation, cancelled_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                client_message_id,
                lane.auth_user_id,
                input.user_id,
                lane.session_id,
                lane.chat_session_id,
                lane.logical_history_key,
                lane.lane_namespace,
                lane.lane_generation,
                now,
            ],
        )?;
        if existing.is_some() {
            transaction.execute(
                "DELETE FROM prompt_queue
                 WHERE client_message_id = ?1
                   AND (status = 'queued' OR (status = 'failed' AND attempts = 0))",
                params![client_message_id],
            )?;
        }
        transaction.commit()?;
        Ok(CancelPromptResult {
            cancelled: true,
            reason: PromptQueueCancelReason::Cancelled,
            entry: existing,
        })
    }

    pub fn reconcile(
        &self,
        input: ReconcilePromptIdentitiesInput,
    ) -> StateResult<Vec<PromptIdentityReconciliation>> {
        let lane = normalize_lane(&input.lane)?;
        let mut seen = HashSet::new();
        let mut results = Vec::new();
        for raw_id in input.client_message_ids {
            let client_message_id = raw_id.trim().to_string();
            if client_message_id.is_empty() || !seen.insert(client_message_id.clone()) {
                continue;
            }

            let cancellation: Option<(String, i64, String, String, String, String, i64)> = self
                .connection
                .query_row(
                    "SELECT auth_user_id, user_id, session_id, chat_session_id,
                            logical_history_key, lane_namespace, lane_generation
                     FROM prompt_queue_cancellations
                     WHERE client_message_id = ?1 LIMIT 1",
                    params![client_message_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((
                auth_user_id,
                user_id,
                session_id,
                chat_session_id,
                logical,
                namespace,
                generation,
            )) = cancellation
            {
                let cancelled_lane = PromptQueueLane {
                    auth_user_id,
                    session_id,
                    chat_session_id,
                    history_key: lane.history_key.clone(),
                    logical_history_key: logical,
                    lane_namespace: namespace,
                    lane_generation: generation,
                };
                if same_prompt_scope_values(user_id, input.user_id, &cancelled_lane, &lane) {
                    results.push(PromptIdentityReconciliation {
                        client_message_id,
                        disposition: if generation == lane.lane_generation {
                            PromptIdentityDisposition::Cancelled
                        } else {
                            PromptIdentityDisposition::Obsolete
                        },
                        retryable: None,
                    });
                    continue;
                }
            }

            let entry = self.get_by_client_message_id(&client_message_id)?;
            let Some(entry) = entry else {
                results.push(PromptIdentityReconciliation {
                    client_message_id,
                    disposition: PromptIdentityDisposition::Unknown,
                    retryable: None,
                });
                continue;
            };
            if !same_prompt_scope(&entry, input.user_id, &lane) {
                results.push(PromptIdentityReconciliation {
                    client_message_id,
                    disposition: PromptIdentityDisposition::Unknown,
                    retryable: None,
                });
                continue;
            }
            if entry.attempts > 0
                || entry.status == PromptQueueStatus::Running
                || entry.status == PromptQueueStatus::Completed
            {
                results.push(PromptIdentityReconciliation {
                    client_message_id,
                    disposition: PromptIdentityDisposition::Consumed,
                    retryable: (entry.status == PromptQueueStatus::Failed
                        && entry.lane_generation == lane.lane_generation)
                        .then_some(true),
                });
                continue;
            }
            results.push(PromptIdentityReconciliation {
                client_message_id,
                disposition: if entry.lane_generation != lane.lane_generation {
                    PromptIdentityDisposition::Obsolete
                } else {
                    PromptIdentityDisposition::Pending
                },
                retryable: None,
            });
        }
        Ok(results)
    }

    pub fn claim_ownership(
        &self,
        owner_id: &str,
        owner_pid: i64,
        now: i64,
        lease_ms: i64,
        is_owner_alive: impl Fn(i64) -> bool,
    ) -> StateResult<PromptQueueOwnershipClaim> {
        let normalized_owner = required_text(owner_id, "ownerId")?;
        if owner_pid <= 0 {
            return Err(StateError::InvalidInput(
                "ownerPid must be a positive integer".to_string(),
            ));
        }
        let transaction = write_transaction(self.connection)?;
        let existing: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT owner_id, owner_pid, lease_expires_at
                 FROM prompt_queue_ownership WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((existing_owner, existing_pid, lease_expires_at)) = existing else {
            transaction.execute(
                "INSERT INTO prompt_queue_ownership
                   (id, owner_id, owner_pid, lease_expires_at, updated_at)
                 VALUES (1, ?1, ?2, ?3, ?4)",
                params![normalized_owner, owner_pid, now + lease_ms, now],
            )?;
            transaction.commit()?;
            return Ok(PromptQueueOwnershipClaim {
                claimed: true,
                previous_owner_id: None,
            });
        };
        if existing_owner == normalized_owner {
            transaction.execute(
                "UPDATE prompt_queue_ownership
                 SET owner_id = ?1, owner_pid = ?2, lease_expires_at = ?3, updated_at = ?4
                 WHERE id = 1 AND owner_id = ?1",
                params![normalized_owner, owner_pid, now + lease_ms, now],
            )?;
            transaction.commit()?;
            return Ok(PromptQueueOwnershipClaim {
                claimed: true,
                previous_owner_id: None,
            });
        }
        if lease_expires_at > now && is_owner_alive(existing_pid) {
            return Ok(PromptQueueOwnershipClaim {
                claimed: false,
                previous_owner_id: Some(existing_owner),
            });
        }
        let changed = transaction.execute(
            "UPDATE prompt_queue_ownership
             SET owner_id = ?1, owner_pid = ?2, lease_expires_at = ?3, updated_at = ?4
             WHERE id = 1 AND owner_id = ?5",
            params![
                normalized_owner,
                owner_pid,
                now + lease_ms,
                now,
                existing_owner
            ],
        )?;
        transaction.commit()?;
        Ok(PromptQueueOwnershipClaim {
            claimed: changed == 1,
            previous_owner_id: (changed == 1).then_some(existing_owner),
        })
    }

    pub fn release_ownership(&self, owner_id: &str) -> StateResult<bool> {
        let owner = required_text(owner_id, "ownerId")?;
        Ok(self.connection.execute(
            "DELETE FROM prompt_queue_ownership WHERE id = 1 AND owner_id = ?1",
            params![owner],
        )? == 1)
    }

    pub fn is_ownership_current(&self, owner_id: &str, now: i64) -> StateResult<bool> {
        let owner = required_text(owner_id, "ownerId")?;
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?1 AND lease_expires_at > ?2 LIMIT 1",
                params![owner, now],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn complete_interrupted(
        &self,
        id: i64,
        owner_id: &str,
        previous_owner_id: Option<&str>,
        now: i64,
    ) -> StateResult<bool> {
        let owner = required_text(owner_id, "ownerId")?;
        let changed = self.connection.execute(
            "UPDATE prompt_queue
             SET status = 'completed', payload_json = '{}', updated_at = ?1, completed_at = ?1,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ?2 AND status = 'running'
               AND (lease_owner IS NULL OR lease_expires_at IS NULL
                    OR lease_expires_at <= ?1 OR lease_owner = ?3)
               AND EXISTS (
                 SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?4 AND lease_expires_at > ?1
               )",
            params![now, id, previous_owner_id, owner],
        )?;
        Ok(changed == 1)
    }

    pub fn fail_interrupted(
        &self,
        id: i64,
        owner_id: &str,
        previous_owner_id: Option<&str>,
        error: impl Into<String>,
        now: i64,
    ) -> StateResult<bool> {
        let message = truncate_error(error.into());
        let owner = required_text(owner_id, "ownerId")?;
        let changed = self.connection.execute(
            "UPDATE prompt_queue
             SET status = 'failed', updated_at = ?1, completed_at = ?1, last_error = ?2,
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ?3 AND status = 'running'
               AND (lease_owner IS NULL OR lease_expires_at IS NULL
                    OR lease_expires_at <= ?1 OR lease_owner = ?4)
               AND EXISTS (
                 SELECT 1 FROM prompt_queue_ownership
                 WHERE id = 1 AND owner_id = ?5 AND lease_expires_at > ?1
               )",
            params![now, message, id, previous_owner_id, owner],
        )?;
        Ok(changed == 1)
    }

    fn is_cancelled(
        &self,
        client_message_id: &str,
        user_id: i64,
        lane: &PromptQueueLane,
    ) -> StateResult<bool> {
        is_cancelled_on(self.connection, client_message_id, user_id, lane)
    }

    fn query_entries<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> StateResult<Vec<PromptQueueEntry>> {
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement
            .query_map(params, PromptQueueRow::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(PromptQueueRow::into_entry).collect()
    }
}

fn same_prompt_scope_values(
    entry_user_id: i64,
    input_user_id: i64,
    entry_lane: &PromptQueueLane,
    input_lane: &PromptQueueLane,
) -> bool {
    entry_user_id == input_user_id
        && entry_lane.auth_user_id == input_lane.auth_user_id
        && entry_lane.session_id == input_lane.session_id
        && entry_lane.chat_session_id == input_lane.chat_session_id
        && entry_lane.logical_history_key == input_lane.logical_history_key
        && entry_lane.lane_namespace == input_lane.lane_namespace
}

fn is_cancelled_on(
    connection: &Connection,
    client_message_id: &str,
    user_id: i64,
    lane: &PromptQueueLane,
) -> StateResult<bool> {
    let cancellation: Option<(String, i64, String, String, String, String, i64)> = connection
        .query_row(
            "SELECT auth_user_id, user_id, session_id, chat_session_id,
                    logical_history_key, lane_namespace, lane_generation
             FROM prompt_queue_cancellations
             WHERE client_message_id = ?1 LIMIT 1",
            params![client_message_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        auth_user_id,
        entry_user_id,
        session_id,
        chat_session_id,
        logical,
        namespace,
        generation,
    )) = cancellation
    else {
        return Ok(false);
    };
    let cancelled_lane = PromptQueueLane {
        auth_user_id,
        session_id,
        chat_session_id,
        history_key: lane.history_key.clone(),
        logical_history_key: logical,
        lane_namespace: namespace,
        lane_generation: generation,
    };
    if !same_prompt_scope_values(entry_user_id, user_id, &cancelled_lane, lane) {
        return Err(StateError::InvalidInput(
            "clientMessageId is already associated with a different prompt scope".to_string(),
        ));
    }
    Ok(true)
}

fn truncate_error(message: String) -> String {
    message.chars().take(2_000).collect()
}

fn write_transaction(connection: &Connection) -> StateResult<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        connection,
        TransactionBehavior::Immediate,
    )?)
}
