use ads_state::{
    CancelPromptInput, EnqueuePromptInput, PromptIdentityDisposition, PromptQueueCancelReason,
    PromptQueueLane, PromptQueueStatus, PromptQueueStore, ReconcilePromptIdentitiesInput, StateDb,
    hash_prompt_queue_payload,
};
use serde_json::{Map, Value, json};
use tempfile::tempdir;

fn open_store() -> (tempfile::TempDir, StateDb, rusqlite::Connection) {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    (directory, db, connection)
}

fn lane(generation: i64) -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: "user-1".to_string(),
        session_id: "session-1".to_string(),
        chat_session_id: "main".to_string(),
        history_key: if generation > 1 {
            "user-1::session-1::main:generation:2".to_string()
        } else {
            "user-1::session-1::main".to_string()
        },
        logical_history_key: "user-1::session-1::main".to_string(),
        lane_namespace: "web-actions".to_string(),
        lane_generation: generation,
    }
}

fn payload(value: Value) -> Map<String, Value> {
    value.as_object().expect("object payload").clone()
}

fn prompt_input(id: &str, generation: i64, text: &str, now: i64) -> EnqueuePromptInput {
    EnqueuePromptInput {
        client_message_id: id.to_string(),
        lane: lane(generation),
        user_id: 42,
        workspace_root: "/work/ads".to_string(),
        payload: payload(json!({ "text": text, "images": [] })),
        retry_failed: false,
        retry_original: false,
        created_at: Some(now),
    }
}

#[test]
fn hashes_canonical_payloads_like_typescript() {
    assert_eq!(
        hash_prompt_queue_payload(&payload(json!({
            "z": 1,
            "a": { "b": 2, "c": [3, { "d": 4 }] },
            "replay_incomplete": true
        }))),
        "faa2fca02ad5e90c68e4eeaf7e53fc26b6d70fa8b21890b30c5592322513f4fd"
    );
    assert_eq!(
        hash_prompt_queue_payload(&payload(json!({
            "text": "你好 \"x\"\n",
            "n": 1.5,
            "ok": true,
            "nil": null
        }))),
        "2c9f59b83c81fcefec4417bfc7f2382f2f76ecbca7beef16500959c6e267d6bd"
    );
}

#[test]
fn enqueue_is_idempotent_and_preserves_fifo_positions() {
    let (_directory, _db, connection) = open_store();
    let store = PromptQueueStore::new(&connection).expect("store");

    let first = store
        .enqueue(prompt_input("cm-1", 1, "first", 100), 100)
        .expect("first prompt");
    assert!(!first.duplicate);
    assert_eq!(first.entry.status, PromptQueueStatus::Queued);
    assert_eq!(first.entry.created_at, 100);
    assert_eq!(first.entry.updated_at, 100);

    let duplicate = store
        .enqueue(prompt_input("cm-1", 1, "first", 200), 200)
        .expect("duplicate prompt");
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.entry.created_at, 100);
    assert_eq!(duplicate.entry.updated_at, 100);

    let changed = store
        .enqueue(prompt_input("cm-1", 1, "changed", 300), 300)
        .expect_err("payload change must be rejected");
    assert!(
        changed.to_string().contains("different prompt payload"),
        "unexpected error: {changed}"
    );

    store
        .enqueue(prompt_input("cm-2", 1, "second", 110), 110)
        .expect("second prompt");
    let entries = store.list_lane(&lane(1)).expect("lane entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].client_message_id, "cm-1");
    assert_eq!(entries[0].position, 1);
    assert_eq!(entries[1].client_message_id, "cm-2");
    assert_eq!(entries[1].position, 2);

    let logical = store.list_logical_lane(&lane(1)).expect("logical entries");
    assert_eq!(logical.len(), 2);
}

#[test]
fn cancellation_and_reconciliation_match_typescript_dispositions() {
    let (_directory, _db, connection) = open_store();
    let store = PromptQueueStore::new(&connection).expect("store");

    store
        .enqueue(prompt_input("cm-cancel", 1, "cancel me", 100), 100)
        .expect("queued prompt");
    let cancelled = store
        .cancel(
            CancelPromptInput {
                client_message_id: "cm-cancel".to_string(),
                lane: lane(1),
                user_id: 42,
            },
            120,
        )
        .expect("cancel");
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.reason, PromptQueueCancelReason::Cancelled);
    assert_eq!(
        cancelled.entry.expect("cancelled entry").status,
        PromptQueueStatus::Queued
    );
    assert!(
        store
            .get_by_client_message_id("cm-cancel")
            .expect("get cancelled")
            .is_none()
    );

    let repeated = store
        .cancel(
            CancelPromptInput {
                client_message_id: "cm-cancel".to_string(),
                lane: lane(1),
                user_id: 42,
            },
            130,
        )
        .expect("repeat cancel");
    assert!(!repeated.cancelled);
    assert_eq!(repeated.reason, PromptQueueCancelReason::AlreadyCancelled);

    store
        .enqueue(prompt_input("cm-run", 1, "run", 200), 200)
        .expect("queued prompt");
    let claim = store
        .claim_ownership("owner-1", 10, 200, 60_000, |_| true)
        .expect("claim");
    assert!(claim.claimed);
    let running = store
        .get_by_client_message_id("cm-run")
        .expect("get queued")
        .expect("queued entry");
    assert!(
        store
            .mark_running(running.id, "owner-1", 210, 60_000)
            .expect("mark running")
    );
    let not_queued = store
        .cancel(
            CancelPromptInput {
                client_message_id: "cm-run".to_string(),
                lane: lane(1),
                user_id: 42,
            },
            220,
        )
        .expect("cancel running");
    assert!(!not_queued.cancelled);
    assert_eq!(not_queued.reason, PromptQueueCancelReason::NotQueued);

    let before_failure = store
        .reconcile(ReconcilePromptIdentitiesInput {
            lane: lane(1),
            user_id: 42,
            client_message_ids: vec!["cm-run".to_string(), "missing".to_string()],
        })
        .expect("reconcile running");
    assert_eq!(
        before_failure[0].disposition,
        PromptIdentityDisposition::Consumed
    );
    assert_eq!(before_failure[0].retryable, None);
    assert_eq!(
        before_failure[1].disposition,
        PromptIdentityDisposition::Unknown
    );

    assert!(
        store
            .mark_failed(running.id, "boom", "owner-1", 230)
            .expect("mark failed")
    );
    let after_failure = store
        .reconcile(ReconcilePromptIdentitiesInput {
            lane: lane(1),
            user_id: 42,
            client_message_ids: vec!["cm-run".to_string()],
        })
        .expect("reconcile failed");
    assert_eq!(
        after_failure[0].disposition,
        PromptIdentityDisposition::Consumed
    );
    assert_eq!(after_failure[0].retryable, Some(true));

    store
        .enqueue(prompt_input("cm-old", 2, "old", 300), 300)
        .expect("old generation prompt");
    let old = store
        .reconcile(ReconcilePromptIdentitiesInput {
            lane: lane(1),
            user_id: 42,
            client_message_ids: vec!["cm-old".to_string(), "cm-cancel".to_string()],
        })
        .expect("reconcile old generation");
    assert_eq!(old[0].disposition, PromptIdentityDisposition::Obsolete);
    assert_eq!(old[1].disposition, PromptIdentityDisposition::Cancelled);
}

#[test]
fn retries_requeue_failed_attempts_without_replaying_completed_rows() {
    let (_directory, _db, connection) = open_store();
    let store = PromptQueueStore::new(&connection).expect("store");
    store
        .enqueue(prompt_input("cm-retry", 1, "retry", 100), 100)
        .expect("queued prompt");
    store
        .claim_ownership("owner-1", 10, 100, 60_000, |_| true)
        .expect("claim");

    let queued = store
        .get_by_client_message_id("cm-retry")
        .expect("get")
        .expect("entry");
    store
        .mark_running(queued.id, "owner-1", 110, 60_000)
        .expect("running");
    store
        .mark_failed(queued.id, "temporary", "owner-1", 120)
        .expect("failed");

    let mut retry = prompt_input("cm-retry", 1, "retry", 130);
    retry.retry_failed = true;
    let retried = store.enqueue(retry, 130).expect("retry failed prompt");
    assert!(!retried.duplicate);
    assert_eq!(retried.entry.status, PromptQueueStatus::Queued);
    assert_eq!(retried.entry.attempts, 0);
    assert_eq!(retried.entry.last_error, None);

    let mut original = prompt_input("cm-retry", 1, "retry", 140);
    original.retry_original = true;
    let rejected = store
        .enqueue(original, 140)
        .expect_err("identity-only retry requires retry_failed");
    assert!(
        rejected.to_string().contains("explicit replay request"),
        "unexpected error: {rejected}"
    );

    store
        .claim_ownership("owner-1", 10, 140, 60_000, |_| true)
        .expect("reclaim");
    let requeued = store
        .get_by_client_message_id("cm-retry")
        .expect("get requeued")
        .expect("requeued entry");
    store
        .mark_running(requeued.id, "owner-1", 150, 60_000)
        .expect("running again");
    store
        .mark_completed(requeued.id, "owner-1", 160)
        .expect("completed");
    let completed = store
        .get_by_client_message_id("cm-retry")
        .expect("get completed")
        .expect("completed entry");
    assert_eq!(completed.status, PromptQueueStatus::Completed);
    assert!(completed.payload.is_empty());

    let mut replay_completed = prompt_input("cm-retry", 1, "retry", 170);
    replay_completed.retry_failed = true;
    replay_completed.retry_original = true;
    let duplicate = store
        .enqueue(replay_completed, 170)
        .expect("completed identity stays terminal");
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.entry.status, PromptQueueStatus::Completed);
}

#[test]
fn explicit_original_retry_refreshes_controls_without_replacing_immutable_payload() {
    let (_directory, _db, connection) = open_store();
    let store = PromptQueueStore::new(&connection).expect("store");

    let mut initial = prompt_input("cm-controls", 1, "original prompt", 100);
    initial.payload = payload(json!({
        "text": "original prompt",
        "images": [{ "id": "attachment-1", "url": "/image.png" }],
        "agentId": "codex",
        "model": "model-a",
        "model_reasoning_effort": "low",
        "immutable": { "source": "original" }
    }));
    let original = store.enqueue(initial, 100).expect("original prompt");
    let original_hash = original.entry.payload_hash.clone();
    store
        .claim_ownership("owner-1", 10, 100, 60_000, |_| true)
        .expect("claim");
    let queued = store
        .get_by_client_message_id("cm-controls")
        .expect("get original")
        .expect("original entry");
    store
        .mark_running(queued.id, "owner-1", 110, 60_000)
        .expect("running");
    store
        .mark_failed(queued.id, "temporary", "owner-1", 120)
        .expect("failed");

    let mut retry = prompt_input("cm-controls", 1, "tampered prompt", 130);
    retry.payload = payload(json!({
        "text": "tampered prompt",
        "images": [{ "id": "tampered", "url": "/tampered.png" }],
        "agentId": "tampered-agent",
        "model": "model-b",
        "model_reasoning_effort": "xhigh",
        "replay_incomplete": true,
        "retry_original": true,
        "immutable": { "source": "tampered" }
    }));
    retry.retry_failed = true;
    retry.retry_original = true;
    let retried = store.enqueue(retry, 130).expect("retry original prompt");
    assert!(!retried.duplicate);
    assert_eq!(retried.entry.status, PromptQueueStatus::Queued);
    assert_eq!(retried.entry.payload["text"], "original prompt");
    assert_eq!(
        retried.entry.payload["images"],
        json!([{ "id": "attachment-1", "url": "/image.png" }])
    );
    assert_eq!(retried.entry.payload["agentId"], "codex");
    assert_eq!(
        retried.entry.payload["immutable"],
        json!({ "source": "original" })
    );
    assert_eq!(retried.entry.payload["model"], "model-b");
    assert_eq!(retried.entry.payload["modelReasoningEffort"], "xhigh");
    assert!(
        retried
            .entry
            .payload
            .get("model_reasoning_effort")
            .is_none()
    );
    assert_eq!(
        retried.entry.payload_hash,
        hash_prompt_queue_payload(&retried.entry.payload)
    );
    assert_ne!(retried.entry.payload_hash, original_hash);

    store
        .claim_ownership("owner-1", 10, 140, 60_000, |_| true)
        .expect("reclaim");
    let requeued = store
        .get_by_client_message_id("cm-controls")
        .expect("get retried")
        .expect("retried entry");
    store
        .mark_running(requeued.id, "owner-1", 150, 60_000)
        .expect("running again");
    store
        .mark_failed(requeued.id, "temporary again", "owner-1", 160)
        .expect("failed again");

    let mut second_retry = prompt_input("cm-controls", 1, "another tampered prompt", 170);
    second_retry.payload = payload(json!({
        "text": "another tampered prompt",
        "model": "model-c",
        "modelReasoningEffort": "high",
        "model_reasoning_effort": "stale-effort"
    }));
    second_retry.retry_failed = true;
    second_retry.retry_original = true;
    let retried_again = store
        .enqueue(second_retry, 170)
        .expect("retry with canonical effort");
    assert_eq!(retried_again.entry.payload["model"], "model-c");
    assert_eq!(retried_again.entry.payload["modelReasoningEffort"], "high");
    assert!(
        retried_again
            .entry
            .payload
            .get("model_reasoning_effort")
            .is_none()
    );

    store
        .claim_ownership("owner-1", 10, 180, 60_000, |_| true)
        .expect("reclaim again");
    let requeued_again = store
        .get_by_client_message_id("cm-controls")
        .expect("get retried again")
        .expect("retried entry again");
    store
        .mark_running(requeued_again.id, "owner-1", 190, 60_000)
        .expect("running third attempt");
    store
        .mark_failed(requeued_again.id, "temporary third time", "owner-1", 200)
        .expect("failed third time");

    let mut invalid_retry = prompt_input("cm-controls", 1, "invalid controls", 210);
    invalid_retry.payload = payload(json!({
        "text": "invalid controls",
        "model": 42,
        "modelReasoningEffort": "   ",
        "model_reasoning_effort": " low "
    }));
    invalid_retry.retry_failed = true;
    invalid_retry.retry_original = true;
    let retried_invalid = store
        .enqueue(invalid_retry, 210)
        .expect("ignore invalid retry controls");
    assert_eq!(retried_invalid.entry.payload["model"], "model-c");
    assert_eq!(retried_invalid.entry.payload["modelReasoningEffort"], "low");
    assert!(
        retried_invalid
            .entry
            .payload
            .get("model_reasoning_effort")
            .is_none()
    );
}

#[test]
fn ownership_leases_and_interrupted_rows_are_fenced_by_owner() {
    let (_directory, _db, connection) = open_store();
    let store = PromptQueueStore::new(&connection).expect("store");

    let first = store
        .claim_ownership("owner-1", 10, 1_000, 60_000, |_| true)
        .expect("first claim");
    assert!(first.claimed);
    assert_eq!(first.previous_owner_id, None);

    let blocked = store
        .claim_ownership("owner-2", 20, 1_100, 60_000, |_| true)
        .expect("blocked claim");
    assert!(!blocked.claimed);
    assert_eq!(blocked.previous_owner_id.as_deref(), Some("owner-1"));

    let taken_over = store
        .claim_ownership("owner-2", 20, 70_000, 60_000, |_| true)
        .expect("expired takeover");
    assert!(taken_over.claimed);
    assert_eq!(taken_over.previous_owner_id.as_deref(), Some("owner-1"));
    assert!(
        !store
            .is_ownership_current("owner-1", 70_000)
            .expect("stale owner check")
    );
    assert!(
        store
            .is_ownership_current("owner-2", 70_000)
            .expect("current owner check")
    );

    store
        .enqueue(
            prompt_input("cm-interrupted", 1, "interrupted", 70_100),
            70_100,
        )
        .expect("queued prompt");
    let queued = store
        .get_by_client_message_id("cm-interrupted")
        .expect("get")
        .expect("entry");
    store
        .mark_running(queued.id, "owner-2", 70_200, 60_000)
        .expect("running");
    let interrupted = store
        .list_interrupted(Some("owner-2"), 70_300)
        .expect("interrupted rows");
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0].client_message_id, "cm-interrupted");

    assert!(
        !store
            .complete_interrupted(queued.id, "owner-1", Some("owner-2"), 70_400)
            .expect("stale owner cannot complete")
    );
    assert!(
        store
            .fail_interrupted(queued.id, "owner-2", Some("owner-2"), "interrupted", 70_500)
            .expect("current owner fails interrupted")
    );
    let failed = store
        .get_by_client_message_id("cm-interrupted")
        .expect("get failed")
        .expect("failed entry");
    assert_eq!(failed.status, PromptQueueStatus::Failed);
    assert_eq!(failed.last_error.as_deref(), Some("interrupted"));

    assert!(
        store
            .release_ownership("owner-2")
            .expect("release ownership")
    );
    assert!(
        !store
            .is_ownership_current("owner-2", 70_600)
            .expect("released owner")
    );
}
