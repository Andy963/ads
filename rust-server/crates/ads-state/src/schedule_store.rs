use ads_contract::schedule::ScheduleSpec;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{StateError, StateResult};

const DEFAULT_LIST_LIMIT: i64 = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSchedule {
    pub id: String,
    pub instruction: String,
    pub spec: ScheduleSpec,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
    pub lease_owner: Option<String>,
    pub lease_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl ScheduleRunStatus {
    fn parse(value: &str) -> Self {
        match value.trim() {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredScheduleRun {
    pub id: i64,
    pub schedule_id: String,
    pub external_id: String,
    pub run_at: i64,
    pub status: ScheduleRunStatus,
    pub task_id: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct CreateSchedule {
    pub instruction: String,
    pub spec: Option<ScheduleSpec>,
    pub enabled: bool,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateSchedule {
    pub instruction: Option<String>,
    pub spec: Option<ScheduleSpec>,
    pub enabled: Option<bool>,
    pub next_run_at: Option<Option<i64>>,
    pub lease_owner: Option<Option<String>>,
    pub lease_until: Option<Option<i64>>,
}

#[derive(Debug, Clone)]
pub struct InsertScheduleRun {
    pub schedule_id: String,
    pub external_id: String,
    pub run_at: i64,
    pub task_id: Option<String>,
    pub status: ScheduleRunStatus,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateScheduleRun {
    pub status: Option<ScheduleRunStatus>,
    pub task_id: Option<Option<String>>,
    pub result: Option<Option<String>>,
    pub error: Option<Option<String>>,
    pub started_at: Option<Option<i64>>,
    pub completed_at: Option<Option<i64>>,
}

pub struct ScheduleStore<'a> {
    connection: &'a Connection,
    workspace_id: String,
}

impl<'a> ScheduleStore<'a> {
    pub fn new(connection: &'a Connection, workspace_id: &str) -> Self {
        Self {
            connection,
            workspace_id: workspace_id.trim().to_string(),
        }
    }

    pub fn create_schedule(&self, input: CreateSchedule, now: i64) -> StateResult<StoredSchedule> {
        let spec = input
            .spec
            .ok_or_else(|| StateError::InvalidInput("Schedule spec is required".to_string()))?;
        spec.validate().map_err(StateError::InvalidInput)?;
        let spec_json = serde_json::to_string(&spec).map_err(|error| {
            StateError::InvalidInput(format!("Failed to serialize schedule spec: {error}"))
        })?;
        let id = Uuid::new_v4().to_string();
        self.connection.execute(
            "INSERT INTO schedules (
               workspace_id, id, instruction, spec_json, enabled, next_run_at,
               lease_owner, lease_until, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
            params![
                self.workspace_id,
                id,
                input.instruction,
                spec_json,
                if input.enabled { 1 } else { 0 },
                input.next_run_at,
                now
            ],
        )?;
        self.get_schedule(&id)?.ok_or_else(|| {
            StateError::InvalidInput("Failed to read back created schedule".to_string())
        })
    }

    pub fn get_schedule(&self, id: &str) -> StateResult<Option<StoredSchedule>> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT * FROM schedules WHERE workspace_id = ?1 AND id = ?2 LIMIT 1",
                params![self.workspace_id, id],
                ScheduleRow::from_row,
            )
            .optional()?
            .map(ScheduleRow::parse)
            .transpose()
    }

    pub fn list_schedules(&self, limit: Option<i64>) -> StateResult<Vec<StoredSchedule>> {
        let limit = normalize_positive_limit(limit);
        let mut statement = self.connection.prepare(
            "SELECT * FROM schedules
             WHERE workspace_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![self.workspace_id, limit], ScheduleRow::from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(ScheduleRow::parse).collect()
    }

    pub fn update_schedule(
        &self,
        id: &str,
        updates: UpdateSchedule,
        now: i64,
    ) -> StateResult<StoredSchedule> {
        let id = id.trim();
        if id.is_empty() {
            return Err(StateError::InvalidInput(
                "Schedule id is required".to_string(),
            ));
        }
        let existing = self
            .get_schedule(id)?
            .ok_or_else(|| StateError::InvalidInput(format!("Schedule not found: {id}")))?;
        let instruction = updates.instruction.unwrap_or(existing.instruction);
        let spec = updates.spec.unwrap_or(existing.spec);
        spec.validate().map_err(StateError::InvalidInput)?;
        let spec_json = serde_json::to_string(&spec).map_err(|error| {
            StateError::InvalidInput(format!("Failed to serialize schedule spec: {error}"))
        })?;
        let enabled = updates.enabled.unwrap_or(existing.enabled);
        let next_run_at = updates.next_run_at.unwrap_or(existing.next_run_at);
        let lease_owner = updates
            .lease_owner
            .map(normalize_optional_string)
            .unwrap_or(existing.lease_owner);
        let lease_until = updates.lease_until.unwrap_or(existing.lease_until);

        self.connection.execute(
            "UPDATE schedules
             SET instruction = ?1, spec_json = ?2, enabled = ?3, next_run_at = ?4,
                 lease_owner = ?5, lease_until = ?6, updated_at = ?7
             WHERE id = ?8 AND workspace_id = ?9",
            params![
                instruction,
                spec_json,
                if enabled { 1 } else { 0 },
                next_run_at,
                lease_owner,
                lease_until,
                now,
                id,
                self.workspace_id
            ],
        )?;
        self.get_schedule(id)?.ok_or_else(|| {
            StateError::InvalidInput("Failed to read back updated schedule".to_string())
        })
    }

    pub fn list_due_schedule_ids(
        &self,
        now_ms: i64,
        limit: Option<i64>,
    ) -> StateResult<Vec<String>> {
        let limit = normalize_positive_limit(limit);
        let mut statement = self.connection.prepare(
            "SELECT id FROM schedules
             WHERE workspace_id = ?1 AND enabled = 1
               AND next_run_at IS NOT NULL
               AND next_run_at <= ?2
               AND (lease_until IS NULL OR lease_until <= ?2)
             ORDER BY next_run_at ASC, id ASC
             LIMIT ?3",
        )?;
        let rows = statement.query_map(params![self.workspace_id, now_ms, limit], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows
            .filter_map(Result::ok)
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect())
    }

    pub fn claim_schedule_lease(
        &self,
        schedule_id: &str,
        lease_owner: &str,
        lease_until: i64,
        now_ms: i64,
    ) -> StateResult<bool> {
        let schedule_id = schedule_id.trim();
        let lease_owner = lease_owner.trim();
        if schedule_id.is_empty() || lease_owner.is_empty() {
            return Ok(false);
        }
        let changed = self.connection.execute(
            "UPDATE schedules
             SET lease_owner = ?1, lease_until = ?2, updated_at = ?3
             WHERE id = ?4 AND workspace_id = ?5
               AND enabled = 1
               AND next_run_at IS NOT NULL
               AND next_run_at <= ?3
               AND (lease_until IS NULL OR lease_until <= ?3)",
            params![
                lease_owner,
                lease_until,
                now_ms,
                schedule_id,
                self.workspace_id
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn release_schedule_lease(
        &self,
        schedule_id: &str,
        lease_owner: Option<&str>,
        now: i64,
    ) -> StateResult<()> {
        let schedule_id = schedule_id.trim();
        if schedule_id.is_empty() {
            return Ok(());
        }
        let owner = lease_owner.and_then(normalize_optional_str);
        match owner {
            None => {
                self.connection.execute(
                    "UPDATE schedules
                     SET lease_owner = NULL, lease_until = NULL, updated_at = ?1
                     WHERE id = ?2 AND workspace_id = ?3",
                    params![now, schedule_id, self.workspace_id],
                )?;
            }
            Some(owner) => {
                self.connection.execute(
                    "UPDATE schedules
                     SET lease_owner = NULL, lease_until = NULL, updated_at = ?1
                     WHERE id = ?2 AND lease_owner = ?3 AND workspace_id = ?4",
                    params![now, schedule_id, owner, self.workspace_id],
                )?;
            }
        }
        Ok(())
    }

    pub fn insert_run(&self, input: InsertScheduleRun, now: i64) -> StateResult<Option<i64>> {
        let schedule_id = input.schedule_id.trim();
        let external_id = input.external_id.trim();
        if schedule_id.is_empty() || external_id.is_empty() {
            return Err(StateError::InvalidInput(
                "scheduleId and externalId are required".to_string(),
            ));
        }
        let task_id = normalize_optional_string(input.task_id);
        let changed = self.connection.execute(
            "INSERT INTO schedule_runs (
               workspace_id, schedule_id, external_id, run_at, status, task_id,
               result, error, created_at, started_at, completed_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, NULL, NULL, ?7)
             ON CONFLICT(workspace_id, external_id) DO NOTHING",
            params![
                self.workspace_id,
                schedule_id,
                external_id,
                input.run_at,
                input.status.as_str(),
                task_id,
                now
            ],
        )?;
        if changed == 1 {
            Ok(Some(self.connection.last_insert_rowid()))
        } else {
            Ok(None)
        }
    }

    pub fn get_run_by_external_id(
        &self,
        external_id: &str,
    ) -> StateResult<Option<StoredScheduleRun>> {
        let external_id = external_id.trim();
        if external_id.is_empty() {
            return Ok(None);
        }
        self.connection
            .query_row(
                "SELECT * FROM schedule_runs
                 WHERE workspace_id = ?1 AND external_id = ?2
                 LIMIT 1",
                params![self.workspace_id, external_id],
                ScheduleRunRow::from_row,
            )
            .optional()?
            .map(ScheduleRunRow::parse)
            .transpose()
    }

    pub fn update_run_by_external_id(
        &self,
        external_id: &str,
        updates: UpdateScheduleRun,
        now: i64,
    ) -> StateResult<StoredScheduleRun> {
        let external_id = external_id.trim();
        if external_id.is_empty() {
            return Err(StateError::InvalidInput(
                "externalId is required".to_string(),
            ));
        }
        let existing = self.get_run_by_external_id(external_id)?.ok_or_else(|| {
            StateError::InvalidInput(format!("Schedule run not found: {external_id}"))
        })?;
        let status = updates.status.unwrap_or(existing.status);
        let task_id = updates.task_id.unwrap_or(existing.task_id);
        let result = updates.result.unwrap_or(existing.result);
        let error = updates.error.unwrap_or(existing.error);
        let started_at = updates.started_at.unwrap_or(existing.started_at);
        let completed_at = updates.completed_at.unwrap_or(existing.completed_at);

        self.connection.execute(
            "UPDATE schedule_runs
             SET status = ?1, task_id = ?2, result = ?3, error = ?4,
                 started_at = ?5, completed_at = ?6, updated_at = ?7
             WHERE external_id = ?8 AND workspace_id = ?9",
            params![
                status.as_str(),
                task_id,
                result,
                error,
                started_at,
                completed_at,
                now,
                external_id,
                self.workspace_id
            ],
        )?;
        self.get_run_by_external_id(external_id)?.ok_or_else(|| {
            StateError::InvalidInput("Failed to read back updated schedule run".to_string())
        })
    }

    pub fn list_runs(
        &self,
        schedule_id: &str,
        limit: Option<i64>,
    ) -> StateResult<Vec<StoredScheduleRun>> {
        let schedule_id = schedule_id.trim();
        if schedule_id.is_empty() {
            return Ok(Vec::new());
        }
        let limit = normalize_positive_limit(limit);
        let mut statement = self.connection.prepare(
            "SELECT * FROM schedule_runs
             WHERE workspace_id = ?1 AND schedule_id = ?2
             ORDER BY run_at DESC, id DESC
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![self.workspace_id, schedule_id, limit],
                ScheduleRunRow::from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(ScheduleRunRow::parse).collect()
    }
}

struct ScheduleRow {
    id: String,
    instruction: String,
    spec_json: String,
    enabled: i64,
    next_run_at: Option<i64>,
    lease_owner: Option<String>,
    lease_until: Option<i64>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

impl ScheduleRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            instruction: row.get("instruction")?,
            spec_json: row.get("spec_json")?,
            enabled: row.get("enabled")?,
            next_run_at: row.get("next_run_at")?,
            lease_owner: row.get("lease_owner")?,
            lease_until: row.get("lease_until")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn parse(self) -> StateResult<StoredSchedule> {
        let id = self.id.trim().to_string();
        if id.is_empty() {
            return Err(StateError::InvalidInput(
                "Schedule row missing id".to_string(),
            ));
        }
        let spec = serde_json::from_str::<ScheduleSpec>(&self.spec_json).map_err(|error| {
            StateError::InvalidInput(format!("Invalid schedule spec_json (id={id}): {error}"))
        })?;
        spec.validate().map_err(|_| {
            StateError::InvalidInput(format!("Invalid schedule spec schema (id={id})"))
        })?;
        Ok(StoredSchedule {
            id,
            instruction: self.instruction,
            spec,
            enabled: self.enabled != 0,
            next_run_at: self.next_run_at,
            lease_owner: normalize_optional_string(self.lease_owner),
            lease_until: self.lease_until,
            created_at: self.created_at.unwrap_or(0),
            updated_at: self.updated_at.unwrap_or(0),
        })
    }
}

struct ScheduleRunRow {
    id: i64,
    schedule_id: String,
    external_id: String,
    run_at: Option<i64>,
    status: String,
    task_id: Option<String>,
    result: Option<String>,
    error: Option<String>,
    created_at: Option<i64>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    updated_at: Option<i64>,
}

impl ScheduleRunRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            schedule_id: row.get("schedule_id")?,
            external_id: row.get("external_id")?,
            run_at: row.get("run_at")?,
            status: row.get("status")?,
            task_id: row.get("task_id")?,
            result: row.get("result")?,
            error: row.get("error")?,
            created_at: row.get("created_at")?,
            started_at: row.get("started_at")?,
            completed_at: row.get("completed_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn parse(self) -> StateResult<StoredScheduleRun> {
        Ok(StoredScheduleRun {
            id: self.id,
            schedule_id: self.schedule_id.trim().to_string(),
            external_id: self.external_id.trim().to_string(),
            run_at: self.run_at.unwrap_or(0),
            status: ScheduleRunStatus::parse(&self.status),
            task_id: normalize_optional_string(self.task_id),
            result: self.result,
            error: self.error,
            created_at: self.created_at.unwrap_or(0),
            started_at: self.started_at,
            completed_at: self.completed_at,
            updated_at: self.updated_at.unwrap_or(0),
        })
    }
}

fn normalize_positive_limit(value: Option<i64>) -> i64 {
    value
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_LIST_LIMIT)
}

fn normalize_optional_str(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalize_optional_str(&value))
}
