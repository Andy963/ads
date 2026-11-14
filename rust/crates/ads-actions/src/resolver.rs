use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ads_reviewer::{ReviewAdr, ReviewIssue, ReviewTarget};
use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::types::{ResolveReviewRequest, ResolvedReview, ReviewError, TargetResolver};

const ACTIONS_BASE_BRANCH: &str = "dev";
const DEFAULT_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_COMMAND_OUTPUT_CHARS: usize = 20_000;
const GH_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_secs(2)];

pub fn parse_acceptance_criteria(body: &str) -> Vec<String> {
    let header = match Regex::new(r"(?im)^#{2,}\s+Acceptance Criteria\s*$") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let next_header = match Regex::new(r"(?m)^#{2,}\s") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let re_item = match Regex::new(r"^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    let Some(header_end) = header.find(body).map(|value| value.end()) else {
        return Vec::new();
    };
    let section_end = next_header
        .find_at(body, header_end)
        .map(|value| value.start())
        .unwrap_or(body.len());
    let section = &body[header_end..section_end];
    let mut criteria = Vec::new();
    for line in section.lines() {
        if let Some(caps) = re_item.captures(line) {
            if let Some(item) = caps.get(1) {
                let text = item.as_str().trim();
                if !text.is_empty() {
                    criteria.push(text.to_string());
                }
            }
        }
    }
    criteria
}

pub fn default_target_resolver() -> TargetResolver {
    Arc::new(|request: ResolveReviewRequest| {
        Box::pin(async move { resolve_interactive_target(request).await })
    })
}

async fn run_cmd(
    cmd: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<(i32, String, String), ReviewError> {
    let mut command = Command::new(cmd);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| ReviewError::Other(format!("Failed to spawn '{cmd}': {error}")))?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .map(|reader| tokio::spawn(read_tail(reader)));
    let stderr = child
        .stderr
        .take()
        .map(|reader| tokio::spawn(read_tail(reader)));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            return Err(ReviewError::Other(format!(
                "Failed to execute '{cmd}': {error}"
            )));
        }
        Err(_) => {
            terminate_process_group(&mut child, pid).await;
            return Err(ReviewError::Other(format!(
                "Interactive command '{cmd}' timed out after {}ms.",
                timeout.as_millis()
            )));
        }
    };
    let stdout = match stdout {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let stderr = match stderr {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let exit_code = status.code().unwrap_or(1);
    let stdout = stdout.trim().to_string();
    let stderr = stderr.trim().to_string();
    Ok((exit_code, stdout, stderr))
}

async fn read_tail<R>(mut reader: R) -> String
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8_192];
    while let Ok(read) = reader.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > MAX_COMMAND_OUTPUT_CHARS * 8 {
            let keep_from = bytes.len() - MAX_COMMAND_OUTPUT_CHARS * 4;
            bytes.drain(..keep_from);
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let length = text.encode_utf16().count();
    if length <= MAX_COMMAND_OUTPUT_CHARS {
        return text.to_string();
    }
    String::from_utf16_lossy(
        &text
            .encode_utf16()
            .skip(length - MAX_COMMAND_OUTPUT_CHARS)
            .collect::<Vec<_>>(),
    )
}

async fn run_gh_cmd(args: &[&str], cwd: &Path) -> Result<(i32, String, String), ReviewError> {
    let attempts = GH_RETRY_DELAYS.len() + 1;
    let mut last_result = None;
    for attempt in 0..attempts {
        let result = run_cmd("gh", args, cwd, DEFAULT_CMD_TIMEOUT).await;
        let retryable = match &result {
            Ok((code, _, stderr)) => *code != 0 && is_retryable_github_failure(stderr),
            Err(error) => is_retryable_github_failure(&error.to_string()),
        };
        if !retryable || attempt + 1 == attempts {
            return result;
        }
        last_result = Some(result);
        tokio::time::sleep(GH_RETRY_DELAYS[attempt]).await;
    }
    last_result.unwrap_or_else(|| {
        Err(ReviewError::Other(
            "GitHub command retry loop ended without a result".to_string(),
        ))
    })
}

fn is_retryable_github_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "tls handshake timeout",
        "i/o timeout",
        "context deadline exceeded",
        "timeout awaiting response",
        "connection reset",
        "connection refused",
        "network is unreachable",
        "temporary failure in name resolution",
        "could not resolve host",
        "no such host",
        "unexpected eof",
        "stream error",
        "http 502",
        "http 503",
        "http 504",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

async fn terminate_process_group(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
        return;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn git_cmd(args: &[&str], cwd: &Path, label: &str) -> Result<String, ReviewError> {
    let (code, stdout, stderr) = run_cmd("git", args, cwd, DEFAULT_CMD_TIMEOUT).await?;
    if code != 0 {
        let msg = if stderr.is_empty() {
            "command failed".to_string()
        } else {
            stderr
        };
        return Err(ReviewError::Other(format!("{label}: {msg}")));
    }
    Ok(stdout)
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(12).collect()
}

pub async fn resolve_interactive_target(
    request: ResolveReviewRequest,
) -> Result<ResolvedReview, ReviewError> {
    let repo_path = &request.repo_path;
    let auth_user_id = request.auth_user_id.trim().to_string();
    let project_id = request.project_id.trim().to_string();
    if repo_path.as_os_str().is_empty() || auth_user_id.is_empty() || project_id.is_empty() {
        return Err(ReviewError::Other(
            "Interactive review requires an authenticated project workspace.".to_string(),
        ));
    }

    let branch = git_cmd(
        &["branch", "--show-current"],
        repo_path,
        "Unable to determine the current feature branch",
    )
    .await?;

    if let Some(expected_branch) = request.branch.as_deref() {
        let expected_branch = expected_branch.trim();
        if !expected_branch.is_empty() && expected_branch != branch {
            return Err(ReviewError::Incomplete(format!(
                "Requested branch '{expected_branch}' does not match the current branch '{branch}'. Switch back to the review branch and dispatch again."
            )));
        }
    }

    let digits = branch.strip_prefix("codex/issue-").ok_or_else(|| {
        ReviewError::Other(
            "Interactive review requires the assigned codex/issue-<id> feature branch.".to_string(),
        )
    })?;
    let issue_id: i64 = digits.parse().map_err(|_| {
        ReviewError::Other(
            "The current feature branch does not identify a valid GitHub Issue.".to_string(),
        )
    })?;
    if issue_id < 1 {
        return Err(ReviewError::Other(
            "The current feature branch does not identify a valid GitHub Issue.".to_string(),
        ));
    }

    let status = git_cmd(
        &["status", "--porcelain", "-uno"],
        repo_path,
        "Unable to inspect tracked workspace state",
    )
    .await?;
    if !status.is_empty() {
        return Err(ReviewError::Incomplete(
            "The workspace has uncommitted tracked changes. Commit or revert them, then dispatch the review again.".to_string(),
        ));
    }

    let (remote_code, remote_stdout, _) = run_cmd(
        "git",
        &["remote", "get-url", "origin"],
        repo_path,
        DEFAULT_CMD_TIMEOUT,
    )
    .await?;
    let base_ref = if remote_code == 0 && !remote_stdout.is_empty() {
        format!("origin/{ACTIONS_BASE_BRANCH}")
    } else {
        ACTIONS_BASE_BRANCH.to_string()
    };

    let base_commit = git_cmd(
        &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")],
        repo_path,
        &format!("Unable to resolve the {ACTIONS_BASE_BRANCH} base branch"),
    )
    .await?;
    let head_commit = git_cmd(
        &["rev-parse", "--verify", "HEAD^{commit}"],
        repo_path,
        "Unable to resolve the current feature commit",
    )
    .await?;

    let (ancestor_code, _, _) = run_cmd(
        "git",
        &["merge-base", "--is-ancestor", &base_commit, &head_commit],
        repo_path,
        DEFAULT_CMD_TIMEOUT,
    )
    .await?;
    if ancestor_code != 0 {
        return Err(ReviewError::Incomplete(format!(
            "The feature branch does not descend from the current '{ACTIONS_BASE_BRANCH}' base. Rebase onto the latest base, then dispatch the review again."
        )));
    }

    let pr_fields = "number,url,state,headRefName,baseRefName,baseRefOid,headRefOid,body";
    let pr_num_str = request.pr_number.filter(|n| *n > 0).map(|n| n.to_string());
    let pr_args = if let Some(ref num) = pr_num_str {
        vec!["pr", "view", num.as_str(), "--json", pr_fields]
    } else {
        vec![
            "pr", "list", "--head", &branch, "--state", "open", "--limit", "2", "--json", pr_fields,
        ]
    };

    let (pr_code, pr_stdout, pr_stderr) = run_gh_cmd(&pr_args, repo_path).await?;
    if pr_code != 0 {
        let msg = if pr_stderr.is_empty() {
            "gh command failed"
        } else {
            &pr_stderr
        };
        return Err(ReviewError::Other(format!(
            "Unable to resolve the GitHub pull request: {msg}"
        )));
    }

    let parsed_pr: Value = serde_json::from_str(&pr_stdout).map_err(|error| {
        ReviewError::Other(format!("GitHub pull request metadata is invalid: {error}"))
    })?;
    let pr_records = match parsed_pr {
        Value::Array(records) => records,
        obj @ Value::Object(_) => vec![obj],
        _ => {
            return Err(ReviewError::Other(
                "GitHub pull request metadata is invalid: expected array or object".to_string(),
            ));
        }
    };
    if pr_records.len() != 1 {
        return Err(ReviewError::Other(
            "Interactive review requires exactly one matching open pull request.".to_string(),
        ));
    }
    let pr = &pr_records[0];
    let pr_number = pr["number"].as_i64().unwrap_or(0);
    let pr_url = pr["url"].as_str().unwrap_or("").trim().to_string();
    let pr_state = pr["state"].as_str().unwrap_or("").trim().to_string();
    let pr_head_ref = pr["headRefName"].as_str().unwrap_or("").trim().to_string();
    let pr_base_ref = pr["baseRefName"].as_str().unwrap_or("").trim().to_string();
    let pr_base_oid = pr["baseRefOid"].as_str().unwrap_or("").trim().to_string();
    let pr_head_oid = pr["headRefOid"].as_str().unwrap_or("").trim().to_string();
    let pr_body = pr["body"].as_str().unwrap_or("").to_string();

    if pr_number < 1 || pr_url.is_empty() {
        return Err(ReviewError::Other(
            "The matching pull request is missing its number or URL.".to_string(),
        ));
    }

    if pr_state.to_uppercase() != "OPEN"
        || pr_head_ref != branch
        || pr_base_ref != ACTIONS_BASE_BRANCH
        || pr_head_oid != head_commit
        || pr_base_oid != base_commit
    {
        let head_reported = if pr_head_oid.is_empty() {
            "unknown".to_string()
        } else {
            short_sha(&pr_head_oid)
        };
        return Err(ReviewError::Incomplete(format!(
            "The pull request does not match the current target: local head {}, base {}, branch '{branch}'; PR #{pr_number} reports head {head_reported} on '{pr_head_ref}' against '{pr_base_ref}' ({pr_state}). Push or wait for GitHub to sync, then dispatch the review again.",
            short_sha(&head_commit),
            short_sha(&base_commit),
        )));
    }

    let (open_prs_code, open_prs_stdout, open_prs_stderr) = run_gh_cmd(
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--base",
            ACTIONS_BASE_BRANCH,
            "--json",
            "number,headRefName",
        ],
        repo_path,
    )
    .await?;
    if open_prs_code != 0 {
        let msg = if open_prs_stderr.is_empty() {
            "gh command failed"
        } else {
            &open_prs_stderr
        };
        return Err(ReviewError::Other(format!(
            "Unable to inspect open pull requests: {msg}"
        )));
    }
    let open_prs: Vec<Value> = serde_json::from_str(&open_prs_stdout).map_err(|error| {
        ReviewError::Other(format!("Open pull request metadata is invalid: {error}"))
    })?;
    if open_prs.len() != 1 || open_prs[0]["number"].as_i64() != Some(pr_number) {
        return Err(ReviewError::Incomplete(format!(
            "Expected exactly one open pull request for this project, found {}. Close or finish the extra PR, then dispatch the review again.",
            open_prs.len()
        )));
    }

    let issue_ref_re = match Regex::new(&format!(
        r"(?i)(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#{issue_id}\b"
    )) {
        Ok(re) => re,
        Err(_) => {
            return Err(ReviewError::Other(
                "Failed to compile issue regex".to_string(),
            ));
        }
    };
    if !issue_ref_re.is_match(&pr_body) {
        let tick = "\x60";
        return Err(ReviewError::Incomplete(format!(
            "The pull request description does not link Issue #{issue_id}. Add {tick}Closes #{issue_id}{tick} to the PR body, then dispatch the review again."
        )));
    }

    let (issue_code, issue_stdout, issue_stderr) = run_gh_cmd(
        &[
            "issue",
            "view",
            &issue_id.to_string(),
            "--json",
            "number,title,body,state",
        ],
        repo_path,
    )
    .await?;
    if issue_code != 0 {
        let msg = if issue_stderr.is_empty() {
            "gh command failed"
        } else {
            &issue_stderr
        };
        return Err(ReviewError::Other(format!(
            "Unable to resolve GitHub Issue #{issue_id}: {msg}"
        )));
    }
    let issue_val: Value = serde_json::from_str(&issue_stdout).map_err(|error| {
        ReviewError::Other(format!("GitHub Issue metadata is invalid: {error}"))
    })?;
    let issue_number = issue_val["number"].as_i64().unwrap_or(0);
    let issue_title = issue_val["title"].as_str().unwrap_or("").trim().to_string();
    let issue_body = issue_val["body"].as_str().unwrap_or("").trim().to_string();
    let acceptance_criteria = parse_acceptance_criteria(&issue_body);
    if issue_number != issue_id
        || issue_title.is_empty()
        || issue_body.is_empty()
        || acceptance_criteria.is_empty()
    {
        return Err(ReviewError::Incomplete(format!(
            "GitHub Issue #{issue_id} is missing a title, description, or acceptance criteria. Complete the Issue, then dispatch the review again."
        )));
    }

    let adrs = read_adr_snapshot(repo_path, &base_commit, &head_commit).await?;

    Ok(ResolvedReview {
        project_id,
        repo_path: repo_path.clone(),
        auth_user_id,
        branch,
        pr_number,
        pr_url,
        target: ReviewTarget {
            issue: ReviewIssue {
                id: Some(issue_id),
                title: issue_title,
                description: Some(issue_body),
                acceptance_criteria: Some(acceptance_criteria),
            },
            adrs: if adrs.is_empty() { None } else { Some(adrs) },
            base_ref,
            head_ref: "HEAD".to_string(),
            base_commit: Some(base_commit),
            head_commit: Some(head_commit),
        },
    })
}

async fn read_adr_snapshot(
    repo_path: &Path,
    base_commit: &str,
    head_commit: &str,
) -> Result<Vec<ReviewAdr>, ReviewError> {
    let diff_range = format!("{base_commit}...{head_commit}");
    let changed_output = git_cmd(
        &["diff", "--name-only", &diff_range],
        repo_path,
        "Unable to capture changed ADR files",
    )
    .await?;

    let re_adr_file = match Regex::new(r"^docs/adr/[^/]+\.md$") {
        Ok(re) => re,
        Err(_) => return Ok(Vec::new()),
    };
    let re_title = match Regex::new(r"(?m)^#\s+(.+)$") {
        Ok(re) => re,
        Err(_) => return Ok(Vec::new()),
    };
    let mut adrs = Vec::new();
    for file in changed_output
        .lines()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        if !re_adr_file.is_match(file) {
            continue;
        }
        let full_path = repo_path.join(file);
        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|error| {
                ReviewError::Other(format!("Unable to read changed ADR '{file}': {error}"))
            })?;
        let id = Path::new(file)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(file)
            .to_string();
        let title = re_title
            .captures(&content)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_else(|| id.clone());
        let decision = parse_adr_decision(&content);
        adrs.push(ReviewAdr {
            id,
            title,
            decision,
        });
    }
    Ok(adrs)
}

fn parse_adr_decision(content: &str) -> String {
    let mut in_section = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let header_text = trimmed.trim_start_matches('#').trim();
            if header_text.eq_ignore_ascii_case("Decision") {
                in_section = true;
                continue;
            } else if in_section {
                break;
            }
        }
        if in_section {
            lines.push(line);
        }
    }
    let result = lines.join("\n").trim().to_string();
    if result.is_empty() {
        content.trim().to_string()
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn command_output_is_tailed_to_the_typescript_limit() {
        let directory = tempfile::tempdir().expect("temp dir");
        let (code, stdout, _) = run_cmd(
            "sh",
            &[
                "-c",
                "i=0; while [ $i -lt 3000 ]; do printf '%06d\\n' $i; i=$((i+1)); done",
            ],
            directory.path(),
            Duration::from_secs(5),
        )
        .await
        .expect("command");
        assert_eq!(code, 0);
        assert!(stdout.encode_utf16().count() <= MAX_COMMAND_OUTPUT_CHARS);
        assert!(stdout.ends_with("002999"));
    }

    #[tokio::test]
    async fn command_timeout_matches_the_typescript_message() {
        let directory = tempfile::tempdir().expect("temp dir");
        let error = run_cmd(
            "sh",
            &["-c", "sleep 2"],
            directory.path(),
            Duration::from_millis(100),
        )
        .await
        .expect_err("timeout");
        assert_eq!(
            error.to_string(),
            "Interactive command 'sh' timed out after 100ms."
        );
    }

    #[test]
    fn classifies_only_transient_github_failures_as_retryable() {
        assert!(is_retryable_github_failure(
            r#"Post "https://api.github.com/graphql": net/http: TLS handshake timeout"#
        ));
        assert!(is_retryable_github_failure("HTTP 503: Service Unavailable"));
        assert!(is_retryable_github_failure("dial tcp: i/o timeout"));
        assert!(!is_retryable_github_failure("HTTP 401: Bad credentials"));
        assert!(!is_retryable_github_failure(
            "no pull requests found for branch"
        ));
    }
}
