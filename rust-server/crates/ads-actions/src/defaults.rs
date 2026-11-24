use std::process::Stdio;
use std::time::Duration;

use ads_native::{
    ModelResolver, ResolveOptions, ReviewerInspectionOptions, run_reviewer_inspection,
};
use ads_reviewer::{ReviewVerdict, build_review_prompt};
use ads_state::{ROLE_REVIEWER, StateDb, get_default_role_profile, get_role_profile_by_id};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::types::{
    IssueCommentPublisher, IssueCommentRequest, ReviewError, ReviewerRequest, ReviewerRunner,
};

const COMMENT_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn default_reviewer_runner(db: StateDb, timeout: Duration) -> ReviewerRunner {
    std::sync::Arc::new(move |request| {
        let db = db.clone();
        Box::pin(async move { run_default_reviewer(db, request, timeout).await })
    })
}

async fn run_default_reviewer(
    db: StateDb,
    request: ReviewerRequest,
    timeout: Duration,
) -> Result<ReviewVerdict, ReviewError> {
    if request.payload.diff_capture_error.is_some() {
        return Err(ReviewError::Incomplete(
            "Reviewer evidence capture failed; no authoritative verdict is available.".to_string(),
        ));
    }
    let connection = db.connect()?;
    let profile = match request.profile_id.as_deref() {
        Some(profile_id) => get_role_profile_by_id(&connection, profile_id)?,
        None => get_default_role_profile(&connection, ROLE_REVIEWER)?,
    }
    .ok_or_else(|| {
        ReviewError::Other(
            "Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt."
                .to_string(),
        )
    })?;
    if profile.role != ROLE_REVIEWER
        || profile.is_enabled != 1
        || profile.model_id.trim().is_empty()
        || profile.system_prompt.trim().is_empty()
    {
        return Err(ReviewError::Other(
            "Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt."
                .to_string(),
        ));
    }
    drop(connection);
    let commit = request
        .payload
        .diff_range
        .as_ref()
        .and_then(|range| range.head_commit.clone())
        .ok_or_else(|| {
            ReviewError::Other(
                "Reviewer inspection requires captured head commit evidence.".to_string(),
            )
        })?;
    let mut model = ModelResolver::new(db).resolve(&ResolveOptions {
        owner: request.owner.clone(),
        model: Some(profile.model_id.clone()),
        require_owner_credentials: true,
    })?;
    model.options.reasoning_effort = Some(profile.reasoning_effort.clone());
    let prompt = build_review_prompt(&request.payload);
    let tool_turn_budget = std::env::var("ADS_REVIEWER_TOOL_TURNS")
        .ok()
        .filter(|value| value.trim() == "0")
        .map(|_| 0usize);
    let inspection = run_reviewer_inspection(ReviewerInspectionOptions {
        workspace: request.repo_path.clone(),
        commit,
        prompt,
        system_prompt: profile.system_prompt.clone(),
        model,
        profile_id: profile.id.clone(),
        cancellation: request.cancellation.clone(),
        tool_turn_budget,
        diff: Some(request.payload.diff.clone()),
        complete: None,
        verification_report: request.verification_report.clone(),
    });
    let verdict = tokio::select! {
        result = inspection => map_reviewer_result(result)?,
        _ = tokio::time::sleep(timeout) => {
            return Err(ReviewError::Other("Reviewer execution timed out.".to_string()));
        }
        _ = request.cancellation.cancelled() => {
            return Err(ReviewError::Other("Reviewer inspection was cancelled.".to_string()));
        }
    };
    Ok(ReviewVerdict {
        reviewer_profile_id: Some(profile.id.clone()),
        ..verdict
    })
}

fn map_reviewer_result(
    result: Result<ReviewVerdict, ads_reviewer::ReviewerError>,
) -> Result<ReviewVerdict, ReviewError> {
    result.map_err(ReviewError::from)
}

pub(crate) fn default_publisher() -> IssueCommentPublisher {
    std::sync::Arc::new(|request: IssueCommentRequest| {
        Box::pin(async move {
            let mut child = Command::new("gh")
                .args([
                    "issue",
                    "comment",
                    &request.issue_id.to_string(),
                    "--body-file",
                    "-",
                ])
                .current_dir(&request.repo_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|error| error.to_string())?;
            if let Some(mut stdin) = child.stdin.take() {
                if let Err(error) = stdin.write_all(request.body.as_bytes()).await {
                    return Err(error.to_string());
                }
            }
            let stderr_handle = child.stderr.take().map(|stderr| {
                tokio::spawn(async move {
                    let mut buffer = String::new();
                    let _ = stderr.take(4_000).read_to_string(&mut buffer).await;
                    buffer
                })
            });
            let status = match tokio::time::timeout(COMMENT_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => return Err(error.to_string()),
                Err(_) => {
                    return Err(format!(
                        "gh issue comment timed out after {}ms",
                        COMMENT_TIMEOUT.as_millis()
                    ));
                }
            };
            let stderr = match stderr_handle {
                Some(handle) => handle.await.unwrap_or_default(),
                None => String::new(),
            };
            if status.success() {
                return Ok(());
            }
            let stderr = stderr.trim();
            if !stderr.is_empty() {
                return Err(stderr.chars().take(500).collect());
            }
            Err(format!(
                "gh exited with code {}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ))
        })
    })
}
