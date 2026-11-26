use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_codex_app_server::{
    CodexAppServerClient, CodexAppServerDaemonRegistry, CodexReviewRequest, SpawnOptions,
    run_codex_review,
};
use ads_native::Cancellation;
use ads_reviewer::{
    ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewVerdictStatus, ReviewVerificationReport,
    ReviewerError,
};
use ads_state::{ROLE_REVIEWER, SaveRoleProfile, StateDb, save_role_profile};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf, split,
};
use tokio::sync::Mutex;

struct ServerSide {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

impl ServerSide {
    async fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line).await {
            Ok(0) | Err(_) => None,
            Ok(_) => serde_json::from_str(line.trim()).ok(),
        }
    }

    async fn write(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .expect("server write");
        self.writer.flush().await.expect("server flush");
    }

    async fn respond(&mut self, id: &Value, result: Value) {
        self.write(json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await;
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.write(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await;
    }
}

fn setup_state_db(dir: &std::path::Path) -> StateDb {
    let db = StateDb::open(dir.join("state.db")).expect("open state db");
    let mut connection = db.connect().expect("connect");
    save_role_profile(
        &mut connection,
        SaveRoleProfile {
            id: "profile-default-reviewer",
            role: ROLE_REVIEWER,
            name: "Default Reviewer",
            model_id: "gpt-test",
            reasoning_effort: "high",
            system_prompt: "You are a detached clean-room Reviewer.",
            is_enabled: true,
            is_default: true,
        },
        1_000,
    )
    .expect("save reviewer profile");
    db
}

fn sample_payload() -> ReviewPayload {
    ReviewPayload {
        issue: ReviewIssue {
            id: Some(703),
            title: "Route Actions Reviewer through active runtime".to_string(),
            description: Some("Review runtime unification".to_string()),
            acceptance_criteria: Some(vec!["All tests pass".to_string()]),
        },
        diff: "diff --git a/src/lib.rs b/src/lib.rs\n+fn ok() {}".to_string(),
        diff_range: Some(ReviewDiffRange {
            base_ref: "dev".to_string(),
            head_ref: "HEAD".to_string(),
            range: "dev...HEAD".to_string(),
            base_commit: Some("a".repeat(40)),
            head_commit: Some("b".repeat(40)),
        }),
        ..ReviewPayload::default()
    }
}

fn fake_reviewer_registry(
    captured_requests: Arc<Mutex<Vec<Value>>>,
    captured_approvals: Arc<Mutex<Vec<(String, Value)>>>,
    final_response: String,
    emit_commands: bool,
) -> Arc<CodexAppServerDaemonRegistry> {
    CodexAppServerDaemonRegistry::with_factory(move |_: SpawnOptions| {
        let captured_requests = Arc::clone(&captured_requests);
        let captured_approvals = Arc::clone(&captured_approvals);
        let final_response = final_response.clone();
        Box::pin(async move {
            let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
            let (client_reader, client_writer) = split(client_stream);
            let (server_reader, server_writer) = split(server_stream);
            let mut server = ServerSide {
                reader: BufReader::new(server_reader),
                writer: server_writer,
            };
            tokio::spawn(async move {
                while let Some(message) = server.read().await {
                    if message.get("method").is_none() && message.get("id").is_some() {
                        let id = message["id"]
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| message["id"].to_string());
                        captured_approvals
                            .lock()
                            .await
                            .push((id, message["result"].clone()));
                        continue;
                    }
                    captured_requests.lock().await.push(message.clone());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "userAgent": "fake",
                                        "codexHome": "/tmp/codex-home",
                                        "platformFamily": "unix",
                                        "platformOs": "linux"
                                    }),
                                )
                                .await;
                        }
                        "thread/start" => {
                            server
                                .respond(
                                    &message["id"],
                                    json!({
                                        "thread": {"id": "thread-review-1"},
                                        "sandbox": {"type": "workspaceWrite", "networkAccess": false},
                                        "approvalPolicy": "untrusted"
                                    }),
                                )
                                .await;
                        }
                        "turn/start" => {
                            server.respond(&message["id"], json!({})).await;
                            server
                                .notify(
                                    "turn/started",
                                    json!({"threadId": "thread-review-1", "turnId": "turn-1"}),
                                )
                                .await;
                            if emit_commands {
                                for (id, method, params) in [
                                    (
                                        "req-file-change",
                                        "item/fileChange/requestApproval",
                                        json!({
                                            "threadId": "thread-review-1",
                                            "turnId": "turn-1",
                                            "itemId": "file-1"
                                        }),
                                    ),
                                    (
                                        "req-git-commit",
                                        "item/commandExecution/requestApproval",
                                        json!({
                                            "threadId": "thread-review-1",
                                            "turnId": "turn-1",
                                            "itemId": "cmd-mutating",
                                            "command": "git commit -m 'bad'"
                                        }),
                                    ),
                                    (
                                        "req-cargo-test",
                                        "item/commandExecution/requestApproval",
                                        json!({
                                            "threadId": "thread-review-1",
                                            "turnId": "turn-1",
                                            "itemId": "cmd-test",
                                            "command": "/bin/bash -lc 'CARGO_BUILD_JOBS=2 cargo test -p ads-actions'"
                                        }),
                                    ),
                                ] {
                                    server
                                        .write(json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "method": method,
                                            "params": params
                                        }))
                                        .await;
                                }
                                // Wait for the 3 approval responses before completing the turn.
                                let mut received = 0usize;
                                while received < 3 {
                                    if let Some(reply) = server.read().await {
                                        if reply.get("method").is_none()
                                            && reply.get("id").is_some()
                                        {
                                            let id = reply["id"]
                                                .as_str()
                                                .map(str::to_string)
                                                .unwrap_or_else(|| reply["id"].to_string());
                                            captured_approvals
                                                .lock()
                                                .await
                                                .push((id, reply["result"].clone()));
                                            received += 1;
                                        }
                                    } else {
                                        break;
                                    }
                                }
                                // Pure inspection command should NOT be recorded as verification.
                                server
                                    .notify(
                                        "item/completed",
                                        json!({
                                            "threadId": "thread-review-1",
                                            "turnId": "turn-1",
                                            "item": {
                                                "type": "commandExecution",
                                                "id": "cmd-inspect",
                                                "command": "git diff origin/dev...HEAD",
                                                "status": "completed",
                                                "exitCode": 0,
                                                "aggregatedOutput": "diff --git ..."
                                            }
                                        }),
                                    )
                                    .await;
                                // Actual verification command SHOULD be recorded.
                                server
                                    .notify(
                                        "item/completed",
                                        json!({
                                            "threadId": "thread-review-1",
                                            "turnId": "turn-1",
                                            "item": {
                                                "type": "commandExecution",
                                                "id": "cmd-test",
                                                "command": "/bin/bash -lc 'CARGO_BUILD_JOBS=2 cargo test -p ads-actions'",
                                                "status": "completed",
                                                "exitCode": 0,
                                                "aggregatedOutput": "test result: ok. 34 passed; 0 failed"
                                            }
                                        }),
                                    )
                                    .await;
                            }
                            server
                                .notify(
                                    "item/completed",
                                    json!({
                                        "threadId": "thread-review-1",
                                        "turnId": "turn-1",
                                        "item": {
                                            "type": "agentMessage",
                                            "id": "msg-1",
                                            "text": final_response
                                        }
                                    }),
                                )
                                .await;
                            server
                                .notify(
                                    "turn/completed",
                                    json!({
                                        "threadId": "thread-review-1",
                                        "turn": {"id": "turn-1", "status": "completed"}
                                    }),
                                )
                                .await;
                        }
                        _ => {}
                    }
                }
            });
            Ok(CodexAppServerClient::from_io(client_reader, client_writer))
        })
    })
}

#[tokio::test]
async fn codex_reviewer_enforces_review_boundaries_and_captures_verification() {
    let dir = tempdir().expect("tempdir");
    let db = setup_state_db(dir.path());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let approvals = Arc::new(Mutex::new(Vec::new()));
    let registry = fake_reviewer_registry(
        Arc::clone(&requests),
        Arc::clone(&approvals),
        r#"{"status":"PASS","summary":"Verified clean-room pass","defects":[]}"#.to_string(),
        true,
    );
    let verification_report = Arc::new(StdMutex::new(ReviewVerificationReport::default()));

    let verdict = run_codex_review(CodexReviewRequest {
        db,
        payload: sample_payload(),
        repo_path: dir.path().to_path_buf(),
        profile_id: None,
        job_id: "job-703".to_string(),
        owner: "user-1".to_string(),
        timeout: Duration::from_secs(10),
        cancellation: Cancellation::new(),
        verification_report: Arc::clone(&verification_report),
        daemon_options: SpawnOptions::default(),
        registry: Some(registry),
    })
    .await
    .expect("pass verdict");

    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    assert_eq!(verdict.summary, "Verified clean-room pass");
    assert_eq!(
        verdict.reviewer_profile_id.as_deref(),
        Some("profile-default-reviewer")
    );

    let sent = requests.lock().await;
    let thread_start = sent
        .iter()
        .find(|msg| msg["method"] == "thread/start")
        .expect("thread/start");
    assert_eq!(
        thread_start["params"]["dynamicTools"]
            .as_array()
            .map(Vec::len),
        Some(0),
        "review mode must not expose review_action"
    );
    assert_eq!(
        thread_start["params"]["developerInstructions"].as_str(),
        Some("You are a detached clean-room Reviewer.")
    );

    let decisions = approvals.lock().await;
    let find_decision = |id: &str| {
        decisions
            .iter()
            .find(|(req_id, _)| req_id == id)
            .and_then(|(_, res)| res["decision"].as_str())
    };
    assert_eq!(find_decision("req-file-change"), Some("decline"));
    assert_eq!(find_decision("req-git-commit"), Some("decline"));
    assert_eq!(find_decision("req-cargo-test"), Some("accept"));

    let report = verification_report.lock().expect("report").clone();
    assert_eq!(report.commands.len(), 1);
    assert!(report.commands[0].command.contains("cargo test"));
    assert_eq!(report.commands[0].exit_code, 0);
    assert!(report.has_successful_command());
}

#[tokio::test]
async fn codex_reviewer_preserves_incomplete_summary() {
    let dir = tempdir().expect("tempdir");
    let db = setup_state_db(dir.path());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let approvals = Arc::new(Mutex::new(Vec::new()));
    let registry = fake_reviewer_registry(
        requests,
        approvals,
        r#"{"status":"INCOMPLETE","summary":"Cannot run integration suite without fixture database","defects":[]}"#.to_string(),
        false,
    );
    let verification_report = Arc::new(StdMutex::new(ReviewVerificationReport::default()));

    let error = run_codex_review(CodexReviewRequest {
        db,
        payload: sample_payload(),
        repo_path: dir.path().to_path_buf(),
        profile_id: None,
        job_id: "job-703-incomplete".to_string(),
        owner: "user-1".to_string(),
        timeout: Duration::from_secs(10),
        cancellation: Cancellation::new(),
        verification_report,
        daemon_options: SpawnOptions::default(),
        registry: Some(registry),
    })
    .await
    .expect_err("incomplete error");

    assert_eq!(
        error,
        ReviewerError::Incomplete(
            "Cannot run integration suite without fixture database".to_string()
        )
    );
}
