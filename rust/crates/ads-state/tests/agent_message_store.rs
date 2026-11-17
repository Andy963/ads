use ads_state::{AgentMessageStatus, AgentMessageStore, NewAgentMessage, StateDb};
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};
use tempfile::tempdir;

fn payload(text: &str) -> Map<String, Value> {
    json!({ "text": text, "origin": "agent" })
        .as_object()
        .expect("payload object")
        .clone()
}

fn message(id: &str, head: &str, created_at: i64) -> NewAgentMessage {
    NewAgentMessage {
        message_id: id.to_string(),
        auth_user_id: "user-1".to_string(),
        user_id: 42,
        project_id: "project-1".to_string(),
        chat_session_id: "acopilot".to_string(),
        history_key: "user-1::project-1::acopilot".to_string(),
        logical_history_key: "user-1::project-1::acopilot".to_string(),
        lane_namespace: "web-acopilot".to_string(),
        lane_generation: 1,
        workspace_root: "/repo".to_string(),
        from_lane: "actions".to_string(),
        from_role: "reviewer".to_string(),
        to_lane: "acopilot".to_string(),
        to_role: "acopilot".to_string(),
        kind: "review_verdict".to_string(),
        correlation_id: id.to_string(),
        issue_id: Some(7),
        issue_title: "Review handoff".to_string(),
        issue_url: Some("https://github.com/example/issues/7".to_string()),
        pr_number: Some(12),
        branch: Some("codex/issue-7".to_string()),
        base_sha: Some("base".to_string()),
        head_sha: Some(head.to_string()),
        payload: payload("Reviewer handoff"),
        source_created_at: created_at,
        force_superseded: false,
        created_at,
    }
}

fn seed_review_job(connection: &Connection, id: &str, now: i64) {
    connection
        .execute(
            "INSERT OR IGNORE INTO action_jobs
               (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                requires_agent_handoff)
             VALUES (?1, 'project-1', 'pull_request_review', 'Issue', 'completed', ?2, ?2, 1)",
            params![id, now],
        )
        .expect("review job");
}

#[test]
fn enqueue_is_idempotent_and_supersedes_older_pending_heads() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-1", 100);
    seed_review_job(&connection, "review-verdict:job-2", 300);

    let first = store
        .enqueue(message("review-verdict:job-1", "head-1", 100), 100)
        .expect("first handoff");
    assert!(!first.duplicate);
    assert_eq!(first.message.status, AgentMessageStatus::Pending);

    let duplicate = store
        .enqueue(message("review-verdict:job-1", "head-1", 200), 200)
        .expect("duplicate handoff");
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.message.created_at, 100);

    let second = store
        .enqueue(message("review-verdict:job-2", "head-2", 300), 300)
        .expect("new handoff");
    assert_eq!(second.superseded_ids, vec!["review-verdict:job-1"]);
    assert_eq!(
        store
            .get_by_message_id("review-verdict:job-1")
            .expect("first message")
            .expect("first exists")
            .status,
        AgentMessageStatus::Superseded
    );
    assert_eq!(
        store
            .get_by_message_id("review-verdict:job-2")
            .expect("second message")
            .expect("second exists")
            .status,
        AgentMessageStatus::Pending
    );
}

#[test]
fn superseded_action_job_marks_pending_handoff_superseded() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-old-superseded", 100);

    let enqueued = store
        .enqueue(message("review-verdict:job-old-superseded", "head-1", 100), 100)
        .expect("enqueue");
    assert_eq!(enqueued.message.status, AgentMessageStatus::Pending);

    connection
        .execute(
            "UPDATE action_jobs SET superseded_at = ?1 WHERE id = ?2",
            params![150, "review-verdict:job-old-superseded"],
        )
        .expect("supersede job");

    let updated = store
        .supersede_messages_for_superseded_review_jobs(160)
        .expect("supersede messages");
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].message_id, "review-verdict:job-old-superseded");
    assert_eq!(updated[0].status, AgentMessageStatus::Superseded);
    assert_eq!(
        updated[0].transition_revision,
        enqueued.message.transition_revision + 1
    );

    let read = store
        .get_by_message_id("review-verdict:job-old-superseded")
        .expect("read")
        .expect("exists");
    assert_eq!(read.status, AgentMessageStatus::Superseded);
}

#[test]
fn delayed_older_review_cannot_replace_a_newer_handoff() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-new", 300);
    seed_review_job(&connection, "review-verdict:job-old", 200);

    store
        .enqueue(message("review-verdict:job-new", "head-new", 300), 300)
        .expect("new handoff");
    let delayed = store
        .enqueue(message("review-verdict:job-old", "head-old", 200), 400)
        .expect("delayed old handoff");

    assert_eq!(delayed.message.status, AgentMessageStatus::Superseded);
    assert!(delayed.superseded_ids.is_empty());
    assert_eq!(
        store
            .get_by_message_id("review-verdict:job-new")
            .expect("new message")
            .expect("new exists")
            .status,
        AgentMessageStatus::Pending,
    );
}

#[test]
fn failed_handoff_can_be_explicitly_retried() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-retry", 100);
    store
        .enqueue(message("review-verdict:job-retry", "head", 100), 100)
        .expect("handoff");
    store
        .claim("review-verdict:job-retry", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");
    store
        .mark_failed(
            "review-verdict:job-retry",
            "worker-1",
            "model unavailable",
            120,
        )
        .expect("failed")
        .expect("failed message");
    let retried = store
        .retry_failed(
            "review-verdict:job-retry",
            "user-1",
            "project-1",
            "acopilot",
            1,
            130,
        )
        .expect("retry")
        .expect("retried message");
    assert_eq!(retried.status, AgentMessageStatus::Pending);
    assert_eq!(retried.last_error, None);
    assert_eq!(
        store
            .claim("review-verdict:job-retry", "worker-2", 250, 140)
            .expect("reclaim")
            .expect("reclaimed")
            .attempts,
        2
    );
}

#[test]
fn superseded_review_job_is_not_recoverable() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-recover", 100);
    store
        .enqueue(message("review-verdict:job-recover", "head", 100), 100)
        .expect("handoff");

    assert_eq!(store.list_recoverable(110).expect("recoverable").len(), 1);
    connection
        .execute(
            "UPDATE action_jobs SET superseded_at = ?1 WHERE id = ?2",
            params![120, "review-verdict:job-recover"],
        )
        .expect("supersede job");

    assert!(store.list_recoverable(130).expect("recoverable").is_empty());
}

#[test]
fn superseded_review_job_cannot_be_retried() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-retry-superseded", 100);
    store
        .enqueue(
            message("review-verdict:job-retry-superseded", "head", 100),
            100,
        )
        .expect("handoff");
    store
        .claim("review-verdict:job-retry-superseded", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");
    store
        .mark_failed(
            "review-verdict:job-retry-superseded",
            "worker-1",
            "model unavailable",
            120,
        )
        .expect("failed")
        .expect("failed message");
    connection
        .execute(
            "UPDATE action_jobs SET superseded_at = ?1 WHERE id = ?2",
            params![130, "review-verdict:job-retry-superseded"],
        )
        .expect("supersede job");

    assert!(
        store
            .retry_failed(
                "review-verdict:job-retry-superseded",
                "user-1",
                "project-1",
                "acopilot",
                1,
                140,
            )
            .expect("retry")
            .is_none()
    );
    assert_eq!(
        store
            .get_by_message_id("review-verdict:job-retry-superseded")
            .expect("message")
            .expect("message exists")
            .status,
        AgentMessageStatus::Failed
    );
}

#[test]
fn running_handoff_can_be_superseded_when_the_lane_resets() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-reset", 100);
    store
        .enqueue(message("review-verdict:job-reset", "head", 100), 100)
        .expect("handoff");
    store
        .claim("review-verdict:job-reset", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");

    let updated = store
        .mark_running_superseded("review-verdict:job-reset", "worker-1", 120)
        .expect("supersede")
        .expect("running message");
    assert_eq!(updated.status, AgentMessageStatus::Superseded);
}

#[test]
fn newer_review_supersedes_an_older_running_handoff() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-old", 100);
    seed_review_job(&connection, "review-verdict:job-new", 200);
    store
        .enqueue(message("review-verdict:job-old", "head-old", 100), 100)
        .expect("old handoff");
    let claimed = store
        .claim("review-verdict:job-old", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");

    let newer = store
        .enqueue(message("review-verdict:job-new", "head-new", 200), 200)
        .expect("new handoff");
    assert_eq!(newer.superseded_ids, vec!["review-verdict:job-old"]);
    let superseded = store
        .get_by_message_id("review-verdict:job-old")
        .expect("old message")
        .expect("old exists");
    assert_eq!(superseded.status, AgentMessageStatus::Superseded);
    assert_eq!(
        superseded.transition_revision,
        claimed.transition_revision + 1
    );
}

#[test]
fn expired_owner_cannot_renew_or_write_a_terminal_state() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-expired", 100);
    store
        .enqueue(message("review-verdict:job-expired", "head", 100), 100)
        .expect("handoff");
    store
        .claim("review-verdict:job-expired", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");

    assert!(
        !store
            .renew("review-verdict:job-expired", "worker-1", 300, 200)
            .expect("expired renew")
    );
    assert!(
        store
            .mark_delivered("review-verdict:job-expired", "worker-1", 200)
            .expect("expired terminal")
            .is_none()
    );
}

#[test]
fn superseded_review_job_cannot_be_renewed_or_completed() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-running-stale", 100);
    store
        .enqueue(
            message("review-verdict:job-running-stale", "head", 100),
            100,
        )
        .expect("handoff");
    store
        .claim("review-verdict:job-running-stale", "worker-1", 200, 110)
        .expect("claim")
        .expect("claimed");
    connection
        .execute(
            "UPDATE action_jobs SET superseded_at = ?1 WHERE id = ?2",
            params![120, "review-verdict:job-running-stale"],
        )
        .expect("supersede job");

    assert!(
        !store
            .renew("review-verdict:job-running-stale", "worker-1", 300, 130)
            .expect("renew")
    );
    let terminal = store
        .mark_delivered("review-verdict:job-running-stale", "worker-1", 140)
        .expect("terminal")
        .expect("message");
    assert_eq!(terminal.status, AgentMessageStatus::Superseded);
    assert_eq!(
        store
            .get_by_message_id("review-verdict:job-running-stale")
            .expect("message")
            .expect("message exists")
            .status,
        AgentMessageStatus::Superseded
    );
}

#[test]
fn claim_lifecycle_uses_leases_and_marks_terminal_state() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:job-1", 100);
    store
        .enqueue(message("review-verdict:job-1", "head-1", 100), 100)
        .expect("handoff");

    let claimed = store
        .claim("review-verdict:job-1", "worker-1", 150, 110)
        .expect("claim")
        .expect("claimed message");
    assert_eq!(claimed.status, AgentMessageStatus::Running);
    assert_eq!(claimed.attempts, 1);
    assert!(
        store
            .claim("review-verdict:job-1", "worker-2", 160, 111)
            .expect("competing claim")
            .is_none()
    );
    assert!(
        store
            .renew("review-verdict:job-1", "worker-1", 200, 120)
            .expect("renew")
    );
    assert!(store.list_recoverable(160).expect("recoverable").is_empty());
    assert_eq!(store.list_recoverable(200).expect("expired").len(), 1);

    let recovered = store
        .claim("review-verdict:job-1", "worker-2", 250, 200)
        .expect("recover expired claim")
        .expect("expired running message is recoverable");
    assert_eq!(recovered.status, AgentMessageStatus::Running);
    assert_eq!(recovered.attempts, 2);

    let delivered = store
        .mark_delivered("review-verdict:job-1", "worker-2", 210)
        .expect("delivered")
        .expect("terminal message");
    assert_eq!(delivered.status, AgentMessageStatus::Delivered);
    assert_eq!(delivered.delivered_at, Some(210));
    assert_eq!(
        store
            .list_for_lane("user-1", "project-1", "acopilot", 1, 10)
            .expect("lane messages")
            .len(),
        1
    );
}

#[test]
fn no_pr_reviews_on_different_branches_do_not_supersede_each_other() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
    seed_review_job(&connection, "review-verdict:branch-a-1", 100);
    seed_review_job(&connection, "review-verdict:branch-b", 200);
    seed_review_job(&connection, "review-verdict:branch-a-2", 300);

    let mut msg_a1 = message("review-verdict:branch-a-1", "head-a1", 100);
    msg_a1.pr_number = None;
    msg_a1.branch = Some("codex/issue-7-a".to_string());

    let mut msg_b = message("review-verdict:branch-b", "head-b", 200);
    msg_b.pr_number = None;
    msg_b.branch = Some("codex/issue-7-b".to_string());

    let mut msg_a2 = message("review-verdict:branch-a-2", "head-a2", 300);
    msg_a2.pr_number = None;
    msg_a2.branch = Some("codex/issue-7-a".to_string());

    let res_a1 = store.enqueue(msg_a1, 100).expect("enqueue a1");
    assert_eq!(res_a1.message.status, AgentMessageStatus::Pending);

    let res_b = store.enqueue(msg_b, 200).expect("enqueue b");
    assert_eq!(res_b.message.status, AgentMessageStatus::Pending);
    assert!(res_b.superseded_ids.is_empty());
    assert_eq!(
        store
            .get_by_message_id("review-verdict:branch-a-1")
            .expect("read a1")
            .expect("exists")
            .status,
        AgentMessageStatus::Pending
    );

    let res_a2 = store.enqueue(msg_a2, 300).expect("enqueue a2");
    assert_eq!(res_a2.message.status, AgentMessageStatus::Pending);
    assert_eq!(res_a2.superseded_ids, vec!["review-verdict:branch-a-1"]);
    assert_eq!(
        store
            .get_by_message_id("review-verdict:branch-a-1")
            .expect("read a1")
            .expect("exists")
            .status,
        AgentMessageStatus::Superseded
    );
    assert_eq!(
        store
            .get_by_message_id("review-verdict:branch-b")
            .expect("read b")
            .expect("exists")
            .status,
        AgentMessageStatus::Pending
    );
}
