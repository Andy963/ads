use ads_state::{AppendSyncEvent, StateDb, SyncEventStore};
use serde_json::json;

fn open_state() -> (StateDb, tempfile::TempDir) {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    (db, directory)
}

fn append<'a>(
    store: &SyncEventStore,
    connection: &mut rusqlite::Connection,
    lane_key: &'a str,
    event_type: &'a str,
    event_id: Option<&'a str>,
    payload: &'a serde_json::Value,
    ts: i64,
) -> i64 {
    store
        .append(
            connection,
            AppendSyncEvent {
                namespace: "chat",
                lane_key,
                event_type,
                event_id,
                revision: Some(1),
                payload,
                ts: Some(ts),
                run_id: None,
            },
        )
        .expect("append")
        .expect("seq")
}

#[test]
fn append_and_replay_preserve_order_and_cursor_metadata() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::default();
    let first_payload = json!({"text": "first"});
    let second_payload = json!({"command": "ls"});
    assert_eq!(
        append(
            &store,
            &mut connection,
            "lane-1",
            "text",
            None,
            &first_payload,
            10,
        ),
        1
    );
    assert_eq!(
        append(
            &store,
            &mut connection,
            "lane-1",
            "command",
            Some("event-2"),
            &second_payload,
            20,
        ),
        2
    );
    append(
        &store,
        &mut connection,
        "lane-1",
        "result",
        None,
        &json!({"ok": true}),
        30,
    );

    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(0), None)
        .expect("replay");
    assert_eq!(replay.events.len(), 3);
    assert_eq!(replay.events[0].seq, 1);
    assert_eq!(replay.events[0].payload, first_payload);
    assert_eq!(replay.events[1].event_id.as_deref(), Some("event-2"));
    assert_eq!(replay.latest_seq, 3);
    assert_eq!(replay.min_available_seq, 1);
    assert!(!replay.has_more);
    assert!(!replay.truncated);
    let serialized = serde_json::to_value(&replay.events[0]).expect("serialize");
    assert!(
        !serialized
            .as_object()
            .expect("object")
            .contains_key("eventId")
    );
    assert!(
        !serialized
            .as_object()
            .expect("object")
            .contains_key("runId")
    );

    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(1), Some(1))
        .expect("page");
    assert_eq!(replay.events.len(), 1);
    assert_eq!(replay.events[0].seq, 2);
    assert!(replay.has_more);
}

#[test]
fn coalesced_snapshots_replace_the_previous_row_at_a_new_sequence() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::default();
    for (text, ts) in [("a", 1), ("ab", 2)] {
        store
            .append_coalesced(
                &mut connection,
                AppendSyncEvent {
                    namespace: "chat",
                    lane_key: "lane-1",
                    event_type: "delta_snapshot",
                    event_id: Some("turn-1"),
                    revision: Some(1),
                    payload: &json!({"text": text}),
                    ts: Some(ts),
                    run_id: None,
                },
            )
            .expect("append");
    }
    let events = store
        .read_coalesced(&connection, "chat", "lane-1", Some("delta_snapshot"))
        .expect("coalesced");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].seq, 2);
    assert_eq!(events[0].payload, json!({"text": "ab"}));

    store
        .mark_coalesced_inactive(&connection, "chat", "lane-1", "delta_snapshot", "turn-1")
        .expect("inactive");
    let events = store
        .read_coalesced(&connection, "chat", "lane-1", Some("delta_snapshot"))
        .expect("coalesced");
    assert_eq!(events[0].seq, 2);
    assert_eq!(events[0].payload["active"], json!(false));

    store
        .delete_coalesced(&connection, "chat", "lane-1", "delta_snapshot", "turn-1")
        .expect("delete");
    assert!(
        store
            .read_coalesced(&connection, "chat", "lane-1", Some("delta_snapshot"))
            .expect("coalesced")
            .is_empty()
    );
}

#[test]
fn coalesced_snapshots_reject_stale_revisions() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::default();
    for (revision, text) in [(2, "new"), (1, "stale")] {
        store
            .append_coalesced(
                &mut connection,
                AppendSyncEvent {
                    namespace: "chat",
                    lane_key: "lane-1",
                    event_type: "agent_message",
                    event_id: Some("message-1"),
                    revision: Some(revision),
                    payload: &json!({"status": text}),
                    ts: Some(revision),
                    run_id: None,
                },
            )
            .expect("append");
    }
    let events = store
        .read_coalesced(&connection, "chat", "lane-1", Some("agent_message"))
        .expect("coalesced");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].revision, 2);
    assert_eq!(events[0].payload["status"], json!("new"));
}

#[test]
fn durable_retention_advances_the_truncation_watermark() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::new(2, 300);
    for index in 0..3 {
        append(
            &store,
            &mut connection,
            "lane-1",
            "text",
            None,
            &json!({"index": index}),
            index + 1,
        );
    }

    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(0), None)
        .expect("replay");
    assert_eq!(
        replay
            .events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(replay.min_available_seq, 2);
    assert_eq!(replay.latest_seq, 3);
    assert!(replay.truncated);

    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(2), None)
        .expect("replay");
    assert_eq!(replay.events.len(), 1);
    assert!(!replay.truncated);
}

#[test]
fn ephemeral_retention_does_not_evict_durable_events() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::new(2, 1);
    append(
        &store,
        &mut connection,
        "lane-1",
        "text",
        None,
        &json!({"index": 1}),
        1,
    );
    append(
        &store,
        &mut connection,
        "lane-1",
        "text",
        None,
        &json!({"index": 2}),
        2,
    );
    append(
        &store,
        &mut connection,
        "lane-1",
        "command",
        Some("command-1"),
        &json!({"index": 3}),
        3,
    );
    append(
        &store,
        &mut connection,
        "lane-1",
        "command",
        Some("command-2"),
        &json!({"index": 4}),
        4,
    );

    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(0), None)
        .expect("replay");
    assert_eq!(
        replay
            .events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 2, 4]
    );
    assert!(
        replay.truncated,
        "the ephemeral gap still requires a snapshot"
    );
}

#[test]
fn clear_lanes_removes_events_and_watermarks() {
    let (db, _directory) = open_state();
    let mut connection = db.connect().expect("connection");
    let store = SyncEventStore::new(1, 1);
    append(
        &store,
        &mut connection,
        "lane-1",
        "text",
        None,
        &json!({"index": 1}),
        1,
    );
    append(
        &store,
        &mut connection,
        "lane-1",
        "text",
        None,
        &json!({"index": 2}),
        2,
    );
    store
        .clear_lanes(&mut connection, "chat", &["lane-1".to_string()])
        .expect("clear");
    let replay = store
        .read_after(&connection, "chat", "lane-1", Some(0), None)
        .expect("replay");
    assert!(replay.events.is_empty());
    assert_eq!(replay.latest_seq, 0);
    assert!(!replay.truncated);
}
