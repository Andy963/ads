use ads_contract::ws::HistoryEntry;
use ads_state::{
    HistoryAddOutcome, HistoryStore, StateDb, history_client_message_id,
    history_key_belongs_to_logical_lane, lane_history_keys,
};

fn open_state() -> (StateDb, tempfile::TempDir) {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    (db, directory)
}

fn entry(role: &str, text: &str, ts: i64, kind: Option<&str>) -> HistoryEntry {
    HistoryEntry {
        role: role.to_string(),
        text: text.to_string(),
        ts,
        kind: kind.map(ToString::to_string),
    }
}

#[test]
fn inserts_reads_and_deduplicates_client_messages() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    let store = HistoryStore::new("web-actions", 200, 64 * 1024);

    assert_eq!(
        store
            .add(
                &connection,
                "lane",
                entry("user", "hello", 10, Some("client_message_id:cm-1"))
            )
            .expect("insert"),
        HistoryAddOutcome::Inserted
    );
    assert_eq!(
        store
            .add(
                &connection,
                "lane",
                entry(
                    "user",
                    "different text",
                    20,
                    Some("client_message_id:cm-1;prompt_meta=model%3Dx")
                )
            )
            .expect("duplicate"),
        HistoryAddOutcome::Duplicate
    );
    assert_eq!(
        store
            .add(&connection, "lane", entry("ai", "world", 30, None))
            .expect("second insert"),
        HistoryAddOutcome::Inserted
    );

    let entries = store.get(&connection, "lane").expect("get");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].text, "hello");
    assert_eq!(entries[1].text, "world");
    assert_eq!(
        history_client_message_id(entries[0].kind.as_deref()),
        "cm-1"
    );
}

#[test]
fn truncates_text_and_retains_only_the_latest_entries() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    let store = HistoryStore::new("web-actions", 2, 5);

    store
        .add(&connection, "lane", entry("user", "abcdef", 1, None))
        .expect("first");
    let truncated = store.get(&connection, "lane").expect("get truncated");
    assert_eq!(truncated[0].text, "abcd…");

    store
        .add(&connection, "lane", entry("user", "second", 2, None))
        .expect("second");
    store
        .add(&connection, "lane", entry("user", "third", 3, None))
        .expect("third");
    let entries = store.get(&connection, "lane").expect("get trimmed");
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>(),
        vec!["seco…", "third"]
    );
}

#[test]
fn reads_retired_acopilot_lane_keys() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    let store = HistoryStore::new("web-acopilot", 200, 64 * 1024);

    store
        .add(
            &connection,
            "user::project::advisor:generation:2",
            entry("user", "legacy", 1, None),
        )
        .expect("insert legacy");
    let entries = store
        .get(&connection, "user::project::acopilot:generation:2")
        .expect("fallback read");
    assert_eq!(entries[0].text, "legacy");
}

#[test]
fn replaces_and_clears_history() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    let store = HistoryStore::new("web-actions", 200, 64 * 1024);

    store
        .replace_entries(
            &connection,
            "lane",
            &[
                entry("user", "first", 1, None),
                entry("ai", "second", 2, None),
            ],
        )
        .expect("replace");
    let entries = store.get(&connection, "lane").expect("get");
    assert_eq!(entries.len(), 2);

    assert_eq!(store.clear(&connection, "lane").expect("clear"), 2);
    assert!(
        store
            .get(&connection, "lane")
            .expect("get empty")
            .is_empty()
    );
}

#[test]
fn clears_every_generation_and_retired_acopilot_alias() {
    let (db, _directory) = open_state();
    let connection = db.connect().expect("connection");
    let store = HistoryStore::new("web-acopilot", 200, 64 * 1024);

    for key in [
        "user::project::acopilot",
        "user::project::acopilot:generation:2",
        "user::project::advisor:generation:2",
        "user::project::planner:generation:3",
        "user::project::other:generation:2",
    ] {
        store
            .add(&connection, key, entry("user", key, 1, None))
            .expect("insert");
    }

    assert_eq!(
        store
            .clear_logical_lane(&connection, "user::project::acopilot")
            .expect("clear lane"),
        4
    );
    for key in [
        "user::project::acopilot",
        "user::project::acopilot:generation:2",
        "user::project::advisor:generation:2",
        "user::project::planner:generation:3",
    ] {
        assert!(
            store.get(&connection, key).expect("get").is_empty(),
            "{key} survived reset"
        );
    }
    assert_eq!(
        store
            .get(&connection, "user::project::other:generation:2")
            .expect("other lane")
            .len(),
        1
    );
}

#[test]
fn matches_logical_lane_keys_and_enumerates_generations() {
    assert!(history_key_belongs_to_logical_lane(
        "user::project::main:generation:3",
        "user::project::main"
    ));
    assert!(history_key_belongs_to_logical_lane(
        "user::project::acopilot:generation:2",
        "user::project::acopilot"
    ));
    assert!(history_key_belongs_to_logical_lane(
        "user::project::advisor:generation:4",
        "user::project::acopilot"
    ));
    assert!(!history_key_belongs_to_logical_lane(
        "user::project::main-other",
        "user::project::main"
    ));

    assert_eq!(
        lane_history_keys("user::project::main", 3),
        vec![
            "user::project::main".to_string(),
            "user::project::main:generation:2".to_string(),
            "user::project::main:generation:3".to_string(),
        ]
    );
    assert_eq!(
        lane_history_keys("user::project::acopilot", 2),
        vec![
            "user::project::acopilot".to_string(),
            "user::project::acopilot:generation:2".to_string(),
            "user::project::advisor".to_string(),
            "user::project::advisor:generation:2".to_string(),
            "user::project::planner".to_string(),
            "user::project::planner:generation:2".to_string(),
        ]
    );
}
