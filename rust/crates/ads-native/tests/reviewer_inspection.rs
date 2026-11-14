use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use ads_native::{
    Cancellation, NativeCompletion, NativeCompletionRequest, NativeModelConfig,
    NativeRequestOptions, NativeToolCall, ReviewVerdictStatus, ReviewerComplete, ReviewerError,
    ReviewerInspectionOptions, ReviewerInspectionTools, WireApi, run_reviewer_inspection,
};
use serde_json::{Value, json};
use tempfile::TempDir;

struct Repo {
    _directory: TempDir,
    path: PathBuf,
    commit: String,
}

fn git(repo: &PathBuf, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("git command");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn repository() -> Repo {
    let directory = tempfile::tempdir().expect("temp dir");
    let path = directory.path().to_path_buf();
    fs::write(path.join("src.ts"), "line one\nline two\nline three\n").expect("source");
    fs::create_dir_all(path.join("src/deep")).expect("src dir");
    fs::write(path.join("src/deep/file.ts"), "export const deep = true;\n").expect("deep file");
    fs::write(
        path.join("src/long.ts"),
        (1..=250)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("long file");
    fs::write(
        path.join("search.ts"),
        (1..=200)
            .map(|line| format!("export const needle_{line} = {line};"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("search file");
    fs::write(path.join("binary.dat"), b"abc\0def").expect("binary");
    fs::write(path.join("large.dat"), vec![b'a'; 1024 * 1024 + 1]).expect("large file");
    fs::write(path.join(".env"), "SECRET=value\n").expect("env");
    fs::write(path.join("secret.pem"), "-----BEGIN KEY-----\n").expect("pem");
    fs::create_dir_all(path.join("node_modules/dep")).expect("node_modules");
    fs::write(
        path.join("node_modules/dep/index.js"),
        "module.exports = 1;\n",
    )
    .expect("dep");
    fs::create_dir_all(path.join("dist")).expect("dist");
    fs::write(path.join("dist/bundle.js"), "bundle\n").expect("bundle");
    fs::create_dir_all(path.join("docs")).expect("docs");
    fs::write(path.join("docs/readme.md"), "# docs\n").expect("docs file");

    git(&path, &["init", "-q"]);
    git(&path, &["add", "-A"]);
    git(
        &path,
        &[
            "-c",
            "user.name=Reviewer Test",
            "-c",
            "user.email=reviewer@example.com",
            "commit",
            "-q",
            "-m",
            "initial",
        ],
    );
    let commit = git(&path, &["rev-parse", "HEAD"]);
    Repo {
        _directory: directory,
        path,
        commit,
    }
}

fn tools(repo: &Repo, diff: Option<String>) -> ReviewerInspectionTools {
    ReviewerInspectionTools::new(
        repo.path.clone(),
        repo.commit.clone(),
        Cancellation::new(),
        diff,
    )
    .expect("inspection tools")
}

fn call(name: &str, arguments: Value) -> NativeToolCall {
    NativeToolCall::new("call-1", name, arguments.to_string())
}

#[test]
fn rejects_invalid_commit_hashes() {
    let error =
        ReviewerInspectionTools::new(PathBuf::from("/tmp"), "abc", Cancellation::new(), None)
            .expect_err("invalid commit");
    assert!(error.to_string().contains("exact commit hash"));
}

#[tokio::test]
async fn lists_direct_children_and_excludes_secret_or_generated_files() {
    let repo = repository();
    let mut tools = tools(&repo, None);
    let root = tools
        .execute(&call("list_dir", json!({"path": "."})))
        .await
        .expect("list root");
    let root: Value = serde_json::from_str(&root).expect("root json");
    let entries = root["entries"].as_array().expect("entries");
    let names = entries.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    assert!(names.contains(&"src/"));
    assert!(names.contains(&"docs/"));
    assert!(!names.contains(&"node_modules/"));
    assert!(!names.contains(&"dist/"));
    assert!(!names.iter().any(|name| name.starts_with(".env")));
    assert!(!names.contains(&"secret.pem"));

    let src = tools
        .execute(&call("list_dir", json!({"path": "src"})))
        .await
        .expect("list src");
    let src: Value = serde_json::from_str(&src).expect("src json");
    let names = src["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    assert!(names.contains(&"deep/"));
    assert!(names.contains(&"long.ts"));
    assert!(!names.contains(&"../"));
}

#[tokio::test]
async fn reads_file_ranges_and_rejects_unsafe_or_oversized_evidence() {
    let repo = repository();
    let mut tools = tools(&repo, None);
    let output = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "src.ts", "start_line": 1, "end_line": 2}),
        ))
        .await
        .expect("range");
    assert_eq!(output, "1: line one\n2: line two");
    let clamped = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "src.ts", "start_line": 2, "end_line": 99}),
        ))
        .await
        .expect("clamped");
    assert_eq!(clamped, "2: line two\n3: line three");

    let past_eof = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "src.ts", "start_line": 9, "end_line": 10}),
        ))
        .await
        .expect("past eof");
    assert!(past_eof.contains("start_line is past EOF"));
    let oversized = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "src/long.ts", "start_line": 1, "end_line": 250}),
        ))
        .await
        .expect("oversized range");
    assert!(oversized.contains("Read at most 200 lines"));
    let traversal = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "../etc/passwd", "start_line": 1, "end_line": 1}),
        ))
        .await
        .expect("traversal");
    assert!(traversal.contains("workspace-relative path"));
    let secret = tools
        .execute(&call(
            "read_file_range",
            json!({"path": ".env", "start_line": 1, "end_line": 1}),
        ))
        .await
        .expect("secret");
    assert!(secret.contains("excluded by inspection policy"));
    let binary = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "binary.dat", "start_line": 1, "end_line": 1}),
        ))
        .await
        .expect("binary");
    assert!(binary.contains("Binary files cannot be inspected"));
    let too_large = tools
        .execute(&call(
            "read_file_range",
            json!({"path": "large.dat", "start_line": 1, "end_line": 1}),
        ))
        .await
        .expect("large file");
    assert!(too_large.contains("1 MiB inspection limit"));
}

#[tokio::test]
async fn searches_literal_text_with_stable_paging() {
    let repo = repository();
    let mut tools = tools(&repo, None);
    let mut offset = 0usize;
    let mut content = String::new();
    let mut pages = 0usize;
    loop {
        pages += 1;
        let page = tools
            .execute(&call(
                "search_code",
                json!({"query": "needle", "path_pattern": "**/*.ts", "offset": offset}),
            ))
            .await
            .expect("search page");
        let page: Value = serde_json::from_str(&page).expect("page json");
        assert_eq!(page["offset"].as_u64(), Some(offset as u64));
        let piece = page["content"].as_str().expect("content").to_string();
        let next = page["next_offset"].as_u64().expect("next") as usize;
        let total = page["total_chars"].as_u64().expect("total") as usize;
        assert!(next >= offset);
        content.push_str(&piece);
        if page["done"].as_bool() == Some(true) {
            assert_eq!(next, total);
            break;
        }
        assert!(next > offset, "paging must advance");
        offset = next;
        assert!(pages < 100, "paging must terminate");
    }
    assert!(pages > 1, "search should require paging");
    assert!(content.contains("needle_1"));
    assert!(!content.contains("readme.md"));
}

#[tokio::test]
async fn pages_the_captured_diff_and_tracks_completion() {
    let repo = repository();
    let diff = (0..2_000)
        .map(|line| format!("+ line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut tools = tools(&repo, Some(diff.clone()));
    let mut offset = 0usize;
    let mut read = String::new();
    loop {
        let page = tools
            .execute(&call("read_diff", json!({"offset": offset})))
            .await
            .expect("diff page");
        let page: Value = serde_json::from_str(&page).expect("page json");
        read.push_str(page["content"].as_str().expect("content"));
        let next = page["next_offset"].as_u64().expect("next") as usize;
        if page["done"].as_bool() == Some(true) {
            break;
        }
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(read, diff);
    assert!(tools.has_read_full_diff());
    assert_eq!(
        tools.diff_progress(),
        Some((diff.encode_utf16().count(), diff.encode_utf16().count()))
    );
}

#[tokio::test]
async fn rejects_invalid_arguments_unknown_tools_and_snapshot_failures() {
    let repo = repository();
    let mut tools = tools(&repo, None);
    let invalid = tools
        .execute(&NativeToolCall::new("call", "read_diff", "not json"))
        .await
        .expect("invalid args");
    assert!(invalid.contains("Tool arguments must be valid JSON"));
    let extra = tools
        .execute(&call("read_diff", json!({"offset": 0, "extra": true})))
        .await
        .expect("extra key");
    assert!(extra.contains("Unrecognized key"));
    let oversized_arguments = tools
        .execute(&NativeToolCall::new("call", "read_diff", "x".repeat(4_097)))
        .await
        .expect("oversized args");
    assert!(oversized_arguments.contains("4096-character limit"));
    let denied = tools
        .execute(&call("exec_command", json!({})))
        .await
        .expect("unknown tool");
    assert!(denied.starts_with("Tool denied:"));

    let mut missing =
        ReviewerInspectionTools::new(repo.path.clone(), "a".repeat(40), Cancellation::new(), None)
            .expect("tools");
    let unavailable = missing
        .execute(&call("list_dir", json!({"path": "."})))
        .await
        .expect("snapshot failure");
    assert!(unavailable.starts_with("Inspection snapshot unavailable:"));
    assert!(missing.has_unavailable_snapshot());
}

fn model() -> NativeModelConfig {
    NativeModelConfig {
        model: "fake-model".to_string(),
        base_url: "http://127.0.0.1:1/v1".to_string(),
        api_key: "test-key".to_string(),
        provider: "test".to_string(),
        wire_api: WireApi::Chat,
        context_window: Some(200_000),
        options: NativeRequestOptions {
            max_tokens: Some(2_000),
            ..Default::default()
        },
        capabilities: Default::default(),
    }
}

fn completion(text: &str, tool_calls: Vec<NativeToolCall>) -> NativeCompletion {
    NativeCompletion {
        text: text.to_string(),
        finish_reason: Some(
            if tool_calls.is_empty() {
                "stop"
            } else {
                "tool_calls"
            }
            .to_string(),
        ),
        tool_calls,
        usage: None,
        native_responses: None,
    }
}

fn scripted(
    responses: Vec<NativeCompletion>,
) -> (ReviewerComplete, Arc<Mutex<Vec<NativeCompletionRequest>>>) {
    let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_clone = Arc::clone(&captured);
    let complete: ReviewerComplete = Arc::new(move |request| {
        captured_clone.lock().expect("requests").push(request);
        let response = queue
            .lock()
            .expect("responses")
            .pop_front()
            .expect("scripted completion");
        Box::pin(async move { Ok(response) })
    });
    (complete, captured)
}

fn options(
    repo: &Repo,
    diff: Option<String>,
    complete: ReviewerComplete,
) -> ReviewerInspectionOptions {
    ReviewerInspectionOptions {
        workspace: repo.path.clone(),
        commit: repo.commit.clone(),
        prompt: "review this change".to_string(),
        system_prompt: "system".to_string(),
        model: model(),
        profile_id: "reviewer-1".to_string(),
        cancellation: Cancellation::new(),
        tool_turn_budget: None,
        diff,
        complete: Some(complete),
    }
}

#[tokio::test]
async fn runs_read_only_inspection_and_returns_a_verdict() {
    let repo = repository();
    let (complete, requests) = scripted(vec![
        completion(
            "",
            vec![NativeToolCall::new(
                "call-1",
                "read_file_range",
                json!({"path": "src.ts", "start_line": 1, "end_line": 1}).to_string(),
            )],
        ),
        completion(
            r#"{"status":"PASS","summary":"Looks good","defects":[]}"#,
            Vec::new(),
        ),
    ]);
    let verdict = run_reviewer_inspection(options(&repo, None, complete))
        .await
        .expect("verdict");
    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    assert_eq!(verdict.reviewer_profile_id.as_deref(), Some("reviewer-1"));
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .tools
            .iter()
            .any(|tool| tool.function.name == "read_diff")
    );
    assert!(requests[1].messages.iter().any(|message| {
        message.role == "tool" && message.text_content().contains("1: line one")
    }));
}

#[tokio::test]
async fn requires_the_full_paged_diff_before_accepting_a_verdict() {
    let repo = repository();
    let diff = (0..1_501).map(|_| "x").collect::<Vec<_>>().join("\n");
    let (complete, requests) = scripted(vec![
        completion(
            r#"{"status":"PASS","summary":"premature","defects":[]}"#,
            Vec::new(),
        ),
        completion(
            "",
            vec![NativeToolCall::new(
                "call-1",
                "read_diff",
                json!({"offset": 0}).to_string(),
            )],
        ),
        completion(
            r#"{"status":"PASS","summary":"reviewed","defects":[]}"#,
            Vec::new(),
        ),
    ]);
    let verdict = run_reviewer_inspection(options(&repo, Some(diff), complete))
        .await
        .expect("verdict");
    assert_eq!(verdict.status, ReviewVerdictStatus::Pass);
    let requests = requests.lock().expect("requests");
    assert_eq!(requests.len(), 3);
    assert!(requests[1].messages.iter().any(|message| {
        message.role == "user" && message.text_content().contains("not fully inspected")
    }));
    assert!(requests[2].messages.iter().any(|message| {
        message.role == "tool" && message.text_content().contains("\"done\":true")
    }));
}

#[tokio::test]
async fn stops_for_incomplete_or_invalid_verdicts() {
    let repo = repository();
    let (incomplete, _) = scripted(vec![completion(
        r#"{"status":"INCOMPLETE","summary":"Evidence gap","defects":[]}"#,
        Vec::new(),
    )]);
    let error = run_reviewer_inspection(options(&repo, None, incomplete))
        .await
        .expect_err("incomplete");
    assert!(matches!(error, ReviewerError::Incomplete(_)));

    let (invalid, _) = scripted(vec![completion("not a verdict", Vec::new())]);
    let error = run_reviewer_inspection(options(&repo, None, invalid))
        .await
        .expect_err("invalid");
    assert_eq!(error, ReviewerError::InvalidVerdictJson);
}

#[tokio::test]
async fn disables_tools_when_the_turn_budget_is_zero() {
    let repo = repository();
    let (complete, requests) = scripted(vec![completion(
        "",
        vec![NativeToolCall::new(
            "call-1",
            "read_file_range",
            json!({"path": "src.ts", "start_line": 1, "end_line": 1}).to_string(),
        )],
    )]);
    let mut options = options(&repo, None, complete);
    options.tool_turn_budget = Some(0);
    let error = run_reviewer_inspection(options)
        .await
        .expect_err("tools disabled");
    assert!(
        matches!(error, ReviewerError::Protocol(message) if message.contains("inspection was disabled"))
    );
    assert!(requests.lock().expect("requests")[0].tools.is_empty());
}

#[tokio::test]
async fn returns_cancelled_before_calling_the_model() {
    let repo = repository();
    let (complete, requests) = scripted(Vec::new());
    let options = options(&repo, None, complete);
    options.cancellation.cancel();
    let error = run_reviewer_inspection(options)
        .await
        .expect_err("cancelled");
    assert_eq!(error, ReviewerError::Cancelled);
    assert!(requests.lock().expect("requests").is_empty());
}
