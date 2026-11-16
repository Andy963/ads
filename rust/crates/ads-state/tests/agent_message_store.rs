use ads_state::{AgentMessageStatus, AgentMessageStore, NewAgentMessage, StateDb};
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
        base_sha: Some("base".to_string()),
        head_sha: Some(head.to_string()),
        payload: payload("Reviewer handoff"),
        created_at,
    }
}

#[test]
fn enqueue_is_idempotent_and_supersedes_older_pending_heads() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");

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
fn claim_lifecycle_uses_leases_and_marks_terminal_state() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = AgentMessageStore::new(&connection).expect("store");
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
