//! Coalesces transient assistant deltas into one replayable `delta_snapshot`
//! row per assistant phase, mirroring `server/web/server/sync/deltaStream.ts`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use ads_state::{AppendSyncEvent, StateDb, SyncEventStore};
use serde_json::{Map, Value, json};

pub const DELTA_SNAPSHOT_EVENT_TYPE: &str = "delta_snapshot";
pub const DELTA_SNAPSHOT_FLUSH_INTERVAL_MS: i64 = 750;
pub const DELTA_SNAPSHOT_MAX_CHARS: usize = 200_000;

static NEXT_STREAM_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaStreamPosition {
    pub stream_id: String,
    pub start_offset: i64,
    pub end_offset: i64,
    pub snapshot_seq: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeltaStreamIdentity {
    pub client_message_id: Option<String>,
    pub assistant_item_id: Option<String>,
}

impl DeltaStreamIdentity {
    pub fn new(client_message_id: Option<&str>, assistant_item_id: Option<&str>) -> Self {
        Self {
            client_message_id: client_message_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            assistant_item_id: assistant_item_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        }
    }
}

#[derive(Debug)]
struct DeltaState {
    namespace: String,
    lane_key: String,
    token: String,
    phase: i64,
    stream_id: String,
    identity: DeltaStreamIdentity,
    text: String,
    total_chars: i64,
    revision: i64,
    started_at: i64,
    last_flush_at: i64,
    latest_snapshot_seq: Option<i64>,
    pending: bool,
    hydrated: bool,
}

#[derive(Debug)]
pub struct DeltaStreamCoalescer {
    state: Mutex<DeltaState>,
}

impl DeltaStreamCoalescer {
    pub fn new(namespace: &str, lane_key: &str) -> Self {
        let token = format!(
            "{}-{}",
            uuid::Uuid::new_v4(),
            NEXT_STREAM_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        Self {
            state: Mutex::new(DeltaState {
                namespace: namespace.to_string(),
                lane_key: lane_key.to_string(),
                stream_id: stream_event_id(lane_key, &token, 0),
                token,
                phase: 0,
                identity: DeltaStreamIdentity::default(),
                text: String::new(),
                total_chars: 0,
                revision: 0,
                started_at: 0,
                last_flush_at: 0,
                latest_snapshot_seq: None,
                pending: false,
                hydrated: false,
            }),
        }
    }

    /// Restore an active snapshot left behind by a previous process.
    pub fn ensure_hydrated(&self, db: &StateDb) {
        let mut state = self.state.lock().expect("delta stream lock");
        if state.hydrated {
            return;
        }
        let Ok(connection) = db.connect() else {
            return;
        };
        let Ok(rows) = SyncEventStore::default().read_coalesced(
            &connection,
            &state.namespace,
            &state.lane_key,
            Some(DELTA_SNAPSHOT_EVENT_TYPE),
        ) else {
            return;
        };
        state.hydrated = true;
        if rows.is_empty() {
            return;
        }
        let active = rows
            .iter()
            .rfind(|row| row.payload.get("active") != Some(&Value::Bool(false)));
        let Some(row) = active else {
            let highest = rows
                .iter()
                .filter_map(|row| parse_phase(row.event_id.as_deref()))
                .max()
                .unwrap_or(0);
            state.phase = highest + 1;
            state.stream_id = stream_event_id(&state.lane_key, &state.token, state.phase);
            return;
        };
        let payload = &row.payload;
        let restored_text = payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let restored_end = payload
            .get("endOffset")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0);
        let restored_start = payload
            .get("startOffset")
            .and_then(Value::as_i64)
            .filter(|value| *value >= 0);
        if restored_text.is_empty() && restored_end.is_none() {
            return;
        }
        state.identity = DeltaStreamIdentity::new(
            payload.get("clientMessageId").and_then(Value::as_str),
            payload.get("assistantItemId").and_then(Value::as_str),
        );
        let mut text = restored_text;
        truncate_front(&mut text, DELTA_SNAPSHOT_MAX_CHARS);
        state.total_chars = restored_end
            .or_else(|| restored_start.map(|start| start + text.chars().count() as i64))
            .unwrap_or(text.chars().count() as i64);
        state.text = text;
        state.revision = payload
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(row.revision)
            .max(0);
        state.started_at = payload
            .get("ts")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or(row.ts);
        state.last_flush_at = row.ts;
        state.latest_snapshot_seq = Some(row.seq);
        if let Some(stream_id) = payload
            .get("streamId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            state.stream_id = stream_id.to_string();
        } else if let Some(event_id) = row
            .event_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            state.stream_id = event_id.to_string();
        }
        state.phase = parse_phase(Some(&state.stream_id)).unwrap_or(0);
        state.pending = false;
    }

    /// Flush a pending snapshot once the coalescing window has elapsed.
    pub fn flush_due(&self, db: &StateDb, now: i64) {
        let mut state = self.state.lock().expect("delta stream lock");
        if state.pending && now - state.last_flush_at >= DELTA_SNAPSHOT_FLUSH_INTERVAL_MS {
            flush_locked(&mut state, db, true, now);
        }
    }

    pub fn append_delta(
        &self,
        db: &StateDb,
        delta: &str,
        event_ts: i64,
        identity: Option<DeltaStreamIdentity>,
    ) -> Option<DeltaStreamPosition> {
        if delta.is_empty() {
            return None;
        }
        self.ensure_hydrated(db);
        let mut state = self.state.lock().expect("delta stream lock");
        if let Some(identity) = identity {
            if !state.text.is_empty() && identity_changed(&state.identity, &identity) {
                seal_phase_locked(&mut state, db);
            }
            if identity.client_message_id.is_some() {
                state.identity.client_message_id = identity.client_message_id;
            }
            if identity.assistant_item_id.is_some() {
                state.identity.assistant_item_id = identity.assistant_item_id;
            }
        }
        if state.started_at == 0 {
            state.started_at = normalize_ts(event_ts);
        }
        let start_offset = state.total_chars;
        state.total_chars += delta.chars().count() as i64;
        state.text.push_str(delta);
        truncate_front(&mut state.text, DELTA_SNAPSHOT_MAX_CHARS);
        state.pending = true;
        let now = now_millis();
        if now - state.last_flush_at >= DELTA_SNAPSHOT_FLUSH_INTERVAL_MS {
            flush_locked(&mut state, db, true, now);
        }
        Some(DeltaStreamPosition {
            stream_id: state.stream_id.clone(),
            start_offset,
            end_offset: state.total_chars,
            snapshot_seq: state.latest_snapshot_seq,
        })
    }

    pub fn finish_phase(&self, db: &StateDb) {
        self.ensure_hydrated(db);
        let mut state = self.state.lock().expect("delta stream lock");
        seal_phase_locked(&mut state, db);
    }

    pub fn finish(&self, db: &StateDb) {
        self.ensure_hydrated(db);
        let mut state = self.state.lock().expect("delta stream lock");
        let retiring_event_id = state.stream_id.clone();
        let had_active =
            !state.text.is_empty() || state.revision > 0 || state.latest_snapshot_seq.is_some();
        state.identity = DeltaStreamIdentity::default();
        state.text.clear();
        state.total_chars = 0;
        state.revision = 0;
        state.started_at = 0;
        state.last_flush_at = 0;
        state.latest_snapshot_seq = None;
        state.pending = false;
        if had_active {
            state.phase += 1;
            delete_locked(&mut state, db, &retiring_event_id);
        }
        state.stream_id = stream_event_id(&state.lane_key, &state.token, state.phase);
    }

    pub fn snapshot(&self, db: &StateDb) -> Option<Value> {
        self.ensure_hydrated(db);
        let state = self.state.lock().expect("delta stream lock");
        if state.text.is_empty() && state.revision <= 0 && state.latest_snapshot_seq.is_none() {
            return None;
        }
        let mut snapshot = Map::new();
        snapshot.insert("type".to_string(), json!(DELTA_SNAPSHOT_EVENT_TYPE));
        snapshot.insert("eventId".to_string(), json!(state.stream_id));
        snapshot.insert("snapshotSeq".to_string(), json!(state.latest_snapshot_seq));
        snapshot.insert("revision".to_string(), json!(state.revision));
        snapshot.insert("active".to_string(), json!(true));
        snapshot.insert(
            "afterSeq".to_string(),
            json!(state.latest_snapshot_seq.unwrap_or(0)),
        );
        snapshot.insert("streamId".to_string(), json!(state.stream_id));
        if let Some(client_message_id) = state.identity.client_message_id.as_deref() {
            snapshot.insert("clientMessageId".to_string(), json!(client_message_id));
        }
        if let Some(assistant_item_id) = state.identity.assistant_item_id.as_deref() {
            snapshot.insert("assistantItemId".to_string(), json!(assistant_item_id));
        }
        snapshot.insert("text".to_string(), json!(state.text));
        snapshot.insert(
            "startOffset".to_string(),
            json!(state.total_chars - state.text.chars().count() as i64),
        );
        snapshot.insert("endOffset".to_string(), json!(state.total_chars));
        snapshot.insert(
            "ts".to_string(),
            json!(if state.started_at > 0 {
                state.started_at
            } else if state.last_flush_at > 0 {
                state.last_flush_at
            } else {
                now_millis()
            }),
        );
        Some(Value::Object(snapshot))
    }
}

fn identity_changed(current: &DeltaStreamIdentity, next: &DeltaStreamIdentity) -> bool {
    let client_changed = current.client_message_id.is_some()
        && next.client_message_id.is_some()
        && current.client_message_id != next.client_message_id;
    let item_changed = current.assistant_item_id.is_some()
        && next.assistant_item_id.is_some()
        && current.assistant_item_id != next.assistant_item_id;
    client_changed || item_changed
}

fn seal_phase_locked(state: &mut DeltaState, db: &StateDb) {
    flush_locked(state, db, true, now_millis());
    if !state.text.is_empty() {
        mark_inactive_locked(state, db);
    }
    state.identity = DeltaStreamIdentity::default();
    state.text.clear();
    state.total_chars = 0;
    state.revision = 0;
    state.started_at = 0;
    state.last_flush_at = 0;
    state.latest_snapshot_seq = None;
    state.pending = false;
    state.phase += 1;
    state.stream_id = stream_event_id(&state.lane_key, &state.token, state.phase);
}

fn flush_locked(state: &mut DeltaState, db: &StateDb, active: bool, now: i64) {
    if state.text.is_empty() {
        return;
    }
    state.revision += 1;
    state.pending = false;
    state.last_flush_at = now;
    let mut payload = Map::new();
    payload.insert("type".to_string(), json!(DELTA_SNAPSHOT_EVENT_TYPE));
    payload.insert("text".to_string(), json!(state.text));
    payload.insert("revision".to_string(), json!(state.revision));
    payload.insert("streamId".to_string(), json!(state.stream_id));
    if let Some(client_message_id) = state.identity.client_message_id.as_deref() {
        payload.insert("clientMessageId".to_string(), json!(client_message_id));
    }
    if let Some(assistant_item_id) = state.identity.assistant_item_id.as_deref() {
        payload.insert("assistantItemId".to_string(), json!(assistant_item_id));
    }
    payload.insert(
        "startOffset".to_string(),
        json!(state.total_chars - state.text.chars().count() as i64),
    );
    payload.insert("endOffset".to_string(), json!(state.total_chars));
    payload.insert(
        "ts".to_string(),
        json!(if state.started_at > 0 {
            state.started_at
        } else {
            now
        }),
    );
    payload.insert("active".to_string(), json!(active));
    let payload = Value::Object(payload);
    let Ok(mut connection) = db.connect() else {
        return;
    };
    let result = SyncEventStore::default().append_coalesced(
        &mut connection,
        AppendSyncEvent {
            namespace: &state.namespace,
            lane_key: &state.lane_key,
            event_type: DELTA_SNAPSHOT_EVENT_TYPE,
            event_id: Some(&state.stream_id),
            revision: Some(state.revision),
            payload: &payload,
            ts: Some(now),
            run_id: None,
        },
    );
    match result {
        Ok(Some(seq)) => state.latest_snapshot_seq = Some(seq),
        Ok(None) => {}
        Err(error) => eprintln!("[ads-ws] failed to persist delta snapshot: {error}"),
    }
}

fn mark_inactive_locked(state: &mut DeltaState, db: &StateDb) {
    let Ok(connection) = db.connect() else {
        return;
    };
    if let Err(error) = SyncEventStore::default().mark_coalesced_inactive(
        &connection,
        &state.namespace,
        &state.lane_key,
        DELTA_SNAPSHOT_EVENT_TYPE,
        &state.stream_id,
    ) {
        eprintln!("[ads-ws] failed to seal delta snapshot: {error}");
    }
}

fn delete_locked(state: &mut DeltaState, db: &StateDb, event_id: &str) {
    let Ok(connection) = db.connect() else {
        return;
    };
    if let Err(error) = SyncEventStore::default().delete_coalesced(
        &connection,
        &state.namespace,
        &state.lane_key,
        DELTA_SNAPSHOT_EVENT_TYPE,
        event_id,
    ) {
        eprintln!("[ads-ws] failed to retire delta snapshot: {error}");
    }
}

fn parse_phase(event_id: Option<&str>) -> Option<i64> {
    let event_id = event_id?;
    let (_, phase) = event_id.rsplit_once(':')?;
    phase.parse::<i64>().ok().map(|value| value.max(0))
}

fn stream_event_id(lane_key: &str, token: &str, phase: i64) -> String {
    format!("stream:{lane_key}:{token}:{phase}")
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

fn normalize_ts(value: i64) -> i64 {
    if value > 0 { value } else { now_millis() }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
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

    #[test]
    fn snapshot_accumulates_offsets_and_text() {
        let (db, _dir) = test_db();
        let coalescer = DeltaStreamCoalescer::new("web-actions", "lane");
        let first = coalescer
            .append_delta(&db, "Hello ", 1_000, None)
            .expect("first delta");
        assert_eq!(first.start_offset, 0);
        assert_eq!(first.end_offset, 6);
        let second = coalescer
            .append_delta(&db, "world", 1_001, None)
            .expect("second delta");
        assert_eq!(second.start_offset, 6);
        assert_eq!(second.end_offset, 11);
        let snapshot = coalescer.snapshot(&db).expect("snapshot");
        assert_eq!(snapshot["text"], "Hello world");
        assert_eq!(snapshot["startOffset"], 0);
        assert_eq!(snapshot["endOffset"], 11);
        assert_eq!(snapshot["active"], true);
    }

    #[test]
    fn finish_retires_the_coalesced_row() {
        let (db, _dir) = test_db();
        let coalescer = DeltaStreamCoalescer::new("web-actions", "lane");
        coalescer.append_delta(&db, "partial", 1_000, None);
        assert!(coalescer.snapshot(&db).is_some());
        coalescer.finish(&db);
        assert!(coalescer.snapshot(&db).is_none());
        let connection = db.connect().expect("connection");
        let rows = SyncEventStore::default()
            .read_coalesced(
                &connection,
                "web-actions",
                "lane",
                Some(DELTA_SNAPSHOT_EVENT_TYPE),
            )
            .expect("rows");
        assert!(rows.is_empty(), "retired row should be deleted");
    }

    #[test]
    fn finish_phase_seals_and_rotates_the_stream() {
        let (db, _dir) = test_db();
        let coalescer = DeltaStreamCoalescer::new("web-actions", "lane");
        let before = coalescer
            .append_delta(&db, "phase one", 1_000, None)
            .expect("delta");
        coalescer.finish_phase(&db);
        let after = coalescer
            .append_delta(&db, "phase two", 2_000, None)
            .expect("delta");
        assert_ne!(before.stream_id, after.stream_id);
        assert_eq!(after.start_offset, 0);
        let connection = db.connect().expect("connection");
        let rows = SyncEventStore::default()
            .read_coalesced(
                &connection,
                "web-actions",
                "lane",
                Some(DELTA_SNAPSHOT_EVENT_TYPE),
            )
            .expect("rows");
        assert_eq!(rows.len(), 2, "the sealed phase is retained for catch-up");
        assert_eq!(rows[0].payload["text"], "phase one");
        assert_eq!(rows[0].payload["active"], false);
        assert_eq!(rows[1].payload["text"], "phase two");
        assert_eq!(rows[1].payload["active"], true);
    }

    fn append_snapshot_row(db: &StateDb, payload: Value) -> i64 {
        let mut connection = db.connect().expect("connection");
        SyncEventStore::default()
            .append_coalesced(
                &mut connection,
                AppendSyncEvent {
                    namespace: "web-actions",
                    lane_key: "lane",
                    event_type: DELTA_SNAPSHOT_EVENT_TYPE,
                    event_id: payload["streamId"].as_str(),
                    revision: payload["revision"].as_i64(),
                    payload: &payload,
                    ts: payload["ts"].as_i64(),
                    run_id: None,
                },
            )
            .expect("append")
            .expect("seq")
    }

    #[test]
    fn hydrate_restores_an_active_snapshot_from_another_process() {
        let (db, _dir) = test_db();
        let seq = append_snapshot_row(
            &db,
            json!({
                "type": DELTA_SNAPSHOT_EVENT_TYPE,
                "text": "persisted text",
                "revision": 7,
                "streamId": "stream:lane:old-token:3",
                "clientMessageId": "client-1",
                "assistantItemId": "item-1",
                "startOffset": 40,
                "endOffset": 54,
                "ts": 1_000,
                "active": true,
            }),
        );

        let resumed = DeltaStreamCoalescer::new("web-actions", "lane");
        let restored = resumed.snapshot(&db).expect("hydrated snapshot");
        assert_eq!(restored["text"], "persisted text");
        assert_eq!(restored["startOffset"], 40);
        assert_eq!(restored["endOffset"], 54);
        assert_eq!(restored["streamId"], "stream:lane:old-token:3");
        assert_eq!(restored["clientMessageId"], "client-1");
        assert_eq!(restored["assistantItemId"], "item-1");
        assert_eq!(restored["revision"], 7);
        assert_eq!(restored["snapshotSeq"], seq);

        let next = resumed
            .append_delta(&db, "!", 2_000, None)
            .expect("continued delta");
        assert_eq!(next.stream_id, "stream:lane:old-token:3");
        assert_eq!(next.start_offset, 54);
        assert_eq!(next.end_offset, 55);
    }

    #[test]
    fn hydrate_advances_the_phase_when_no_snapshot_is_active() {
        let (db, _dir) = test_db();
        append_snapshot_row(
            &db,
            json!({
                "type": DELTA_SNAPSHOT_EVENT_TYPE,
                "text": "sealed phase",
                "revision": 2,
                "streamId": "stream:lane:old-token:4",
                "startOffset": 0,
                "endOffset": 12,
                "ts": 1_000,
                "active": false,
            }),
        );

        let resumed = DeltaStreamCoalescer::new("web-actions", "lane");
        let next = resumed
            .append_delta(&db, "next", 2_000, None)
            .expect("delta");
        assert_eq!(next.start_offset, 0);
        assert_eq!(parse_phase(Some(&next.stream_id)), Some(5));
        assert_ne!(next.stream_id, "stream:lane:old-token:4");
    }

    #[test]
    fn flush_due_persists_the_pending_snapshot() {
        let (db, _dir) = test_db();
        let coalescer = DeltaStreamCoalescer::new("web-actions", "lane");
        coalescer.append_delta(&db, "a", 1_000, None);
        coalescer.append_delta(&db, "b", 1_001, None);
        coalescer.flush_due(&db, i64::MAX);

        let connection = db.connect().expect("connection");
        let rows = SyncEventStore::default()
            .read_coalesced(
                &connection,
                "web-actions",
                "lane",
                Some(DELTA_SNAPSHOT_EVENT_TYPE),
            )
            .expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload["text"], "ab");
        assert_eq!(rows[0].payload["revision"], 2);
        assert_eq!(rows[0].payload["active"], true);
    }

    #[test]
    fn rotates_phase_when_assistant_item_identity_changes() {
        let (db, _dir) = test_db();
        let coalescer = DeltaStreamCoalescer::new("web-acopilot", "lane");
        let first = coalescer
            .append_delta(
                &db,
                "commentary phase",
                1_000,
                Some(DeltaStreamIdentity::new(Some("turn-1"), Some("item-1"))),
            )
            .expect("first delta");
        let second = coalescer
            .append_delta(
                &db,
                "final phase",
                1_050,
                Some(DeltaStreamIdentity::new(Some("turn-1"), Some("item-2"))),
            )
            .expect("second delta");
        coalescer.flush_due(&db, i64::MAX);

        assert_ne!(first.stream_id, second.stream_id);
        assert_eq!(second.start_offset, 0);
        assert_eq!(second.end_offset, "final phase".chars().count() as i64);

        let connection = db.connect().expect("connection");
        let rows = SyncEventStore::default()
            .read_coalesced(
                &connection,
                "web-acopilot",
                "lane",
                Some(DELTA_SNAPSHOT_EVENT_TYPE),
            )
            .expect("rows");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].payload["clientMessageId"], "turn-1");
        assert_eq!(rows[0].payload["assistantItemId"], "item-1");
        assert_eq!(rows[0].payload["text"], "commentary phase");
        assert_eq!(rows[0].payload["active"], false);
        assert_eq!(rows[1].payload["clientMessageId"], "turn-1");
        assert_eq!(rows[1].payload["assistantItemId"], "item-2");
        assert_eq!(rows[1].payload["text"], "final phase");
        assert_eq!(rows[1].payload["active"], true);
    }
}
