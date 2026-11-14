use ads_contract::native_transcript::NativeTranscriptTurnStatus;
use ads_state::{
    AppendNativeTurn, BeginNativeTurn, NativeTranscriptStore, StateDb, StateError, UpdateNativeTurn,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn text(value: &Value) -> String {
    value.to_string()
}

#[test]
fn transcript_writer_lease_chunks_projection_and_completion_match_typescript() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = NativeTranscriptStore::new(&connection, &["known-secret".to_string()]);

    let cipher = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature";
    let messages = json!([
        {"role": "user", "content": "hello known-secret"},
        {
            "role": "assistant",
            "content": "ok",
            "authorization": "Bearer leaked",
            "nativeResponses": {
                "output": [{"type": "reasoning", "encrypted_content": cipher}]
            }
        }
    ]);
    let entries = json!([
        {"kind": "command", "toolCallId": "tool-1", "command": "echo known-secret", "status": "completed"},
        {"kind": "message", "message": {"role": "assistant", "content": "known-secret"}}
    ]);

    store
        .begin_turn(BeginNativeTurn {
            transcript_id: "transcript-1".to_string(),
            turn_id: "turn-1".to_string(),
            messages: messages.clone(),
            entries,
            provider: json!({"provider": "openai", "model": "gpt"}),
            writer_id: Some("writer-1".to_string()),
            incremental: false,
        })
        .expect("begin turn");

    let turns = store
        .list_turns("transcript-1", Some("writer-1"), false)
        .expect("list turns");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].turn_id, "turn-1");
    assert_eq!(turns[0].status, NativeTranscriptTurnStatus::Running);
    assert!(!text(&turns[0].messages).contains("known-secret"));
    assert!(text(&turns[0].messages).contains("[redacted]"));
    assert_eq!(
        turns[0].messages[1]["nativeResponses"]["output"][0]["encrypted_content"],
        json!(cipher)
    );
    assert_eq!(turns[0].messages[1]["authorization"], json!("[redacted]"));
    assert_eq!(turns[0].entries[0]["command"], json!("echo [redacted]"));
    assert_eq!(
        turns[0].provider.as_ref().expect("provider")["model"],
        json!("gpt")
    );
    assert!(
        store
            .has_continuation_messages("transcript-1")
            .expect("has continuation")
    );
    assert!(
        !store
            .has_completed_messages("transcript-1")
            .expect("has completed")
    );

    store
        .claim_transcript("transcript-1", "writer-2")
        .expect("claim newer writer");
    let superseded = store
        .update_turn(UpdateNativeTurn {
            transcript_id: "transcript-1".to_string(),
            turn_id: "turn-1".to_string(),
            status: NativeTranscriptTurnStatus::Completed,
            messages: messages.clone(),
            entries: json!([]),
            usage: None,
            error_message: None,
            writer_id: Some("writer-1".to_string()),
        })
        .expect_err("old writer rejected");
    assert!(matches!(
        superseded,
        StateError::NativeTranscriptWriterSuperseded
    ));
    let interrupted = store
        .list_turns("transcript-1", Some("writer-2"), false)
        .expect("list interrupted");
    assert_eq!(
        interrupted[0].status,
        NativeTranscriptTurnStatus::Interrupted
    );
    assert_eq!(
        interrupted[0].error_message.as_deref(),
        Some("Native turn was interrupted before completion.")
    );

    store
        .begin_turn(BeginNativeTurn {
            transcript_id: "transcript-1".to_string(),
            turn_id: "turn-2".to_string(),
            messages: json!([{"role": "user", "content": "incremental"}]),
            entries: json!([]),
            provider: json!({"provider": "openai", "model": "gpt"}),
            writer_id: Some("writer-2".to_string()),
            incremental: true,
        })
        .expect("begin incremental turn");
    store
        .append_turn(AppendNativeTurn {
            transcript_id: "transcript-1".to_string(),
            turn_id: "turn-2".to_string(),
            writer_id: "writer-2".to_string(),
            status: NativeTranscriptTurnStatus::Running,
            messages: json!([{"role": "assistant", "content": "chunk"}]),
            entries: json!([{"kind": "command", "toolCallId": "t", "command": "true", "status": "completed"}]),
            usage: Some(json!({"input_tokens": "12", "output_tokens": 3})),
            error_message: Some("failed with known-secret".to_string()),
            loop_guard: Some(json!({"count": 2})),
        })
        .expect("append turn");
    let appended = store
        .list_turns("transcript-1", Some("writer-2"), false)
        .expect("list appended");
    let turn = appended
        .iter()
        .find(|turn| turn.turn_id == "turn-2")
        .expect("turn-2");
    assert_eq!(turn.messages.as_array().expect("messages").len(), 2);
    assert_eq!(
        turn.usage.as_ref().expect("usage"),
        &json!({"input_tokens": 12, "output_tokens": 3})
    );
    assert_eq!(
        turn.error_message.as_deref(),
        Some("failed with [redacted]")
    );
    assert_eq!(
        store.load_loop_guard("transcript-1").expect("loop guard"),
        Some(json!({"count": 2}))
    );

    store
        .save_projection(
            "transcript-1",
            "turn-2",
            "writer-2",
            &json!([{"role": "assistant", "content": "projected"}]),
        )
        .expect("save projection");
    let projected = store
        .list_turns("transcript-1", Some("writer-2"), true)
        .expect("projected turns");
    let projected_turn = projected
        .iter()
        .find(|turn| turn.turn_id == "turn-2")
        .expect("turn-2 projection");
    assert_eq!(
        projected_turn.messages,
        json!([{"role": "assistant", "content": "projected"}])
    );
    assert_eq!(projected_turn.entries, json!([]));

    store
        .update_turn(UpdateNativeTurn {
            transcript_id: "transcript-1".to_string(),
            turn_id: "turn-2".to_string(),
            status: NativeTranscriptTurnStatus::Completed,
            messages: json!([{"role": "assistant", "content": "final"}]),
            entries: json!([{"kind": "file_change", "toolCallId": "t", "changes": []}]),
            usage: Some(json!({"total_tokens": 42})),
            error_message: None,
            writer_id: Some("writer-2".to_string()),
        })
        .expect("complete turn");
    let completed = store
        .list_turns("transcript-1", Some("writer-2"), false)
        .expect("completed turns");
    let completed_turn = completed
        .iter()
        .find(|turn| turn.turn_id == "turn-2")
        .expect("completed turn-2");
    assert_eq!(completed_turn.status, NativeTranscriptTurnStatus::Completed);
    assert_eq!(
        completed_turn.messages,
        json!([{"role": "assistant", "content": "final"}])
    );
    assert_eq!(
        completed_turn.usage.as_ref().expect("usage"),
        &json!({"total_tokens": 42})
    );
    assert_eq!(
        completed_turn.entries,
        json!([{"kind": "file_change", "toolCallId": "t", "changes": []}])
    );
    assert!(
        store
            .has_completed_messages("transcript-1")
            .expect("has completed")
    );
    assert_eq!(
        store
            .load_completed_messages("transcript-1", Some("writer-2"))
            .expect("completed messages"),
        json!([{"role": "assistant", "content": "final"}])
    );
    assert_eq!(
        store
            .load_loop_guard("transcript-1")
            .expect("cleared guard"),
        None
    );

    store
        .clear("transcript-1", Some("writer-2"))
        .expect("clear transcript");
    assert!(
        store
            .list_turns("transcript-1", Some("writer-2"), false)
            .expect("list after clear")
            .is_empty()
    );
}

#[test]
fn transcript_history_pages_chunks_and_hides_opaque_reasoning() {
    let directory = tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    let connection = db.connect().expect("connection");
    let store = NativeTranscriptStore::new(&connection, &[]);

    store
        .begin_turn(BeginNativeTurn {
            transcript_id: "history".to_string(),
            turn_id: "turn-1".to_string(),
            messages: json!([{
                "role": "assistant",
                "content": "x".repeat(15_000),
                "nativeResponses": {"output": [{"type": "reasoning", "encrypted_content": "cipher"}]}
            }]),
            entries: json!([
                {"kind": "message", "message": {"role": "assistant", "content": "hidden"}},
                {"kind": "command", "toolCallId": "t", "command": "echo", "status": "completed"}
            ]),
            provider: json!({"provider": "openai"}),
            writer_id: Some("writer".to_string()),
            incremental: true,
        })
        .expect("begin history turn");

    let first =
        serde_json::from_str::<Value>(&store.read_history("history", 0, 0).expect("first page"))
            .expect("first page json");
    assert_eq!(first["turn_id"], json!("turn-1"));
    assert_eq!(
        first["content"]
            .as_str()
            .expect("content")
            .encode_utf16()
            .count(),
        12_000
    );
    let next_offset = first["next"]["offset"].as_u64().expect("next offset");
    assert!(next_offset > 0);

    let second = serde_json::from_str::<Value>(
        &store
            .read_history("history", 0, next_offset as usize)
            .expect("second page"),
    )
    .expect("second page json");
    assert!(second["next"]["after"].as_i64().expect("next after") > 0);
    assert_eq!(second["next"]["offset"], json!(0));

    let chunk_id = second["next"]["after"].as_i64().expect("chunk id");
    let done = serde_json::from_str::<Value>(
        &store
            .read_history("history", chunk_id, 0)
            .expect("done page"),
    )
    .expect("done json");
    assert_eq!(done, json!({"done": true}));

    store
        .begin_turn(BeginNativeTurn {
            transcript_id: "visible".to_string(),
            turn_id: "visible-turn".to_string(),
            messages: json!([{
                "role": "assistant",
                "content": "visible",
                "nativeResponses": {"output": [{"type": "reasoning", "encrypted_content": "cipher"}]}
            }]),
            entries: json!([
                {"kind": "message", "message": {"role": "assistant", "content": "hidden"}},
                {"kind": "command", "toolCallId": "t", "command": "echo", "status": "completed"}
            ]),
            provider: json!({"provider": "openai"}),
            writer_id: Some("writer".to_string()),
            incremental: true,
        })
        .expect("begin visible turn");
    let visible = serde_json::from_str::<Value>(
        &store
            .read_history("visible", 0, 0)
            .expect("visible history"),
    )
    .expect("visible history json");
    let content = serde_json::from_str::<Value>(visible["content"].as_str().expect("content"))
        .expect("content json");
    assert!(content["messages"][0].get("nativeResponses").is_none());
    assert_eq!(content["entries"].as_array().expect("entries").len(), 1);
    assert_eq!(content["entries"][0]["kind"], json!("command"));
}
