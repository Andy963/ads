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
async fn rejects_protected_branches_and_detached_head() {
    let (_temp, repo) = make_repo();
    let resolver = default_target_resolver();
    for protected in ["dev", "main", "master"] {
        git(&repo, &["checkout", "-B", protected]);
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
                assert!(
                    msg.contains(&format!("protected branch '{protected}'")),
                    "unexpected message for {protected}: {msg}"
                );
            }
            other => panic!("unexpected result for {protected}: {other:?}"),
        }
    }

    let head = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "--detach", &head]);
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
            assert!(
                msg.contains("checked-out feature branch"),
                "unexpected: {msg}"
            );
        }
        other => panic!("unexpected result for detached HEAD: {other:?}"),
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
    let pr_attempts = fake_dir.path().join("pr-attempts");
    std::fs::write(
        &gh,
        format!(
            r###"#!/bin/sh
case "$*" in
  "pr list --head"*)
    printf 'attempt\n' >> {pr_attempts:?}
    if [ "$(wc -l < {pr_attempts:?})" -eq 1 ]; then
      echo 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout' >&2
      exit 1
    fi
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
    assert_eq!(
        std::fs::read_to_string(pr_attempts)
            .expect("attempt log")
            .lines()
            .count(),
        2
    );
}

#[cfg(unix)]
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(unix)]
async fn run_resolver_with_fake_gh(
    branch: &str,
    pr_body: &str,
    issue_id: i64,
) -> Result<ads_actions::ResolvedReview, ReviewError> {
    let _lock = ENV_LOCK.lock().await;
    let (_temp, repo) = make_repo();
    git(&repo, &["branch", "-m", "dev"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "-b", branch]);
    std::fs::write(repo.join("feature.txt"), "feature\n").expect("feature");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "feature"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);

    let fake_dir = tempfile::tempdir().expect("fake gh dir");
    let gh = fake_dir.path().join("gh");
    let pr_json = serde_json::json!([{
        "number": 42,
        "url": "https://github.com/example/repo/pull/42",
        "state": "OPEN",
        "headRefName": branch,
        "baseRefName": "dev",
        "baseRefOid": base,
        "headRefOid": head,
        "body": pr_body,
    }]);
    let open_prs_json = serde_json::json!([{
        "number": 42,
        "headRefName": branch,
    }]);
    let issue_json = serde_json::json!({
        "number": issue_id,
        "title": "Semantic branch review",
        "body": "## Acceptance Criteria\n- Works cleanly",
        "state": "OPEN",
    });
    let pr_file = fake_dir.path().join("pr.json");
    let open_prs_file = fake_dir.path().join("open-prs.json");
    let issue_file = fake_dir.path().join("issue.json");
    std::fs::write(&pr_file, pr_json.to_string()).expect("write pr json");
    std::fs::write(&open_prs_file, open_prs_json.to_string()).expect("write open prs json");
    std::fs::write(&issue_file, issue_json.to_string()).expect("write issue json");

    std::fs::write(
        &gh,
        format!(
            r###"#!/bin/sh
case "$*" in
  "pr list --head"*)
    cat {pr_file:?}
    ;;
  "pr list --state open"*)
    cat {open_prs_file:?}
    ;;
  "issue view {issue_id} "*)
    cat {issue_file:?}
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

    default_target_resolver()(ResolveReviewRequest {
        project_id: "proj-1".to_string(),
        repo_path: repo.clone(),
        auth_user_id: "user-1".to_string(),
        branch: None,
        pr_number: None,
    })
    .await
}

#[cfg(unix)]
#[tokio::test]
async fn resolves_semantic_branches_using_pr_body_as_authoritative_issue_source() {
    for (branch, pr_body, expected_issue) in [
        ("fix/12-turn-timeout", "Closes #12", 12),
        ("feat/turn-timeout", "Fixes: #701\nResolves #701", 701),
        ("fix/404-error-handling", "Closes #701", 701),
    ] {
        let resolved = run_resolver_with_fake_gh(branch, pr_body, expected_issue)
            .await
            .unwrap_or_else(|error| panic!("branch {branch} failed: {error}"));
        assert_eq!(resolved.branch, branch);
        assert_eq!(resolved.pr_number, 42);
        assert_eq!(resolved.target.issue.id, Some(expected_issue));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_pr_body_with_missing_or_multiple_linked_issues() {
    match run_resolver_with_fake_gh("fix/12-turn-timeout", "No issue reference here", 12).await {
        Err(ReviewError::Incomplete(msg)) => {
            assert!(
                msg.contains("does not link a GitHub Issue"),
                "unexpected: {msg}"
            );
        }
        other => panic!("expected Incomplete for missing issue link, got: {other:?}"),
    }

    match run_resolver_with_fake_gh("fix/12-turn-timeout", "Closes #12\nFixes #13", 12).await {
        Err(ReviewError::Incomplete(msg)) => {
            assert!(
                msg.contains("multiple GitHub Issues (#12, #13)"),
                "unexpected: {msg}"
            );
        }
        other => panic!("expected Incomplete for multi-issue link, got: {other:?}"),
    }
}
