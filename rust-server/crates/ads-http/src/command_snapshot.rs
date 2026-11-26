//! Coalesces command metadata into one durable runtime row per lane, mirroring
//! `server/web/server/sync/commandSnapshot.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use ads_state::{AppendSyncEvent, StateDb, SyncEventStore};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub const COMMAND_SNAPSHOT_EVENT_TYPE: &str = "command_snapshot";
pub const COMMAND_SNAPSHOT_MAX_CHARS: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSnapshotPosition {
    pub event_id: String,
    pub identity: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub revision: i64,
    pub terminal: bool,
}

#[derive(Debug, Clone)]
struct ActiveCommand {
    event_id: String,
    identity: String,
    id: String,
    command: String,
    output: String,
    start_offset: i64,
    end_offset: i64,
    revision: i64,
    started_at: i64,
    last_updated_at: i64,
    status: Option<String>,
    exit_code: Option<i64>,
    terminal: bool,
    snapshot_seq: Option<i64>,
}

#[derive(Debug, Clone)]
struct LegacyTrack {
    identity: String,
    terminal: bool,
    saw_output: bool,
    end_offset: i64,
    last_output: String,
}

#[derive(Debug, Default)]
struct SnapshotState {
    active: HashMap<String, ActiveCommand>,
    legacy_tracks: HashMap<String, LegacyTrack>,
    explicit_identities: HashMap<String, String>,
    retired_identities: HashSet<String>,
    anonymous_counter: u64,
    hydrated: bool,
}

#[derive(Debug)]
pub struct CommandSnapshotCoalescer {
    namespace: String,
    lane_key: String,
    state: Mutex<SnapshotState>,
}

impl CommandSnapshotCoalescer {
    pub fn new(namespace: &str, lane_key: &str) -> Self {
        Self {
            namespace: namespace.to_string(),
            lane_key: lane_key.to_string(),
            state: Mutex::new(SnapshotState::default()),
        }
    }

    /// Restore the newest live command left behind by a previous process.
    pub fn ensure_hydrated(&self, db: &StateDb) {
        let mut state = self.state.lock().expect("command snapshot lock");
        if state.hydrated {
            return;
        }
        let Ok(connection) = db.connect() else {
            return;
        };
        let Ok(rows) = SyncEventStore::default().read_coalesced(
            &connection,
            &self.namespace,
            &self.lane_key,
            Some(COMMAND_SNAPSHOT_EVENT_TYPE),
        ) else {
            return;
        };
        state.hydrated = true;
        if rows.is_empty() {
            return;
        }

        let live_rows: Vec<_> = rows
            .iter()
            .filter(|row| {
                row.payload.get("active") != Some(&Value::Bool(false))
                    && command_from_payload(&row.payload).is_some()
            })
            .collect();
        let Some(latest) = live_rows.last() else {
            return;
        };
        let latest_seq = latest.seq;
        for row in &live_rows {
            if row.seq == latest_seq {
                continue;
            }
            if let Some(event_id) = row
                .event_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                delete_row(db, &self.namespace, &self.lane_key, event_id);
            }
        }

        let row = *latest;
        let Some(command) = command_from_payload(&row.payload) else {
            return;
        };
        let identity = command
            .get("identity")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let identity = if identity.is_empty() {
            command
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string()
        } else {
            identity.to_string()
        };
        let command_line = command
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let status = command
            .get("status")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let terminal = status.as_deref().is_some_and(is_terminal_status);
        let event_id = row
            .event_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if terminal {
            if let Some(event_id) = event_id.as_deref() {
                delete_row(db, &self.namespace, &self.lane_key, event_id);
            }
            return;
        }
        if identity.is_empty() || command_line.is_empty() {
            return;
        }

        let mut output = command
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        truncate_front(&mut output, COMMAND_SNAPSHOT_MAX_CHARS);
        let output_len = output.chars().count() as i64;
        let end_offset = read_offset(command.get("endOffset")).unwrap_or(output_len);
        let start_offset =
            read_offset(command.get("startOffset")).unwrap_or((end_offset - output_len).max(0));
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let event_id = event_id.unwrap_or_else(|| command_event_id(&identity));
        let revision = command
            .get("revision")
            .and_then(Value::as_i64)
            .filter(|value| *value != 0)
            .unwrap_or(row.revision)
            .max(1);
        let last_updated_at = if row.ts > 0 { row.ts } else { now_millis() };
        let started_at = normalize_timestamp(command.get("ts"), last_updated_at);
        let legacy_key = format!("{id}\u{0}{command_line}");
        let entry = ActiveCommand {
            event_id,
            identity: identity.clone(),
            id: id.clone(),
            command: command_line.clone(),
            output: output.clone(),
            start_offset,
            end_offset,
            revision,
            started_at,
            last_updated_at,
            status,
            exit_code: command.get("exit_code").and_then(Value::as_i64),
            terminal,
            snapshot_seq: (row.seq > 0).then_some(row.seq),
        };
        state.active.insert(identity.clone(), entry);
        state.legacy_tracks.insert(
            legacy_key.clone(),
            LegacyTrack {
                identity: identity.clone(),
                terminal,
                saw_output: !output.is_empty(),
                end_offset,
                last_output: output,
            },
        );
        if !id.is_empty() {
            state.explicit_identities.insert(legacy_key, identity);
        }
    }

    pub fn record(
        &self,
        db: &StateDb,
        ts: i64,
        command: &Value,
    ) -> Option<CommandSnapshotPosition> {
        self.ensure_hydrated(db);
        let payload = command.as_object()?;
        let command_line = payload
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if command_line.is_empty() {
            return None;
        }
        let output_delta = payload
            .get("outputDelta")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let explicit_start = read_offset(payload.get("outputStartOffset"));
        let explicit_end = read_offset(payload.get("outputEndOffset"));
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let terminal = status.as_deref().is_some_and(is_terminal_status);
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let exit_code = payload.get("exit_code").and_then(Value::as_i64);
        let timestamp = if ts > 0 { ts } else { now_millis() };

        let mut state = self.state.lock().expect("command snapshot lock");
        let explicit_identity = resolve_explicit_identity(&mut state, payload, &command_line);
        let identity = explicit_identity.unwrap_or_else(|| {
            resolve_legacy_identity(
                &mut state,
                &command_line,
                &output_delta,
                explicit_start,
                explicit_end,
                terminal,
            )
        });
        if state.retired_identities.contains(&identity) {
            return None;
        }
        let legacy_key = format!("{id}\u{0}{command_line}");

        let current_identity = state
            .active
            .values()
            .next()
            .map(|entry| entry.identity.clone());
        if let Some(current_identity) = current_identity {
            if current_identity != identity {
                let current_updated = state
                    .active
                    .get(&current_identity)
                    .map(|entry| entry.last_updated_at)
                    .unwrap_or(0);
                if timestamp < current_updated {
                    return None;
                }
                let retired: Vec<(String, String)> = state
                    .active
                    .values()
                    .map(|old| (old.identity.clone(), old.event_id.clone()))
                    .collect();
                for (old_identity, event_id) in retired {
                    state.retired_identities.insert(old_identity);
                    delete_row(db, &self.namespace, &self.lane_key, &event_id);
                }
                state.active.clear();
            }
        }

        if let Some(existing) = state.active.get(&identity) {
            if timestamp < existing.last_updated_at {
                return None;
            }
        }
        let previous = state.active.get(&identity).cloned();
        let existing = previous.is_some();
        let mut entry = previous.unwrap_or_else(|| ActiveCommand {
            event_id: command_event_id(&identity),
            identity: identity.clone(),
            id: id.clone(),
            command: command_line.clone(),
            output: String::new(),
            start_offset: explicit_start.unwrap_or(0),
            end_offset: explicit_start.unwrap_or(0),
            revision: 0,
            started_at: timestamp,
            last_updated_at: timestamp,
            status: None,
            exit_code: None,
            terminal: false,
            snapshot_seq: None,
        });

        let mut changed = !existing;
        let previous_end = entry.end_offset;
        let mut appendable = output_delta.clone();
        if let Some(start) = explicit_start {
            let overlap = (previous_end - start).max(0) as usize;
            if explicit_end.is_some_and(|end| end <= previous_end) {
                appendable.clear();
            } else if overlap > 0 {
                appendable = output_delta
                    .chars()
                    .skip(overlap.min(output_delta.chars().count()))
                    .collect();
            }
        } else if !appendable.is_empty() {
            if entry.output == appendable || entry.output.ends_with(&appendable) {
                appendable.clear();
            } else if appendable.starts_with(&entry.output) && !entry.output.is_empty() {
                let skip = entry.output.chars().count();
                appendable = appendable.chars().skip(skip).collect();
            }
        }

        if !appendable.is_empty() {
            let append_start = explicit_start.unwrap_or(entry.end_offset);
            if entry.output.is_empty() {
                entry.start_offset = append_start.max(0);
            }
            entry.output.push_str(&appendable);
            truncate_front(&mut entry.output, COMMAND_SNAPSHOT_MAX_CHARS);
            entry.end_offset =
                explicit_end.unwrap_or(append_start + appendable.chars().count() as i64);
            entry.start_offset = (entry.end_offset - entry.output.chars().count() as i64).max(0);
            changed = true;
        } else if let Some(end) = explicit_end {
            if end > entry.end_offset {
                entry.end_offset = end;
                entry.start_offset =
                    (entry.end_offset - entry.output.chars().count() as i64).max(0);
                changed = true;
            }
        }

        if let Some(next_status) = status.clone() {
            if Some(next_status.as_str()) != entry.status.as_deref() {
                entry.status = Some(next_status);
                changed = true;
            }
        }
        if let Some(exit_code) = exit_code {
            if Some(exit_code) != entry.exit_code {
                entry.exit_code = Some(exit_code);
                changed = true;
            }
        }
        if terminal && !entry.terminal {
            entry.terminal = true;
            changed = true;
        }

        if !changed && existing {
            entry.last_updated_at = entry.last_updated_at.max(timestamp);
            update_legacy_track(
                &mut state,
                &legacy_key,
                &entry.identity,
                entry.terminal,
                entry.end_offset,
                &output_delta,
            );
            state.active.insert(identity.clone(), entry.clone());
            return Some(CommandSnapshotPosition {
                event_id: entry.event_id,
                identity: entry.identity,
                start_offset: explicit_start.unwrap_or(entry.end_offset),
                end_offset: explicit_end.unwrap_or(entry.end_offset),
                revision: entry.revision,
                terminal,
            });
        }

        entry.revision = (entry.revision + 1).max(1);
        entry.last_updated_at = entry.last_updated_at.max(timestamp);
        state.active.insert(identity.clone(), entry.clone());
        update_legacy_track(
            &mut state,
            &legacy_key,
            &entry.identity,
            entry.terminal,
            entry.end_offset,
            &output_delta,
        );
        if !id.is_empty() {
            state
                .explicit_identities
                .insert(format!("{id}\u{0}{command_line}"), identity.clone());
        }

        let mut command_payload = Map::new();
        command_payload.insert("id".to_string(), json!(entry.id));
        command_payload.insert("identity".to_string(), json!(entry.identity));
        command_payload.insert("command".to_string(), json!(entry.command));
        if let Some(status) = entry.status.as_deref() {
            command_payload.insert("status".to_string(), json!(status));
        }
        if let Some(exit_code) = entry.exit_code {
            command_payload.insert("exit_code".to_string(), json!(exit_code));
        }
        command_payload.insert("startOffset".to_string(), json!(entry.start_offset));
        command_payload.insert("endOffset".to_string(), json!(entry.end_offset));
        command_payload.insert("revision".to_string(), json!(entry.revision));

        let payload = json!({
            "type": COMMAND_SNAPSHOT_EVENT_TYPE,
            "active": true,
            "ts": entry.started_at,
            "eventId": entry.event_id,
            "snapshotSeq": entry.snapshot_seq,
            "command": Value::Object(command_payload),
        });
        let seq = append_row(
            db,
            &self.namespace,
            &self.lane_key,
            &entry.event_id,
            entry.revision,
            &payload,
            timestamp,
        );
        if let Some(seq) = seq {
            entry.snapshot_seq = Some(seq);
            state.active.insert(identity.clone(), entry.clone());
        }

        Some(CommandSnapshotPosition {
            event_id: entry.event_id,
            identity: entry.identity,
            start_offset: explicit_start.unwrap_or(previous_end),
            end_offset: explicit_end.unwrap_or(entry.end_offset),
            revision: entry.revision,
            terminal,
        })
    }

    pub fn finish(&self, db: &StateDb) {
        let mut state = self.state.lock().expect("command snapshot lock");
        if let Ok(connection) = db.connect() {
            if let Err(error) = SyncEventStore::default().delete_coalesced_by_type(
                &connection,
                &self.namespace,
                &self.lane_key,
                COMMAND_SNAPSHOT_EVENT_TYPE,
            ) {
                eprintln!("[ads-ws] failed to retire command snapshots: {error}");
            }
        }
        state.active.clear();
        state.legacy_tracks.clear();
        state.explicit_identities.clear();
        state.retired_identities.clear();
        state.hydrated = true;
    }

    pub fn snapshot(&self, db: &StateDb) -> Option<Value> {
        self.ensure_hydrated(db);
        let state = self.state.lock().expect("command snapshot lock");
        let entry = state.active.values().next()?;
        let mut command_payload = Map::new();
        command_payload.insert("id".to_string(), json!(entry.id));
        command_payload.insert("identity".to_string(), json!(entry.identity));
        command_payload.insert("command".to_string(), json!(entry.command));
        if let Some(status) = entry.status.as_deref() {
            command_payload.insert("status".to_string(), json!(status));
        }
        if let Some(exit_code) = entry.exit_code {
            command_payload.insert("exit_code".to_string(), json!(exit_code));
        }
        command_payload.insert("startOffset".to_string(), json!(entry.start_offset));
        command_payload.insert("endOffset".to_string(), json!(entry.end_offset));
        command_payload.insert("revision".to_string(), json!(entry.revision));
        Some(json!({
            "type": COMMAND_SNAPSHOT_EVENT_TYPE,
            "eventId": entry.event_id,
            "snapshotSeq": entry.snapshot_seq,
            "revision": entry.revision,
            "active": true,
            "afterSeq": entry.snapshot_seq.unwrap_or(0),
            "ts": entry.started_at,
            "command": Value::Object(command_payload),
        }))
    }
}

fn resolve_explicit_identity(
    state: &mut SnapshotState,
    payload: &Map<String, Value>,
    command_line: &str,
) -> Option<String> {
    let explicit = payload
        .get("identity")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !explicit.is_empty() {
        return Some(explicit.to_string());
    }
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if id.is_empty() {
        return None;
    }
    let key = format!("{id}\u{0}{command_line}");
    if let Some(known) = state.explicit_identities.get(&key) {
        return Some(known.clone());
    }
    let prefix = format!("{id}\u{0}");
    let same_id = state
        .explicit_identities
        .keys()
        .any(|entry| entry.starts_with(&prefix));
    let identity = if same_id {
        format!("{id}:{}", identity_suffix(command_line))
    } else {
        id.to_string()
    };
    state.explicit_identities.insert(key, identity.clone());
    Some(identity)
}

fn resolve_legacy_identity(
    state: &mut SnapshotState,
    command_line: &str,
    output_delta: &str,
    start_offset: Option<i64>,
    end_offset: Option<i64>,
    terminal: bool,
) -> String {
    let legacy_key = format!("\u{0}{command_line}");
    let previous = state.legacy_tracks.get(&legacy_key).cloned();
    let header = has_command_header(output_delta, command_line);
    let offset_rollback = previous
        .as_ref()
        .is_some_and(|track| start_offset.is_some_and(|start| start < track.end_offset));
    let duplicate_terminal = previous.as_ref().is_some_and(|track| {
        track.terminal
            && terminal
            && (output_delta.is_empty()
                || output_delta == track.last_output
                || end_offset.is_some_and(|end| end <= track.end_offset))
    });
    let starts_new = previous.is_none()
        || (!duplicate_terminal
            && (previous.as_ref().is_some_and(|track| track.terminal)
                || offset_rollback
                || (header
                    && previous
                        .as_ref()
                        .is_some_and(|track| track.saw_output || track.terminal))));
    if !starts_new {
        if let Some(previous) = previous {
            return previous.identity;
        }
    }
    state.anonymous_counter += 1;
    let identity = format!("anonymous-command-{}", state.anonymous_counter);
    state.legacy_tracks.insert(
        legacy_key,
        LegacyTrack {
            identity: identity.clone(),
            terminal: false,
            saw_output: false,
            end_offset: 0,
            last_output: String::new(),
        },
    );
    identity
}

fn update_legacy_track(
    state: &mut SnapshotState,
    legacy_key: &str,
    identity: &str,
    terminal: bool,
    end_offset: i64,
    output_delta: &str,
) {
    let last_output = if output_delta.is_empty() {
        state
            .legacy_tracks
            .get(legacy_key)
            .map(|track| track.last_output.clone())
            .unwrap_or_default()
    } else {
        output_delta.to_string()
    };
    state.legacy_tracks.insert(
        legacy_key.to_string(),
        LegacyTrack {
            identity: identity.to_string(),
            terminal,
            saw_output: !output_delta.is_empty(),
            end_offset,
            last_output,
        },
    );
}

fn append_row(
    db: &StateDb,
    namespace: &str,
    lane_key: &str,
    event_id: &str,
    revision: i64,
    payload: &Value,
    ts: i64,
) -> Option<i64> {
    let Ok(mut connection) = db.connect() else {
        return None;
    };
    match SyncEventStore::default().append_coalesced(
        &mut connection,
        AppendSyncEvent {
            namespace,
            lane_key,
            event_type: COMMAND_SNAPSHOT_EVENT_TYPE,
            event_id: Some(event_id),
            revision: Some(revision),
            payload,
            ts: Some(ts),
            run_id: None,
        },
    ) {
        Ok(seq) => seq,
        Err(error) => {
            eprintln!("[ads-ws] failed to persist command snapshot: {error}");
            None
        }
    }
}

fn delete_row(db: &StateDb, namespace: &str, lane_key: &str, event_id: &str) {
    let Ok(connection) = db.connect() else {
        return;
    };
    if let Err(error) = SyncEventStore::default().delete_coalesced(
        &connection,
        namespace,
        lane_key,
        COMMAND_SNAPSHOT_EVENT_TYPE,
        event_id,
    ) {
        eprintln!("[ads-ws] failed to retire command snapshot: {error}");
    }
}

fn command_from_payload(payload: &Value) -> Option<&Map<String, Value>> {
    payload.get("command")?.as_object()
}

fn normalize_timestamp(value: Option<&Value>, fallback: i64) -> i64 {
    let parsed = match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.floor() as i64)),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| value.floor() as i64),
        _ => None,
    };
    parsed.filter(|value| *value > 0).unwrap_or(fallback)
}

fn has_command_header(output_delta: &str, command_line: &str) -> bool {
    let normalized = output_delta.trim_start();
    normalized.starts_with(&format!("$ {command_line}\n"))
        || normalized.starts_with(&format!("$ {command_line}\r\n"))
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "failed" | "declined" | "cancelled"
    )
}

fn command_event_id(identity: &str) -> String {
    format!("active-command:{}", hash_prefix(identity, 24))
}

fn identity_suffix(command_line: &str) -> String {
    hash_prefix(command_line, 12)
}

fn hash_prefix(value: &str, length: usize) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = hex::encode(digest);
    hex.chars().take(length).collect()
}

fn read_offset(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return (number >= 0).then_some(number);
    }
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number >= 0.0)
        .map(|number| number.floor() as i64)
}

fn truncate_front(value: &mut String, max_chars: usize) {
    let count = value.chars().count();
    if count <= max_chars {
        return;
    }
    let skip = count - max_chars;
    let boundary = value
        .char_indices()
        .nth(skip)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    value.replace_range(..boundary, "");
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (StateDb, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        (db, directory)
    }

    fn rows(db: &StateDb) -> Vec<Value> {
        let connection = db.connect().expect("connection");
        SyncEventStore::default()
            .read_coalesced(
                &connection,
                "web-actions",
                "lane",
                Some(COMMAND_SNAPSHOT_EVENT_TYPE),
            )
            .expect("rows")
            .into_iter()
            .map(|row| row.payload)
            .collect()
    }

    #[test]
    fn accumulates_output_and_offsets() {
        let (db, _dir) = test_db();
        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        let first = coalescer
            .record(
                &db,
                1_000,
                &json!({"id": "tool-1", "command": "ls", "status": "in_progress", "outputDelta": "a\n"}),
            )
            .expect("first");
        assert_eq!(first.identity, "tool-1");
        assert_eq!(first.start_offset, 0);
        assert_eq!(first.end_offset, 2);
        let second = coalescer
            .record(
                &db,
                1_001,
                &json!({"id": "tool-1", "command": "ls", "status": "completed", "outputDelta": "b\n", "exit_code": 0}),
            )
            .expect("second");
        assert_eq!(second.identity, "tool-1");
        assert_eq!(second.start_offset, 2);
        assert_eq!(second.end_offset, 4);
        let snapshot = coalescer.snapshot(&db).expect("snapshot");
        assert_eq!(snapshot["command"]["status"], "completed");
        assert_eq!(snapshot["command"]["endOffset"], 4);
        assert_eq!(rows(&db).len(), 1);
    }

    #[test]
    fn reuses_identity_and_skips_duplicate_deltas() {
        let (db, _dir) = test_db();
        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        coalescer.record(
            &db,
            1_000,
            &json!({"id": "tool-1", "command": "ls", "outputDelta": "a\n"}),
        );
        let repeat = coalescer
            .record(
                &db,
                1_001,
                &json!({"id": "tool-1", "command": "ls", "outputDelta": "a\n"}),
            )
            .expect("repeat");
        assert_eq!(repeat.end_offset, 2);
        let snapshot = coalescer.snapshot(&db).expect("snapshot");
        assert_eq!(snapshot["command"]["endOffset"], 2);
    }

    #[test]
    fn reused_id_with_another_command_gets_a_suffix() {
        let (db, _dir) = test_db();
        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        let first = coalescer
            .record(&db, 1_000, &json!({"id": "tool-1", "command": "ls"}))
            .expect("first");
        assert_eq!(first.identity, "tool-1");
        let second = coalescer
            .record(&db, 2_000, &json!({"id": "tool-1", "command": "pwd"}))
            .expect("second");
        assert!(second.identity.starts_with("tool-1:"));
        coalescer.finish(&db);
        assert!(rows(&db).is_empty());
        assert!(coalescer.snapshot(&db).is_none());
    }

    #[test]
    fn terminal_command_is_snapshotted_then_retired() {
        let (db, _dir) = test_db();
        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        coalescer.record(
            &db,
            1_000,
            &json!({"id": "tool-1", "command": "ls", "status": "in_progress"}),
        );
        let terminal = coalescer
            .record(
                &db,
                1_001,
                &json!({"id": "tool-1", "command": "ls", "status": "completed", "exit_code": 0}),
            )
            .expect("terminal");
        assert!(terminal.terminal);
        assert_eq!(rows(&db).len(), 1);
        coalescer.finish(&db);
        assert!(rows(&db).is_empty());
    }

    fn seed_command_row(
        db: &StateDb,
        event_id: &str,
        revision: i64,
        ts: i64,
        command: Value,
    ) -> i64 {
        let payload = json!({
            "type": COMMAND_SNAPSHOT_EVENT_TYPE,
            "active": true,
            "ts": ts,
            "eventId": event_id,
            "snapshotSeq": null,
            "command": command,
        });
        append_row(db, "web-actions", "lane", event_id, revision, &payload, ts).expect("seq")
    }

    #[test]
    fn hydrate_restores_the_latest_live_command_and_retires_older_rows() {
        let (db, _dir) = test_db();
        seed_command_row(
            &db,
            "active-command:old",
            2,
            1_000,
            json!({
                "id": "old",
                "identity": "old",
                "command": "pwd",
                "status": "in_progress",
                "startOffset": 0,
                "endOffset": 3,
                "revision": 2,
            }),
        );
        let seq = seed_command_row(
            &db,
            "active-command:latest",
            4,
            2_000,
            json!({
                "id": "call-latest",
                "identity": "call-latest",
                "command": "ls",
                "status": "in_progress",
                "startOffset": 5,
                "endOffset": 13,
                "revision": 4,
            }),
        );

        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        let snapshot = coalescer.snapshot(&db).expect("snapshot");
        assert_eq!(snapshot["eventId"], "active-command:latest");
        assert_eq!(snapshot["snapshotSeq"], seq);
        assert_eq!(snapshot["revision"], 4);
        assert_eq!(snapshot["command"]["identity"], "call-latest");
        assert_eq!(snapshot["command"]["command"], "ls");
        assert_eq!(snapshot["command"]["startOffset"], 5);
        assert_eq!(snapshot["command"]["endOffset"], 13);

        let remaining = rows(&db);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["command"]["identity"], "call-latest");
    }

    #[test]
    fn hydrate_discards_a_terminal_command_snapshot() {
        let (db, _dir) = test_db();
        seed_command_row(
            &db,
            "active-command:done",
            3,
            1_000,
            json!({
                "id": "call-done",
                "identity": "call-done",
                "command": "ls",
                "status": "completed",
                "endOffset": 12,
                "revision": 3,
            }),
        );

        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        assert!(coalescer.snapshot(&db).is_none());
        assert!(rows(&db).is_empty());
    }

    #[test]
    fn hydrate_reuses_the_persisted_identity_for_offsets() {
        let (db, _dir) = test_db();
        seed_command_row(
            &db,
            "active-command:call-1",
            3,
            1_000,
            json!({
                "id": "tool-1",
                "identity": "call-1",
                "command": "ls",
                "status": "in_progress",
                "startOffset": 0,
                "endOffset": 2,
                "revision": 3,
            }),
        );

        let coalescer = CommandSnapshotCoalescer::new("web-actions", "lane");
        let position = coalescer
            .record(
                &db,
                2_000,
                &json!({
                    "id": "tool-1",
                    "command": "ls",
                    "outputDelta": "ab",
                    "outputStartOffset": 2,
                    "outputEndOffset": 4,
                }),
            )
            .expect("position");
        assert_eq!(position.identity, "call-1");
        assert_eq!(position.event_id, "active-command:call-1");
        assert_eq!(position.start_offset, 2);
        assert_eq!(position.end_offset, 4);
        assert_eq!(position.revision, 4);

        let snapshot = coalescer.snapshot(&db).expect("snapshot");
        assert_eq!(snapshot["command"]["identity"], "call-1");
        assert_eq!(snapshot["command"]["endOffset"], 4);
        assert_eq!(rows(&db).len(), 1);
    }
}
