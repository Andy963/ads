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
pub const DEFAULT_REVIEWER_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const REVIEWER_IDLE_TIMEOUT_ENV: &str = "ADS_REVIEWER_IDLE_TIMEOUT_MS";
pub const REVIEWER_MAX_DURATION_ENV: &str = "ADS_REVIEWER_MAX_DURATION_MS";

/// Resolves the per-stream inactivity timeout for Native Actions Reviewer turns.
/// Defaults to 15 minutes; set `ADS_REVIEWER_IDLE_TIMEOUT_MS=0` to disable.
pub fn resolve_reviewer_idle_timeout() -> Option<Duration> {
    std::env::var(REVIEWER_IDLE_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(Some(DEFAULT_REVIEWER_IDLE_TIMEOUT), |ms| {
            (ms > 0).then(|| Duration::from_millis(ms))
        })
}

/// Resolves an optional opt-in hard wall-clock ceiling for Actions Reviewer turns.
/// Disabled (`None`) by default so active reviews making progress are never hard-killed.
pub fn resolve_reviewer_max_duration() -> Option<Duration> {
    std::env::var(REVIEWER_MAX_DURATION_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
}

pub fn default_reviewer_runner(
    db: StateDb,
    idle_timeout: Option<Duration>,
    max_duration: Option<Duration>,
) -> ReviewerRunner {
    std::sync::Arc::new(move |request| {
        let db = db.clone();
        Box::pin(async move { run_default_reviewer(db, request, idle_timeout, max_duration).await })
    })
}

async fn run_default_reviewer(
    db: StateDb,
    request: ReviewerRequest,
    idle_timeout: Option<Duration>,
    max_duration: Option<Duration>,
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
    model.options.stream_idle_timeout = Some(idle_timeout.unwrap_or(Duration::ZERO));
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
    let max_duration = max_duration.filter(|duration| !duration.is_zero());
    let verdict = if let Some(cap) = max_duration {
        tokio::select! {
            result = inspection => map_reviewer_result(result)?,
            _ = tokio::time::sleep(cap) => {
                request.cancellation.cancel();
                return Err(ReviewError::Incomplete(format!(
                    "Reviewer execution exceeded maximum duration ({}s).",
                    cap.as_secs()
                )));
            }
            _ = request.cancellation.cancelled() => {
                return Err(ReviewError::Other("Reviewer inspection was cancelled.".to_string()));
            }
        }
    } else {
        tokio::select! {
            result = inspection => map_reviewer_result(result)?,
            _ = request.cancellation.cancelled() => {
                return Err(ReviewError::Other("Reviewer inspection was cancelled.".to_string()));
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use ads_reviewer::{ReviewDiffRange, ReviewIssue, ReviewPayload, ReviewVerificationReport};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn native_reviewer_max_duration_cancels_and_returns_incomplete() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo");
        let run_git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        };
        run_git(&["init", "-q"]);
        run_git(&["config", "user.email", "test@example.com"]);
        run_git(&["config", "user.name", "Test"]);
        std::fs::write(repo.join("a.rs"), "fn main() {}\n").expect("write");
        run_git(&["add", "."]);
        run_git(&["commit", "-q", "-m", "init"]);
        let head = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&repo)
                .output()
                .expect("rev-parse")
                .stdout,
        )
        .expect("utf8")
        .trim()
        .to_string();

        // Accept TCP connection and hold it silently open without sending HTTP headers.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            if let Ok((_socket, _)) = listener.accept().await {
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });

        let db = StateDb::open(dir.path().join("state.db")).expect("db");
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut conn = db.connect().expect("conn");
            let creds = ads_state::UpstreamCredentialStore::for_state_db(db.path());
            creds
                .save(
                    &conn,
                    "user-1",
                    &ads_state::UpstreamCredentials {
                        base_url: format!("http://{addr}/v1"),
                        provider: "openai".to_string(),
                        api_key: "sk-test".to_string(),
                    },
                    Some("prov-slow"),
                )
                .expect("creds");
            conn.execute(
                "INSERT INTO model_providers (id, name, base_url, credential_profile, wire_api, is_enabled, updated_at)
                 VALUES ('prov-slow', 'Slow', ?1, 'prov-slow', 'chat', 1, ?2)",
                rusqlite::params![format!("http://{addr}/v1"), now],
            )
            .expect("provider");
            conn.execute(
                "INSERT INTO model_configs (id, model_id, display_name, provider, provider_id, is_enabled, is_default, updated_at)
                 VALUES ('model-slow', 'slow-model', 'Slow Model', 'openai', 'prov-slow', 1, 0, ?1)",
                rusqlite::params![now],
            )
            .expect("model");
            ads_state::save_model_service(
                &mut conn,
                ads_state::CONVERSATION_SERVICE,
                &["model-slow".to_string()],
                Some("model-slow"),
            )
            .expect("conversation service");
            conn.execute(
                "UPDATE role_profiles SET model_id = 'model-slow', is_enabled = 1 WHERE id = 'profile-default-reviewer'",
                [],
            )
            .expect("profile");
        }

        let cancellation = ads_native::Cancellation::new();
        let runner = default_reviewer_runner(
            db,
            Some(Duration::from_secs(60)),
            Some(Duration::from_millis(150)),
        );
        let err = runner(ReviewerRequest {
            payload: ReviewPayload {
                issue: ReviewIssue {
                    id: Some(757),
                    title: "Timeout classification".to_string(),
                    description: Some("Verify Incomplete + cancel".to_string()),
                    acceptance_criteria: Some(vec!["Returns Incomplete".to_string()]),
                },
                adrs: Some(Vec::new()),
                rework_declaration: None,
                diff_range: Some(ReviewDiffRange {
                    base_ref: "dev".to_string(),
                    head_ref: "fix/757".to_string(),
                    base_commit: Some(head.clone()),
                    head_commit: Some(head.clone()),
                    range: format!("{head}..{head}"),
                }),
                diff: "diff --git a/a.rs b/a.rs\n+fn main() {}\n".to_string(),
                diff_stat: Some("a.rs | 1 +".to_string()),
                diff_capture_error: None,
                related_contexts: Some(Vec::new()),
                related_context_omissions: Some(Vec::new()),
                verification_report: None,
            },
            repo_path: repo,
            profile_id: None,
            job_id: "job-757-native".to_string(),
            owner: "user-1".to_string(),
            cancellation: cancellation.clone(),
            verification_report: Arc::new(Mutex::new(ReviewVerificationReport::default())),
        })
        .await
        .expect_err("expected Incomplete timeout error");

        assert!(
            matches!(err, ReviewError::Incomplete(_)),
            "expected ReviewError::Incomplete, got {err:?}"
        );
        assert!(
            cancellation.is_cancelled(),
            "max_duration timeout must cancel the underlying inspection token"
        );
        server.abort();
    }
}
