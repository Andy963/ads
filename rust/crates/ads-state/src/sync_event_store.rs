use ads_contract::sync::{SyncEventReadResult, SyncEventRow};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};
use serde_json::{Map, Value};

use crate::{StateError, StateResult};

pub const DELTA_SNAPSHOT_EVENT_TYPE: &str = "delta_snapshot";
pub const EPHEMERAL_SYNC_EVENT_TYPES: [&str; 5] = [
    "command",
    "command_snapshot",
    "explored",
    "patch",
    "workspace",
];
pub const TRANSIENT_SYNC_EVENT_TYPES: [&str; 2] = ["delta", "agents"];

const DEFAULT_MAX_EVENTS_PER_LANE: i64 = 2_000;
const DEFAULT_MAX_EPHEMERAL_EVENTS_PER_LANE: i64 = 300;
const DEFAULT_READ_LIMIT: i64 = 500;
const MAX_READ_LIMIT: i64 = 1_000;

#[derive(Debug, Clone)]
pub struct SyncEventStore {
    max_events_per_lane: i64,
    max_ephemeral_events_per_lane: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AppendSyncEvent<'a> {
    pub namespace: &'a str,
    pub lane_key: &'a str,
    pub event_type: &'a str,
    pub event_id: Option<&'a str>,
    pub revision: Option<i64>,
    pub payload: &'a Value,
    pub ts: Option<i64>,
    pub run_id: Option<&'a str>,
}

impl Default for SyncEventStore {
    fn default() -> Self {
        Self::new(
            DEFAULT_MAX_EVENTS_PER_LANE,
            DEFAULT_MAX_EPHEMERAL_EVENTS_PER_LANE,
        )
    }
}

impl SyncEventStore {
    pub fn new(max_events_per_lane: i64, max_ephemeral_events_per_lane: i64) -> Self {
        Self {
            max_events_per_lane: max_events_per_lane.max(1),
            max_ephemeral_events_per_lane: max_ephemeral_events_per_lane.max(1),
        }
    }

    pub fn append(
        &self,
        connection: &mut Connection,
        args: AppendSyncEvent<'_>,
    ) -> StateResult<Option<i64>> {
        self.insert_event(connection, args, None)
    }

    pub fn append_coalesced(
        &self,
        connection: &mut Connection,
        args: AppendSyncEvent<'_>,
    ) -> StateResult<Option<i64>> {
        let event_id = args.event_id.unwrap_or("").trim();
        if event_id.is_empty() {
            return Ok(None);
        }
        self.insert_event(connection, args, Some(event_id))
    }

    fn insert_event(
        &self,
        connection: &mut Connection,
        args: AppendSyncEvent<'_>,
        coalesced_event_id: Option<&str>,
    ) -> StateResult<Option<i64>> {
        let namespace = args.namespace.trim();
        let lane_key = args.lane_key.trim();
        let event_type = args.event_type.trim();
        if namespace.is_empty() || lane_key.is_empty() || event_type.is_empty() {
            return Ok(None);
        }
        let event_id = args
            .event_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let revision = args.revision.unwrap_or(1).max(1);
        let ts = args
            .ts
            .unwrap_or_else(ads_contract::time::now_unix_millis)
            .max(1);
        let run_id = args.run_id.map(str::trim).filter(|value| !value.is_empty());
        let payload = serde_json::to_string(args.payload).map_err(|error| {
            StateError::InvalidInput(format!("Failed to serialize sync event payload: {error}"))
        })?;

        let transaction = connection.unchecked_transaction()?;
        if let Some(event_id) = coalesced_event_id {
            let current_revision: Option<i64> = transaction
                .query_row(
                    "SELECT revision FROM sync_events
                     WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3
                       AND event_id = ?4 ORDER BY seq DESC LIMIT 1",
                    params![namespace, lane_key, event_type, event_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current_revision.is_some_and(|current| current > revision) {
                transaction.commit()?;
                return Ok(None);
            }
            transaction.execute(
                "DELETE FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3 AND event_id = ?4",
                params![namespace, lane_key, event_type, event_id],
            )?;
        }
        transaction.execute(
            "INSERT INTO sync_events
               (namespace, lane_key, event_type, event_id, revision, payload, ts, run_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
            ],
        )?;
        let seq = transaction.last_insert_rowid();
        self.trim_lane(&transaction, namespace, lane_key)?;
        transaction.commit()?;
        Ok(Some(seq))
    }

    pub fn delete_coalesced(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
        event_type: &str,
        event_id: &str,
    ) -> StateResult<()> {
        let namespace = namespace.trim();
        let lane_key = lane_key.trim();
        let event_type = event_type.trim();
        let event_id = event_id.trim();
        if namespace.is_empty()
            || lane_key.is_empty()
            || event_type.is_empty()
            || event_id.is_empty()
        {
            return Ok(());
        }
        connection.execute(
            "DELETE FROM sync_events
             WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3 AND event_id = ?4",
            params![namespace, lane_key, event_type, event_id],
        )?;
        Ok(())
    }

    pub fn mark_coalesced_inactive(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
        event_type: &str,
        event_id: &str,
    ) -> StateResult<()> {
        let namespace = namespace.trim();
        let lane_key = lane_key.trim();
        let event_type = event_type.trim();
        let event_id = event_id.trim();
        if namespace.is_empty()
            || lane_key.is_empty()
            || event_type.is_empty()
            || event_id.is_empty()
        {
            return Ok(());
        }
        let payload: Option<String> = connection
            .query_row(
                "SELECT payload FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3 AND event_id = ?4
                 ORDER BY seq DESC LIMIT 1",
                params![namespace, lane_key, event_type, event_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(raw) = payload else {
            return Ok(());
        };
        let mut payload = safe_parse_payload(&raw);
        payload.insert("active".to_string(), Value::Bool(false));
        connection.execute(
            "UPDATE sync_events SET payload = ?1
             WHERE namespace = ?2 AND lane_key = ?3 AND event_type = ?4 AND event_id = ?5",
            params![
                Value::Object(payload).to_string(),
                namespace,
                lane_key,
                event_type,
                event_id
            ],
        )?;
        Ok(())
    }

    pub fn read_coalesced(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
        event_type: Option<&str>,
    ) -> StateResult<Vec<SyncEventRow>> {
        let namespace = namespace.trim();
        let lane_key = lane_key.trim();
        if namespace.is_empty() || lane_key.is_empty() {
            return Ok(Vec::new());
        }
        let event_type = event_type.map(str::trim).filter(|value| !value.is_empty());
        let mut events = if let Some(event_type) = event_type {
            let mut statement = connection.prepare(
                "SELECT seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
                 FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3
                 ORDER BY seq ASC",
            )?;
            let rows =
                statement.query_map(params![namespace, lane_key, event_type], map_sync_event)?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
                 FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2
                 ORDER BY seq ASC",
            )?;
            let rows = statement.query_map(params![namespace, lane_key], map_sync_event)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        events.sort_by_key(|event| event.seq);
        Ok(events)
    }

    pub fn delete_coalesced_by_type(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
        event_type: &str,
    ) -> StateResult<()> {
        let namespace = namespace.trim();
        let lane_key = lane_key.trim();
        let event_type = event_type.trim();
        if namespace.is_empty() || lane_key.is_empty() || event_type.is_empty() {
            return Ok(());
        }
        connection.execute(
            "DELETE FROM sync_events WHERE namespace = ?1 AND lane_key = ?2 AND event_type = ?3",
            params![namespace, lane_key, event_type],
        )?;
        Ok(())
    }

    pub fn clear_lanes(
        &self,
        connection: &mut Connection,
        namespace: &str,
        lane_keys: &[String],
    ) -> StateResult<()> {
        let namespace = namespace.trim();
        let lane_keys = normalize_lane_keys(lane_keys);
        if namespace.is_empty() || lane_keys.is_empty() {
            return Ok(());
        }
        let placeholders = placeholders(lane_keys.len(), 2);
        let transaction = connection.unchecked_transaction()?;
        let mut event_params = vec![SqlValue::Text(namespace.to_string())];
        event_params.extend(lane_keys.iter().cloned().map(SqlValue::Text));
        transaction.execute(
            &format!(
                "DELETE FROM sync_events WHERE namespace = ?1 AND lane_key IN ({placeholders})"
            ),
            params_from_iter(event_params),
        )?;
        let mut state_params = vec![SqlValue::Text(namespace.to_string())];
        state_params.extend(lane_keys.into_iter().map(SqlValue::Text));
        transaction.execute(
            &format!(
                "DELETE FROM sync_lane_state WHERE namespace = ?1 AND lane_key IN ({placeholders})"
            ),
            params_from_iter(state_params),
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn read_after(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
        after_seq: Option<i64>,
        limit: Option<i64>,
    ) -> StateResult<SyncEventReadResult> {
        self.read_after_lanes(
            connection,
            namespace,
            &[lane_key.to_string()],
            after_seq,
            limit,
        )
    }

    pub fn read_after_lanes(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_keys: &[String],
        after_seq: Option<i64>,
        limit: Option<i64>,
    ) -> StateResult<SyncEventReadResult> {
        let namespace = namespace.trim();
        let lane_keys = normalize_lane_keys(lane_keys);
        let after_seq = after_seq.unwrap_or(0).max(0);
        let limit = normalize_limit(limit);
        if namespace.is_empty() || lane_keys.is_empty() {
            return Ok(empty_read_result());
        }

        let latest_seq = self.get_latest_seq_for_lanes(connection, namespace, &lane_keys)?;
        let min_available_seq = self.get_min_seq_for_lanes(connection, namespace, &lane_keys)?;
        let truncated = lane_keys.iter().try_fold(false, |truncated, lane_key| {
            if truncated {
                Ok(true)
            } else {
                self.get_trimmed_through_seq(connection, namespace, lane_key)
                    .map(|seq| seq > after_seq)
            }
        })?;

        let placeholders = placeholders(lane_keys.len(), 2);
        let mut values = vec![SqlValue::Text(namespace.to_string())];
        values.extend(lane_keys.into_iter().map(SqlValue::Text));
        values.push(SqlValue::Integer(after_seq));
        values.push(SqlValue::Integer(limit + 1));
        let mut statement = connection.prepare(&format!(
            "SELECT seq, namespace, lane_key, event_type, event_id, revision, payload, ts, run_id
             FROM sync_events
             WHERE namespace = ?1 AND lane_key IN ({placeholders}) AND seq > ?
             ORDER BY seq ASC
             LIMIT ?"
        ))?;
        let rows = statement.query_map(params_from_iter(values), map_sync_event)?;
        let events = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = events.len() as i64 > limit;
        Ok(SyncEventReadResult {
            events: events.into_iter().take(limit as usize).collect(),
            latest_seq,
            min_available_seq,
            has_more,
            truncated,
        })
    }

    pub fn get_latest_seq(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
    ) -> StateResult<i64> {
        let namespace = namespace.trim();
        let lane_key = lane_key.trim();
        if namespace.is_empty() || lane_key.is_empty() {
            return Ok(0);
        }
        connection
            .query_row(
                "SELECT MAX(seq) FROM sync_events WHERE namespace = ?1 AND lane_key = ?2",
                params![namespace, lane_key],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map(|value| value.unwrap_or(0))
            .map_err(StateError::from)
    }

    pub fn get_latest_seq_for_lanes(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_keys: &[String],
    ) -> StateResult<i64> {
        let lane_keys = normalize_lane_keys(lane_keys);
        let mut latest = 0;
        for lane_key in lane_keys {
            latest = latest.max(self.get_latest_seq(connection, namespace, &lane_key)?);
        }
        Ok(latest)
    }

    fn get_min_seq(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
    ) -> StateResult<i64> {
        connection
            .query_row(
                "SELECT MIN(seq) FROM sync_events WHERE namespace = ?1 AND lane_key = ?2",
                params![namespace, lane_key],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map(|value| value.unwrap_or(0))
            .map_err(StateError::from)
    }

    fn get_min_seq_for_lanes(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_keys: &[String],
    ) -> StateResult<i64> {
        let mut minimum = 0;
        for lane_key in normalize_lane_keys(lane_keys) {
            let candidate = self.get_min_seq(connection, namespace, &lane_key)?;
            if candidate > 0 && (minimum == 0 || candidate < minimum) {
                minimum = candidate;
            }
        }
        Ok(minimum)
    }

    fn get_trimmed_through_seq(
        &self,
        connection: &Connection,
        namespace: &str,
        lane_key: &str,
    ) -> StateResult<i64> {
        connection
            .query_row(
                "SELECT trimmed_through_seq FROM sync_lane_state
                 WHERE namespace = ?1 AND lane_key = ?2",
                params![namespace, lane_key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0))
            .map_err(StateError::from)
    }

    fn trim_lane(
        &self,
        transaction: &Transaction<'_>,
        namespace: &str,
        lane_key: &str,
    ) -> StateResult<()> {
        self.trim_class(
            transaction,
            namespace,
            lane_key,
            EventClassPredicate::Ephemeral,
            self.max_ephemeral_events_per_lane,
        )?;
        self.trim_class(
            transaction,
            namespace,
            lane_key,
            EventClassPredicate::Durable,
            self.max_events_per_lane,
        )
    }

    fn trim_class(
        &self,
        transaction: &Transaction<'_>,
        namespace: &str,
        lane_key: &str,
        predicate: EventClassPredicate,
        keep: i64,
    ) -> StateResult<()> {
        let cutoff: Option<i64> = match predicate {
            EventClassPredicate::Ephemeral => transaction
                .query_row(
                    "SELECT seq FROM sync_events
                     WHERE namespace = ?1 AND lane_key = ?2 AND event_type IN (?3, ?4, ?5, ?6, ?7)
                     ORDER BY seq DESC LIMIT 1 OFFSET ?8",
                    params![
                        namespace,
                        lane_key,
                        EPHEMERAL_SYNC_EVENT_TYPES[0],
                        EPHEMERAL_SYNC_EVENT_TYPES[1],
                        EPHEMERAL_SYNC_EVENT_TYPES[2],
                        EPHEMERAL_SYNC_EVENT_TYPES[3],
                        EPHEMERAL_SYNC_EVENT_TYPES[4],
                        keep - 1
                    ],
                    |row| row.get(0),
                )
                .optional()?,
            EventClassPredicate::Durable => transaction
                .query_row(
                    "SELECT seq FROM sync_events
                     WHERE namespace = ?1 AND lane_key = ?2
                       AND event_type NOT IN (?3, ?4, ?5, ?6, ?7)
                     ORDER BY seq DESC LIMIT 1 OFFSET ?8",
                    params![
                        namespace,
                        lane_key,
                        EPHEMERAL_SYNC_EVENT_TYPES[0],
                        EPHEMERAL_SYNC_EVENT_TYPES[1],
                        EPHEMERAL_SYNC_EVENT_TYPES[2],
                        EPHEMERAL_SYNC_EVENT_TYPES[3],
                        EPHEMERAL_SYNC_EVENT_TYPES[4],
                        keep - 1
                    ],
                    |row| row.get(0),
                )
                .optional()?,
        };
        let Some(cutoff) = cutoff.filter(|value| *value > 0) else {
            return Ok(());
        };
        let trimmed_through: Option<i64> = match predicate {
            EventClassPredicate::Ephemeral => transaction
                .query_row(
                    "SELECT MAX(seq) FROM sync_events
                     WHERE namespace = ?1 AND lane_key = ?2
                       AND event_type IN (?3, ?4, ?5, ?6, ?7) AND seq < ?8",
                    params![
                        namespace,
                        lane_key,
                        EPHEMERAL_SYNC_EVENT_TYPES[0],
                        EPHEMERAL_SYNC_EVENT_TYPES[1],
                        EPHEMERAL_SYNC_EVENT_TYPES[2],
                        EPHEMERAL_SYNC_EVENT_TYPES[3],
                        EPHEMERAL_SYNC_EVENT_TYPES[4],
                        cutoff
                    ],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten(),
            EventClassPredicate::Durable => transaction
                .query_row(
                    "SELECT MAX(seq) FROM sync_events
                     WHERE namespace = ?1 AND lane_key = ?2
                       AND event_type NOT IN (?3, ?4, ?5, ?6, ?7) AND seq < ?8",
                    params![
                        namespace,
                        lane_key,
                        EPHEMERAL_SYNC_EVENT_TYPES[0],
                        EPHEMERAL_SYNC_EVENT_TYPES[1],
                        EPHEMERAL_SYNC_EVENT_TYPES[2],
                        EPHEMERAL_SYNC_EVENT_TYPES[3],
                        EPHEMERAL_SYNC_EVENT_TYPES[4],
                        cutoff
                    ],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten(),
        };
        let Some(trimmed_through) = trimmed_through.filter(|value| *value > 0) else {
            return Ok(());
        };
        match predicate {
            EventClassPredicate::Ephemeral => transaction.execute(
                "DELETE FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2
                   AND event_type IN (?3, ?4, ?5, ?6, ?7) AND seq < ?8",
                params![
                    namespace,
                    lane_key,
                    EPHEMERAL_SYNC_EVENT_TYPES[0],
                    EPHEMERAL_SYNC_EVENT_TYPES[1],
                    EPHEMERAL_SYNC_EVENT_TYPES[2],
                    EPHEMERAL_SYNC_EVENT_TYPES[3],
                    EPHEMERAL_SYNC_EVENT_TYPES[4],
                    cutoff
                ],
            )?,
            EventClassPredicate::Durable => transaction.execute(
                "DELETE FROM sync_events
                 WHERE namespace = ?1 AND lane_key = ?2
                   AND event_type NOT IN (?3, ?4, ?5, ?6, ?7) AND seq < ?8",
                params![
                    namespace,
                    lane_key,
                    EPHEMERAL_SYNC_EVENT_TYPES[0],
                    EPHEMERAL_SYNC_EVENT_TYPES[1],
                    EPHEMERAL_SYNC_EVENT_TYPES[2],
                    EPHEMERAL_SYNC_EVENT_TYPES[3],
                    EPHEMERAL_SYNC_EVENT_TYPES[4],
                    cutoff
                ],
            )?,
        };
        transaction.execute(
            "INSERT INTO sync_lane_state (namespace, lane_key, trimmed_through_seq)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(namespace, lane_key) DO UPDATE SET
               trimmed_through_seq = MAX(sync_lane_state.trimmed_through_seq, excluded.trimmed_through_seq)",
            params![namespace, lane_key, trimmed_through],
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum EventClassPredicate {
    Ephemeral,
    Durable,
}

fn map_sync_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncEventRow> {
    let payload: String = row.get(6)?;
    Ok(SyncEventRow {
        seq: row.get(0)?,
        namespace: row.get(1)?,
        lane_key: row.get(2)?,
        event_type: row.get(3)?,
        event_id: row.get(4)?,
        revision: row.get::<_, Option<i64>>(5)?.unwrap_or(1).max(1),
        payload: Value::Object(safe_parse_payload(&payload)),
        ts: row.get(7)?,
        run_id: row.get(8)?,
    })
}

fn safe_parse_payload(raw: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn normalize_lane_keys(lane_keys: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for lane_key in lane_keys {
        let lane_key = lane_key.trim();
        if !lane_key.is_empty() && !normalized.iter().any(|value| value == lane_key) {
            normalized.push(lane_key.to_string());
        }
    }
    normalized
}

fn normalize_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_READ_LIMIT).clamp(1, MAX_READ_LIMIT)
}

fn placeholders(count: usize, offset: usize) -> String {
    (0..count)
        .map(|index| format!("?{}", offset + index))
        .collect::<Vec<_>>()
        .join(", ")
}

fn empty_read_result() -> SyncEventReadResult {
    SyncEventReadResult {
        events: Vec::new(),
        latest_seq: 0,
        min_available_seq: 0,
        has_more: false,
        truncated: false,
    }
}
