use std::time::{Duration, Instant};

use ads_state::{StateDb, WorkspaceDb};

#[test]
fn opens_a_state_connection_while_another_connection_holds_a_write_lock() {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let writer = db.connect().expect("writer connection");
    writer.execute_batch("BEGIN IMMEDIATE").expect("write lock");

    let started = Instant::now();
    let reader = db.connect().expect("reader connection");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "connection setup must not reacquire WAL mode"
    );
    let mode: String = reader
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal mode");
    assert_eq!(mode.to_ascii_lowercase(), "wal");

    writer.execute_batch("ROLLBACK").expect("release lock");
}

#[test]
fn opens_a_workspace_connection_while_another_connection_holds_a_write_lock() {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = WorkspaceDb::open(directory.path().join("workspace.db")).expect("workspace db");
    let writer = db.connect().expect("writer connection");
    writer.execute_batch("BEGIN IMMEDIATE").expect("write lock");

    let started = Instant::now();
    let reader = db.connect().expect("reader connection");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "connection setup must not reacquire WAL mode"
    );
    let mode: String = reader
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal mode");
    assert_eq!(mode.to_ascii_lowercase(), "wal");

    writer.execute_batch("ROLLBACK").expect("release lock");
}
