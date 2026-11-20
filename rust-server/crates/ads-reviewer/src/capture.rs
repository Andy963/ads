use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::types::{ReviewAdr, ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewTestReport};
use crate::{diff_filter::filter_diff, extract_related_contexts};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_OUTPUT_LIMIT_CHARS: usize = 2_000_000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReviewTarget {
    pub issue: ReviewIssue,
    pub adrs: Option<Vec<ReviewAdr>>,
    pub base_ref: String,
    pub head_ref: String,
    pub base_commit: Option<String>,
    pub head_commit: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewDiffOverride {
    pub diff: String,
    pub diff_stat: String,
    pub range: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReviewCaptureOptions {
    pub require_pinned_evidence: bool,
    pub test_report: Option<ReviewTestReport>,
    pub diff_override: Option<ReviewDiffOverride>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewGitResult {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl ReviewGitResult {
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            status: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    pub fn failure(status: Option<i32>, stderr: impl Into<String>) -> Self {
        Self {
            status,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }
}

pub fn validate_git_evidence(
    diff: &str,
    diff_stat: &str,
    base_commit: Option<&str>,
    head_commit: Option<&str>,
) -> Option<String> {
    let mut errors = Vec::new();
    if diff.trim().is_empty() {
        errors.push("git diff returned empty output".to_string());
    }
    if diff_stat.trim().is_empty() {
        errors.push("git diff --stat returned empty output".to_string());
    }
    if !is_commit_hash(base_commit) {
        errors.push(format!(
            "git rev-parse base returned an invalid commit: {}",
            base_commit.unwrap_or("<empty>")
        ));
    }
    if !is_commit_hash(head_commit) {
        errors.push(format!(
            "git rev-parse review head returned an invalid commit: {}",
            head_commit.unwrap_or("<empty>")
        ));
    }
    (!errors.is_empty()).then(|| errors.join("; "))
}

pub async fn capture_review_payload_async(
    target: &ReviewTarget,
    repo_path: &Path,
    options: &ReviewCaptureOptions,
) -> ReviewPayload {
    let mut payload =
        capture_review_payload_with(target, options, |args| run_git(repo_path, args)).await;
    attach_related_contexts(&mut payload, repo_path).await;
    payload
}

async fn attach_related_contexts(payload: &mut ReviewPayload, repo_path: &Path) {
    if payload.diff_capture_error.is_some() {
        return;
    }
    let Some(range) = payload.diff_range.as_ref() else {
        return;
    };
    let (Some(base_commit), Some(head_commit)) =
        (range.base_commit.as_deref(), range.head_commit.as_deref())
    else {
        return;
    };
    if filter_diff(
        &payload.diff,
        crate::diff_filter::REVIEW_DIFF_MAX_LINES,
        payload.diff_stat.as_deref(),
        crate::diff_filter::REVIEW_DIFF_MAX_CHARS,
    )
    .truncated
    {
        return;
    }
    let extracted = extract_related_contexts(repo_path, base_commit, head_commit).await;
    payload.related_contexts = Some(extracted.related_contexts);
    payload.related_context_omissions = Some(extracted.related_context_omissions);
}

pub async fn capture_review_payload_with<F, Fut>(
    target: &ReviewTarget,
    options: &ReviewCaptureOptions,
    git: F,
) -> ReviewPayload
where
    F: Fn(Vec<String>) -> Fut,
    Fut: Future<Output = Option<ReviewGitResult>>,
{
    let require_pinned_evidence = options.require_pinned_evidence;
    let mut capture_errors = Vec::new();
    let configured_base = if require_pinned_evidence {
        target.base_commit.as_deref()
    } else {
        Some(target.base_ref.as_str())
    };
    let configured_head = if require_pinned_evidence {
        target.head_commit.as_deref()
    } else {
        Some(target.head_ref.as_str())
    };

    if require_pinned_evidence && configured_base.is_none() {
        capture_errors.push("review target does not have a recorded base commit".to_string());
    }
    if require_pinned_evidence && configured_head.is_none() {
        capture_errors.push("review target does not have a pinned head commit".to_string());
    }
    if require_pinned_evidence && configured_base.is_some() && !is_commit_hash(configured_base) {
        capture_errors.push("review target has an invalid recorded base commit".to_string());
    }
    if require_pinned_evidence && configured_head.is_some() && !is_commit_hash(configured_head) {
        capture_errors.push("review target has an invalid pinned head commit".to_string());
    }

    let base_ref = configured_base.unwrap_or("<missing-base>");
    let head_ref = configured_head.unwrap_or("<missing-head>");
    let can_resolve_base = !require_pinned_evidence || is_commit_hash(configured_base);
    let can_resolve_head = !require_pinned_evidence || is_commit_hash(configured_head);

    let base_commit_result = if can_resolve_base {
        git(vec![
            "rev-parse".to_string(),
            "--verify".to_string(),
            format!("{base_ref}^{{commit}}"),
        ])
        .await
    } else {
        None
    };
    let head_commit_result = if can_resolve_head {
        git(vec![
            "rev-parse".to_string(),
            "--verify".to_string(),
            format!("{head_ref}^{{commit}}"),
        ])
        .await
    } else {
        None
    };
    let base_commit = base_commit_result
        .as_ref()
        .and_then(|result| non_empty_trimmed(&result.stdout));
    let head_commit = head_commit_result
        .as_ref()
        .and_then(|result| non_empty_trimmed(&result.stdout));
    let separator = if require_pinned_evidence { ".." } else { "..." };
    let captured_range = format!(
        "{}{separator}{}",
        base_commit.as_deref().unwrap_or(base_ref),
        head_commit.as_deref().unwrap_or(head_ref)
    );

    if require_pinned_evidence {
        if let (Some(base), Some(head)) = (base_commit.as_deref(), head_commit.as_deref()) {
            let ancestry = git(vec![
                "merge-base".to_string(),
                "--is-ancestor".to_string(),
                base.to_string(),
                head.to_string(),
            ])
            .await;
            if ancestry.as_ref().and_then(|result| result.status) != Some(0) {
                capture_errors
                    .push("recorded base commit is not an ancestor of the pinned head".to_string());
            }
        }
    }

    let diff_result = if let Some(overridden) = options.diff_override.as_ref() {
        Some(ReviewGitResult::success(overridden.diff.clone()))
    } else if base_commit.is_some() && head_commit.is_some() {
        git(vec!["diff".to_string(), captured_range.clone()]).await
    } else {
        None
    };
    let diff_stat_result = if let Some(overridden) = options.diff_override.as_ref() {
        Some(ReviewGitResult::success(overridden.diff_stat.clone()))
    } else if base_commit.is_some() && head_commit.is_some() {
        git(vec![
            "diff".to_string(),
            "--stat".to_string(),
            captured_range.clone(),
        ])
        .await
    } else {
        None
    };

    if base_commit_result.as_ref().and_then(|result| result.status) != Some(0) {
        capture_errors.push(format!("git rev-parse base '{base_ref}' failed"));
    }
    if head_commit_result.as_ref().and_then(|result| result.status) != Some(0) {
        capture_errors.push("git rev-parse review head failed".to_string());
    }
    if diff_result.as_ref().and_then(|result| result.status) != Some(0) {
        capture_errors.push(format!(
            "git diff exited with status {}",
            status_label(diff_result.as_ref())
        ));
    }
    if diff_stat_result.as_ref().and_then(|result| result.status) != Some(0) {
        capture_errors.push(format!(
            "git diff --stat exited with status {}",
            status_label(diff_stat_result.as_ref())
        ));
    }

    let diff = diff_result
        .as_ref()
        .map(|result| result.stdout.clone())
        .unwrap_or_default();
    let diff_stat = diff_stat_result
        .as_ref()
        .map(|result| result.stdout.clone())
        .unwrap_or_default();
    if let Some(error) = validate_git_evidence(
        &diff,
        &diff_stat,
        base_commit.as_deref(),
        head_commit.as_deref(),
    ) {
        capture_errors.push(error);
    }
    let diff_capture_error = (!capture_errors.is_empty()).then(|| capture_errors.join("; "));

    let range = options
        .diff_override
        .as_ref()
        .and_then(|overridden| overridden.range.clone())
        .unwrap_or_else(|| {
            if require_pinned_evidence {
                captured_range.clone()
            } else {
                format!("{base_ref}...{head_ref}")
            }
        });

    ReviewPayload {
        issue: target.issue.clone(),
        diff_range: Some(ReviewDiffRange {
            base_ref: base_ref.to_string(),
            head_ref: head_ref.to_string(),
            base_commit,
            head_commit,
            range,
        }),
        adrs: target.adrs.clone(),
        diff,
        diff_stat: Some(diff_stat),
        diff_capture_error,
        // The TypeScript context extractor is not ported yet; do not fabricate related contexts.
        related_contexts: None,
        related_context_omissions: None,
        test_report: options.test_report.clone(),
    }
}

async fn run_git(repo: &Path, args: Vec<String>) -> Option<ReviewGitResult> {
    let mut command = Command::new("git");
    command
        .args(&args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().ok()?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .map(|reader| tokio::spawn(read_git_tail(reader)));
    let stderr = child
        .stderr
        .take()
        .map(|reader| tokio::spawn(read_git_tail(reader)));
    let status = match tokio::time::timeout(GIT_COMMAND_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return None,
        Err(_) => {
            terminate_git_process_group(&mut child, pid).await;
            return None;
        }
    };
    let stdout = match stdout {
        Some(task) => task.await.ok()?,
        None => String::new(),
    };
    let stderr = match stderr {
        Some(task) => task.await.ok()?,
        None => String::new(),
    };
    Some(ReviewGitResult {
        status: status.code(),
        stdout,
        stderr,
    })
}

async fn read_git_tail<R>(mut reader: R) -> String
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
        if bytes.len() > GIT_OUTPUT_LIMIT_CHARS * 4 {
            let keep_from = bytes.len() - GIT_OUTPUT_LIMIT_CHARS * 2;
            bytes.drain(..keep_from);
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let length = text.encode_utf16().count();
    if length <= GIT_OUTPUT_LIMIT_CHARS {
        return text.to_string();
    }
    String::from_utf16_lossy(
        &text
            .encode_utf16()
            .skip(length - GIT_OUTPUT_LIMIT_CHARS)
            .collect::<Vec<_>>(),
    )
}

async fn terminate_git_process_group(child: &mut tokio::process::Child, pid: Option<u32>) {
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

fn status_label(result: Option<&ReviewGitResult>) -> String {
    result
        .and_then(|result| result.status)
        .map(|status| status.to_string())
        .unwrap_or_else(|| "unavailable".to_string())
}

fn is_commit_hash(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let bytes = value.as_bytes();
    matches!(bytes.len(), 40 | 64) && bytes.iter().all(u8::is_ascii_hexdigit)
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}
