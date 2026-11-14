use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::{TempDir, tempdir};

use ads_actions::{
    ResolveReviewRequest, ReviewError, default_target_resolver, parse_acceptance_criteria,
};

fn git(repo: &Path, args: &[&str]) -> String {
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

fn make_repo() -> (TempDir, PathBuf) {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().to_path_buf();
    git(&path, &["init", "-q"]);
    git(&path, &["config", "user.email", "reviewer@example.com"]);
    git(&path, &["config", "user.name", "Reviewer"]);
    std::fs::write(path.join("README.md"), "# Test Repo\n").expect("write readme");
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "initial commit"]);
    (directory, path)
}

#[test]
fn parses_acceptance_criteria_from_issue_markdown() {
    let body = r#"
# Problem Description
Some context about the problem.

## Acceptance Criteria
- The login button triggers auth flow
* Rate limiting returns 429 with Retry-After
1. Unit tests pass cleanly
2) Integration tests pass in CI

## Implementation Notes
Keep changes minimal.
"#;
    let criteria = parse_acceptance_criteria(body);
    assert_eq!(
        criteria,
        vec![
            "The login button triggers auth flow",
            "Rate limiting returns 429 with Retry-After",
            "Unit tests pass cleanly",
            "Integration tests pass in CI",
        ]
    );
}

#[test]
fn parses_empty_criteria_when_missing_section() {
    let body = "Just some text without criteria";
    let criteria = parse_acceptance_criteria(body);
    assert!(criteria.is_empty());
    assert!(parse_acceptance_criteria("# Acceptance Criteria\n- too shallow").is_empty());
}

#[tokio::test]
async fn rejects_non_codex_branch() {
    let (_temp, repo) = make_repo();
    git(&repo, &["checkout", "-b", "feature/my-feat"]);
    let resolver = default_target_resolver();
    let result = resolver(ResolveReviewRequest {
        project_id: "proj-1".to_string(),
        repo_path: repo.clone(),
        auth_user_id: "user-1".to_string(),
        branch: None,
        pr_number: None,
    })
    .await;
    match result {
        Err(ReviewError::Other(msg)) => {
            assert!(msg.contains("assigned codex/issue-<id> feature branch"));
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn rejects_mismatched_requested_branch() {
    let (_temp, repo) = make_repo();
    git(&repo, &["checkout", "-b", "codex/issue-12"]);
    let resolver = default_target_resolver();
    let result = resolver(ResolveReviewRequest {
        project_id: "proj-1".to_string(),
        repo_path: repo.clone(),
        auth_user_id: "user-1".to_string(),
        branch: Some("codex/issue-99".to_string()),
        pr_number: None,
    })
    .await;
    match result {
        Err(ReviewError::Incomplete(msg)) => {
            assert!(msg.contains("Requested branch 'codex/issue-99' does not match the current branch 'codex/issue-12'"));
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn rejects_dirty_working_tree() {
    let (_temp, repo) = make_repo();
    git(&repo, &["checkout", "-b", "codex/issue-12"]);
    std::fs::write(repo.join("README.md"), "# Changed\n").expect("write changed");
    let resolver = default_target_resolver();
    let result = resolver(ResolveReviewRequest {
        project_id: "proj-1".to_string(),
        repo_path: repo.clone(),
        auth_user_id: "user-1".to_string(),
        branch: None,
        pr_number: None,
    })
    .await;
    match result {
        Err(ReviewError::Incomplete(msg)) => {
            assert!(msg.contains("workspace has uncommitted tracked changes"));
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn resolves_a_complete_github_review_target_with_fake_gh() {
    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _lock = ENV_LOCK.lock().await;
    let (_temp, repo) = make_repo();
    git(&repo, &["branch", "-m", "dev"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "-b", "codex/issue-12"]);
    std::fs::write(repo.join("feature.txt"), "feature\n").expect("feature");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "feature"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    assert_eq!(
        git(&repo, &["rev-parse", "--verify", "HEAD^{commit}"]),
        head
    );

    let fake_dir = tempfile::tempdir().expect("fake gh dir");
    let gh = fake_dir.path().join("gh");
    std::fs::write(
        &gh,
        format!(
            r###"#!/bin/sh
case "$*" in
  "pr list --head"*)
    printf '%s\n' '[{{"number":12,"url":"https://github.com/example/repo/pull/12","state":"OPEN","headRefName":"codex/issue-12","baseRefName":"dev","baseRefOid":"{base}","headRefOid":"{head}","body":"Closes #12"}}]'
    ;;
  "pr list --state open"*)
    printf '%s\n' '[{{"number":12,"headRefName":"codex/issue-12"}}]'
    ;;
  "issue view"*)
    printf '%s\n' '{{"number":12,"title":"Feature","body":"## Acceptance Criteria\n- Feature works","state":"OPEN"}}'
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 1
    ;;
esac
"###
        ),
    )
    .expect("fake gh");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let old_path = std::env::var_os("PATH");
    struct RestorePath(Option<std::ffi::OsString>);
    impl Drop for RestorePath {
        fn drop(&mut self) {
            unsafe {
                if let Some(value) = self.0.take() {
                    std::env::set_var("PATH", value);
                } else {
                    std::env::remove_var("PATH");
                }
            }
        }
    }
    let _restore = RestorePath(old_path.clone());
    let path = format!(
        "{}:{}",
        fake_dir.path().display(),
        old_path.unwrap_or_default().to_string_lossy()
    );
    unsafe {
        std::env::set_var("PATH", path);
    }

    let resolved = default_target_resolver()(ResolveReviewRequest {
        project_id: "proj-1".to_string(),
        repo_path: repo.clone(),
        auth_user_id: "user-1".to_string(),
        branch: None,
        pr_number: None,
    })
    .await
    .expect("resolve target");
    assert_eq!(resolved.branch, "codex/issue-12");
    assert_eq!(resolved.pr_number, 12);
    assert_eq!(resolved.target.issue.id, Some(12));
    assert_eq!(resolved.target.issue.title, "Feature");
    assert_eq!(
        resolved.target.issue.acceptance_criteria,
        Some(vec!["Feature works".to_string()])
    );
    assert_eq!(resolved.target.base_commit.as_deref(), Some(base.as_str()));
    assert_eq!(resolved.target.head_commit.as_deref(), Some(head.as_str()));
}
