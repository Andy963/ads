use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use ads_reviewer::{
    ReviewCaptureOptions, ReviewDiffOverride, ReviewGitResult, ReviewIssue, ReviewTarget,
    capture_review_payload_async, capture_review_payload_with,
};
use serde_json::Value;

const BASE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn target(require_pinned: bool) -> ReviewTarget {
    ReviewTarget {
        issue: ReviewIssue {
            id: Some(7),
            title: "Review".to_string(),
            description: Some("Description".to_string()),
            acceptance_criteria: Some(vec!["Criterion".to_string()]),
        },
        adrs: None,
        base_ref: "base".to_string(),
        head_ref: "head".to_string(),
        base_commit: require_pinned.then(|| BASE.to_string()),
        head_commit: require_pinned.then(|| HEAD.to_string()),
    }
}

fn options(require_pinned: bool) -> ReviewCaptureOptions {
    ReviewCaptureOptions {
        require_pinned_evidence: require_pinned,
        test_report: None,
        diff_override: None,
    }
}

fn success(stdout: &str) -> Option<ReviewGitResult> {
    Some(ReviewGitResult::success(stdout))
}

fn failure(status: i32) -> Option<ReviewGitResult> {
    Some(ReviewGitResult::failure(Some(status), "failed"))
}

#[tokio::test]
async fn unpinned_capture_uses_ref_range_and_collects_diff() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorder = calls.clone();
    let git = move |args: Vec<String>| {
        recorder.lock().expect("calls").push(args.clone());
        let result = match args.as_slice() {
            [command, flag, reference] if command == "rev-parse" && flag == "--verify" => {
                if reference.starts_with("base") {
                    success(BASE)
                } else {
                    success(HEAD)
                }
            }
            [command, range] if command == "diff" => success("diff --git a/a b/a\n+one\n"),
            [command, flag, _range] if command == "diff" && flag == "--stat" => {
                success(" a | 1 +\n")
            }
            _ => panic!("unexpected git call: {args:?}"),
        };
        std::future::ready(result)
    };

    let payload = capture_review_payload_with(&target(false), &options(false), git).await;

    assert_eq!(payload.diff_capture_error, None);
    assert_eq!(payload.diff, "diff --git a/a b/a\n+one\n");
    assert_eq!(payload.diff_stat.as_deref(), Some(" a | 1 +\n"));
    let range = payload.diff_range.expect("range");
    assert_eq!(range.base_ref, "base");
    assert_eq!(range.head_ref, "head");
    assert_eq!(range.range, "base...head");
    assert_eq!(range.base_commit.as_deref(), Some(BASE));
    assert_eq!(range.head_commit.as_deref(), Some(HEAD));
    let calls = calls.lock().expect("calls");
    assert_eq!(calls.len(), 4);
    assert_eq!(
        calls[2],
        vec!["diff".to_string(), format!("{BASE}...{HEAD}")]
    );
    assert_eq!(
        calls[3],
        vec![
            "diff".to_string(),
            "--stat".to_string(),
            format!("{BASE}...{HEAD}")
        ]
    );
}

#[tokio::test]
async fn pinned_capture_uses_exact_commits_and_checks_ancestry() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorder = calls.clone();
    let git = move |args: Vec<String>| {
        recorder.lock().expect("calls").push(args.clone());
        let result = match args.as_slice() {
            [command, flag, _reference] if command == "rev-parse" && flag == "--verify" => {
                success(if args[2].starts_with(BASE) {
                    BASE
                } else {
                    HEAD
                })
            }
            [command, flag, _base, _head] if command == "merge-base" && flag == "--is-ancestor" => {
                success("")
            }
            [command, range] if command == "diff" => {
                assert_eq!(range, &format!("{BASE}..{HEAD}"));
                success("diff --git a/a b/a\n+one\n")
            }
            [command, flag, _range] if command == "diff" && flag == "--stat" => {
                success(" a | 1 +\n")
            }
            _ => panic!("unexpected git call: {args:?}"),
        };
        std::future::ready(result)
    };

    let payload = capture_review_payload_with(&target(true), &options(true), git).await;

    assert_eq!(payload.diff_capture_error, None);
    let range = payload.diff_range.expect("range");
    assert_eq!(range.range, format!("{BASE}..{HEAD}"));
    assert_eq!(range.base_commit.as_deref(), Some(BASE));
    assert_eq!(range.head_commit.as_deref(), Some(HEAD));
    assert_eq!(calls.lock().expect("calls").len(), 5);
}

#[tokio::test]
async fn pinned_capture_without_commits_reports_ordered_errors() {
    let git = |args: Vec<String>| {
        panic!("git must not run for missing pinned evidence: {args:?}");
        #[allow(unreachable_code)]
        std::future::ready(None::<ReviewGitResult>)
    };
    let target = ReviewTarget {
        base_commit: None,
        head_commit: None,
        ..target(true)
    };

    let payload = capture_review_payload_with(&target, &options(true), git).await;

    assert_eq!(
        payload.diff_capture_error.as_deref(),
        Some(
            "review target does not have a recorded base commit; review target does not have a pinned head commit; git rev-parse base '<missing-base>' failed; git rev-parse review head failed; git diff exited with status unavailable; git diff --stat exited with status unavailable; git diff returned empty output; git diff --stat returned empty output; git rev-parse base returned an invalid commit: <empty>; git rev-parse review head returned an invalid commit: <empty>"
        )
    );
    let range = payload.diff_range.expect("range");
    assert_eq!(range.range, "<missing-base>..<missing-head>");
}

#[tokio::test]
async fn pinned_capture_reports_non_ancestor_and_failed_commands() {
    let git = |args: Vec<String>| {
        let result = match args.as_slice() {
            [command, flag, _reference] if command == "rev-parse" && flag == "--verify" => {
                success(if args[2].starts_with(BASE) {
                    BASE
                } else {
                    HEAD
                })
            }
            [command, flag, _base, _head] if command == "merge-base" && flag == "--is-ancestor" => {
                failure(1)
            }
            [command, range] if command == "diff" => {
                assert_eq!(range, &format!("{BASE}..{HEAD}"));
                failure(128)
            }
            [command, flag, _range] if command == "diff" && flag == "--stat" => failure(128),
            _ => panic!("unexpected git call: {args:?}"),
        };
        std::future::ready(result)
    };

    let payload = capture_review_payload_with(&target(true), &options(true), git).await;

    assert_eq!(
        payload.diff_capture_error.as_deref(),
        Some(
            "recorded base commit is not an ancestor of the pinned head; git diff exited with status 128; git diff --stat exited with status 128; git diff returned empty output; git diff --stat returned empty output"
        )
    );
}

#[tokio::test]
async fn invalid_or_empty_evidence_is_rejected() {
    let git = |args: Vec<String>| {
        let result = match args.as_slice() {
            [command, flag, _reference] if command == "rev-parse" && flag == "--verify" => {
                if args[2].starts_with("base") {
                    success("")
                } else {
                    success(HEAD)
                }
            }
            [command, range] if command == "diff" => {
                assert_eq!(range, &format!("base...{HEAD}"));
                success(" \n")
            }
            [command, flag, _range] if command == "diff" && flag == "--stat" => success("\n"),
            _ => panic!("unexpected git call: {args:?}"),
        };
        std::future::ready(result)
    };

    let payload = capture_review_payload_with(&target(false), &options(false), git).await;

    assert_eq!(
        payload.diff_capture_error.as_deref(),
        Some(
            "git diff exited with status unavailable; git diff --stat exited with status unavailable; git diff returned empty output; git diff --stat returned empty output; git rev-parse base returned an invalid commit: <empty>"
        )
    );
    assert_eq!(payload.diff_range.expect("range").base_commit, None);
}

#[tokio::test]
async fn diff_override_skips_git_diff_but_resolves_commits() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorder = calls.clone();
    let git = move |args: Vec<String>| {
        recorder.lock().expect("calls").push(args.clone());
        let result = match args.as_slice() {
            [command, flag, _reference] if command == "rev-parse" && flag == "--verify" => {
                success(if args[2].starts_with(BASE) {
                    BASE
                } else {
                    HEAD
                })
            }
            [command, flag, _base, _head] if command == "merge-base" && flag == "--is-ancestor" => {
                success("")
            }
            _ => panic!("unexpected git call: {args:?}"),
        };
        std::future::ready(result)
    };
    let options = ReviewCaptureOptions {
        require_pinned_evidence: true,
        test_report: None,
        diff_override: Some(ReviewDiffOverride {
            diff: "override diff".to_string(),
            diff_stat: " override | 1 +\n".to_string(),
            range: Some("custom-range".to_string()),
        }),
    };

    let payload = capture_review_payload_with(&target(true), &options, git).await;

    assert_eq!(payload.diff_capture_error, None);
    assert_eq!(payload.diff, "override diff");
    assert_eq!(
        payload.diff_range.expect("range").range,
        "custom-range".to_string()
    );
    assert_eq!(calls.lock().expect("calls").len(), 3);
}

#[tokio::test]
async fn spawn_failures_report_unavailable_status() {
    let git = |_args: Vec<String>| std::future::ready(None::<ReviewGitResult>);

    let payload = capture_review_payload_with(&target(false), &options(false), git).await;

    assert_eq!(
        payload.diff_capture_error.as_deref(),
        Some(
            "git rev-parse base 'base' failed; git rev-parse review head failed; git diff exited with status unavailable; git diff --stat exited with status unavailable; git diff returned empty output; git diff --stat returned empty output; git rev-parse base returned an invalid commit: <empty>; git rev-parse review head returned an invalid commit: <empty>"
        )
    );
}

#[tokio::test]
async fn default_runner_captures_a_real_repository() {
    let directory = tempfile::tempdir().expect("tempdir");
    let repo = directory.path();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.email", "reviewer@example.com"]);
    git(repo, &["config", "user.name", "Reviewer"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write a");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "first"]);
    std::fs::write(repo.join("b.txt"), "two\n").expect("write b");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "second"]);

    let target = ReviewTarget {
        base_ref: "HEAD~1".to_string(),
        head_ref: "HEAD".to_string(),
        ..target(false)
    };
    let payload = capture_review_payload_async(&target, repo, &options(false)).await;

    assert_eq!(payload.diff_capture_error, None);
    assert!(payload.diff.contains("b.txt"));
    assert!(payload.diff.contains("+two"));
    assert!(
        payload
            .diff_stat
            .as_deref()
            .is_some_and(|stat| stat.contains("b.txt"))
    );
    let range = payload.diff_range.expect("range");
    assert_eq!(range.base_commit.as_deref().map(str::len), Some(40));
    assert_eq!(range.head_commit.as_deref().map(str::len), Some(40));
}

#[tokio::test]
async fn payload_matches_the_typescript_capture() {
    let directory = tempfile::tempdir().expect("tempdir");
    let repo = directory.path();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.email", "reviewer@example.com"]);
    git(repo, &["config", "user.name", "Reviewer"]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("write a");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "first"]);
    std::fs::write(repo.join("b.txt"), "two\n").expect("write b");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "second"]);

    let output = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(repo_root().join("rust-server/scripts/review-capture-fixture.ts"))
        .arg(repo)
        .current_dir(repo_root())
        .output()
        .expect("run node fixture");
    assert!(
        output.status.success(),
        "fixture failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).expect("fixture json");

    let target = ReviewTarget {
        base_ref: "HEAD~1".to_string(),
        head_ref: "HEAD".to_string(),
        ..target(false)
    };
    let payload = capture_review_payload_async(&target, repo, &options(false)).await;
    let actual = serde_json::to_value(&payload).expect("payload json");

    assert_eq!(actual["issue"], expected["issue"]);
    assert_eq!(actual["diffRange"], expected["diffRange"]);
    assert_eq!(actual["diff"], expected["diff"]);
    assert_eq!(actual["diffStat"], expected["diffStat"]);
    assert_eq!(actual["diffCaptureError"], expected["diffCaptureError"]);
    assert_eq!(expected["relatedContextCount"], 0);
    assert_eq!(expected["omissionCount"], 0);
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repo_root() -> &'static Path {
    static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("repo root")
            .to_path_buf()
    })
}

#[tokio::test]
async fn async_capture_extracts_local_related_context_from_the_pinned_head() {
    let directory = tempfile::tempdir().expect("temp dir");
    let repo = directory.path();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.email", "reviewer@example.com"]);
    git(repo, &["config", "user.name", "Reviewer"]);
    std::fs::write(repo.join("README.md"), "base\n").expect("readme");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "base"]);
    let base = git_output(repo, &["rev-parse", "HEAD"]);
    std::fs::create_dir_all(repo.join("src")).expect("src");
    std::fs::write(
        repo.join("src/a.ts"),
        "import { Foo, bar } from './b.js';\nexport const value: Foo = bar;\n",
    )
    .expect("a");
    std::fs::write(
        repo.join("src/b.ts"),
        "export interface Foo extends Base { value: Alias }\ninterface Base { id: string }\ntype Alias = string;\nexport const bar = 1;\nconst unused = 2;\n",
    )
    .expect("b");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "head"]);
    let head = git_output(repo, &["rev-parse", "HEAD"]);
    let mut target = target(true);
    target.base_commit = Some(base);
    target.head_commit = Some(head);

    let payload = capture_review_payload_async(&target, repo, &options(true)).await;
    assert_eq!(payload.diff_capture_error, None);
    let related = payload.related_contexts.expect("related contexts");
    let context = related
        .iter()
        .find(|context| context.file == "src/b.ts")
        .expect("b context");
    assert!(context.content.contains("export interface Foo"));
    assert!(context.content.contains("interface Base"));
    assert!(context.content.contains("type Alias"));
    assert!(context.content.contains("export const bar"));
    assert!(!context.content.contains("const unused"));
    assert_eq!(payload.related_context_omissions, Some(Vec::new()));
}

fn git_output(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}
