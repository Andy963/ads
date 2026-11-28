use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_contract::time::now_unix_millis;
use ads_native::{Cancellation, find_security_violation};
use ads_reviewer::{
    ReviewPayload, ReviewTestReport, ReviewVerdict, ReviewVerdictStatus, ReviewVerificationReport,
    ReviewerError, build_review_prompt, parse_review_verdict,
};
use ads_state::{
    ROLE_REVIEWER, StateDb, derive_project_session_id, get_default_role_profile, get_model_config,
    get_role_profile_by_id, resolve_conversation_model,
};
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::watch;

use crate::bridge::{
    AcpStreamEvent, PendingPermissionRequest, PermissionDecision, PermissionHandler,
    resolve_permission_outcome,
};
use crate::driver::{AcpDriver, AcpLaunchContext, AcpSessionContext};
use crate::protocol::{PermissionOutcome, SessionMode, StopReason, ToolCallInfo};
use crate::session::{
    AcpPromptRequest, AcpSession, AcpSessionConfig, AcpTurnLiveness, DEFAULT_CANCEL_DRAIN_TIMEOUT,
    DesiredConfigAlignment, spawn_inactivity_watchdog,
};

pub const DEFAULT_REVIEWER_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const REVIEWER_IDLE_TIMEOUT_ENV: &str = "ADS_REVIEWER_IDLE_TIMEOUT_MS";
pub const REVIEWER_MAX_DURATION_ENV: &str = "ADS_REVIEWER_MAX_DURATION_MS";

const MAX_VERIFICATION_COMMANDS: usize = 32;
const MAX_VERIFICATION_OUTPUT_CHARS: usize = 6_000;
const MAX_SHELL_UNWRAP_DEPTH: usize = 6;
const DEFAULT_INCOMPLETE_SUMMARY: &str =
    "Reviewer reported insufficient evidence; developer rework was not requested.";

/// Resolves the activity-aware inactivity timeout for Actions Reviewer turns.
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

pub struct AcpReviewRequest {
    pub db: StateDb,
    pub driver: Arc<dyn AcpDriver>,
    pub payload: ReviewPayload,
    pub repo_path: PathBuf,
    pub profile_id: Option<String>,
    pub job_id: String,
    /// Activity-aware, tool-paused inactivity timeout (defaults to 15 minutes; `None` disables).
    pub idle_timeout: Option<Duration>,
    /// Optional opt-in hard wall-clock safety cap (`None` disables hard wall-clock termination).
    pub max_duration: Option<Duration>,
    pub cancellation: Cancellation,
    pub verification_report: Arc<StdMutex<ReviewVerificationReport>>,
}

/// Permission handler enforcing ADR 0066 & ADR 0060 read-only + verification boundaries
/// for ACP-backed Actions Reviewer sessions. Fails closed for unrecognized tool kinds.
#[derive(Debug, Default)]
pub struct ReviewVerificationPermissionHandler;

#[async_trait]
impl PermissionHandler for ReviewVerificationPermissionHandler {
    async fn request_permission(
        &self,
        request: PendingPermissionRequest,
        cancel: watch::Receiver<bool>,
    ) -> PermissionOutcome {
        if *cancel.borrow() {
            return PermissionOutcome::Cancelled;
        }
        let decision = classify_review_permission(&request.tool_call);
        resolve_permission_outcome(&request.options, decision)
    }
}

fn classify_review_permission(info: &ToolCallInfo) -> PermissionDecision {
    let kind = info
        .kind
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if matches!(
        kind.as_str(),
        "edit" | "write" | "delete" | "move" | "patch" | "file_change"
    ) {
        return PermissionDecision::DenyOnce;
    }

    if matches!(kind.as_str(), "read" | "search" | "list" | "think") {
        let title = info
            .title
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if title.contains("write")
            || title.contains("edit")
            || title.contains("delete")
            || title.contains("patch")
            || title.contains("apply")
            || title.contains("create")
            || title.contains("remove")
            || title.contains("rename")
            || title.contains("modify")
        {
            return PermissionDecision::DenyOnce;
        }
        return PermissionDecision::AllowOnce;
    }

    let command = extract_permission_command(info);
    if kind == "execute" || command.is_some() {
        let Some(cmd) = command else {
            return PermissionDecision::DenyOnce;
        };
        if find_security_violation(&cmd).is_some() || is_mutating_review_command(&cmd).is_some() {
            return PermissionDecision::DenyOnce;
        }
        return PermissionDecision::AllowOnce;
    }

    // Fail closed for unrecognized or missing tool kinds.
    PermissionDecision::DenyOnce
}

fn extract_permission_command(info: &ToolCallInfo) -> Option<String> {
    if let Some(cmd) = info
        .extra
        .get("normalized")
        .and_then(|v| v.get("command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Some(cmd.to_string());
    }
    if let Some(obj) = info.raw_input.as_ref().and_then(Value::as_object) {
        for key in [
            "command",
            "commandLine",
            "command_line",
            "cmd",
            "CommandLine",
        ] {
            if let Some(value) = obj.get(key) {
                if let Some(text) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) {
                    return Some(text.to_string());
                }
                if let Some(items) = value.as_array() {
                    let parts: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
                    if !parts.is_empty() {
                        return Some(parts.join(" "));
                    }
                }
            }
        }
    }
    if info
        .kind
        .as_deref()
        .map(str::trim)
        .is_some_and(|k| k.eq_ignore_ascii_case("execute"))
    {
        return info
            .title
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
    }
    None
}

struct AbortOnDrop(Option<tokio::task::JoinHandle<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

fn format_reviewer_duration(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs >= 60 && secs % 60 == 0 {
        let mins = secs / 60;
        if mins == 1 {
            "1 minute".to_string()
        } else {
            format!("{mins} minutes")
        }
    } else if secs > 0 {
        format!("{secs}s")
    } else {
        format!("{}ms", duration.as_millis())
    }
}

async fn shutdown_session_bounded(session: Arc<AcpSession>, deadline: Option<tokio::time::Instant>) {
    let Some(deadline) = deadline else {
        session.shutdown().await;
        return;
    };
    let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
        tokio::spawn(async move {
            session.shutdown().await;
        });
        return;
    };
    if remaining.is_zero() {
        tokio::spawn(async move {
            session.shutdown().await;
        });
        return;
    }
    let session_for_shutdown = Arc::clone(&session);
    if tokio::time::timeout(remaining, session_for_shutdown.shutdown())
        .await
        .is_err()
    {
        tokio::spawn(async move {
            session.shutdown().await;
        });
    }
}

/// Runs a clean-room, verification-bounded Actions Reviewer turn over any `AcpDriver`
/// (preserving ADR 0066 runtime unification and ADR 0060 verification capture).
///
/// Uses an activity-aware, tool-paused inactivity watchdog (`idle_timeout`) rather than a
/// hard wall-clock cutoff so long-running verification suites and deep inspections are never
/// killed while making progress. An optional `max_duration` safety ceiling is honored when
/// explicitly configured.
pub async fn run_acp_review(request: AcpReviewRequest) -> Result<ReviewVerdict, ReviewerError> {
    run_acp_review_with_retry(
        request,
        ads_native::resolve_transient_model_retry_count(),
        None,
    )
    .await
}

/// Variant of `run_acp_review` allowing explicit retry count and backoff schedule
/// (useful for deterministic testing).
pub async fn run_acp_review_with_retry(
    request: AcpReviewRequest,
    retry_count: usize,
    backoff_ms: Option<&[u64]>,
) -> Result<ReviewVerdict, ReviewerError> {
    let idle_timeout = request.idle_timeout.filter(|duration| !duration.is_zero());
    let max_duration = request.max_duration.filter(|duration| !duration.is_zero());
    let hard_deadline = max_duration.map(|cap| tokio::time::Instant::now() + cap);
    let max_duration_err = || {
        let label = max_duration
            .map(format_reviewer_duration)
            .unwrap_or_else(|| "configured limit".to_string());
        ReviewerError::Incomplete(format!("Reviewer exceeded maximum duration ({label})."))
    };
    let inactivity_err = || {
        let label = idle_timeout
            .map(format_reviewer_duration)
            .unwrap_or_else(|| "inactivity limit".to_string());
        ReviewerError::Incomplete(format!("Reviewer timed out after {label} of inactivity."))
    };

    if request.payload.diff_capture_error.is_some() {
        return Err(ReviewerError::Incomplete(
            "Reviewer evidence capture failed; no authoritative verdict is available.".to_string(),
        ));
    }
    request
        .cancellation
        .check()
        .map_err(|_| ReviewerError::Cancelled)?;

    let connection = request
        .db
        .connect()
        .map_err(|error| ReviewerError::Execution(error.to_string()))?;
    let profile = match request.profile_id.as_deref() {
        Some(profile_id) => get_role_profile_by_id(&connection, profile_id),
        None => get_default_role_profile(&connection, ROLE_REVIEWER),
    }
    .map_err(|error| ReviewerError::Execution(error.to_string()))?
    .ok_or_else(|| {
        ReviewerError::Execution(
            "Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt."
                .to_string(),
        )
    })?;
    if profile.role != ROLE_REVIEWER
        || profile.is_enabled != 1
        || profile.model_id.trim().is_empty()
        || profile.system_prompt.trim().is_empty()
    {
        return Err(ReviewerError::Execution(
            "Reviewer execution failed: configure an enabled Reviewer role profile with a model and system prompt."
                .to_string(),
        ));
    }
    let saved_model = match get_model_config(&connection, profile.model_id.trim())
        .map_err(|error| ReviewerError::Execution(error.to_string()))?
    {
        Some(saved) => Some(saved),
        None => resolve_conversation_model(&connection, profile.model_id.trim()).ok(),
    };
    let resolved_model_id = match saved_model {
        Some(saved) => {
            if saved
                .provider_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(ReviewerError::Execution(format!(
                    "Reviewer execution failed: model '{}' ({}) belongs to a Native provider and cannot run over ACP; route Reviewer to the Native runtime.",
                    saved.model_id, saved.id
                )));
            }
            let trimmed = saved.model_id.trim();
            if trimmed.is_empty() {
                profile.model_id.clone()
            } else {
                trimmed.to_string()
            }
        }
        None => profile.model_id.clone(),
    };
    drop(connection);

    let mut env = HashMap::new();
    let existing_path = std::env::var_os("PATH");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let cargo_home = std::env::var_os("CARGO_HOME").map(PathBuf::from);
    if let Some(augmented) = augment_path_with_cargo_bin(
        existing_path.as_deref(),
        home.as_deref(),
        cargo_home.as_deref(),
    ) {
        env.insert("PATH".to_string(), augmented);
    }

    let prompt = format!(
        "{}\n\n{}\n\nReview runtime protocol: you are operating as a detached, clean-room Reviewer. Do NOT edit files, apply patches, or run mutating git/gh commands (commit, push, checkout, reset, merge, close). Inspect the exact diff and repository files as needed, then run bounded, relevant verification commands (for example cargo test, cargo clippy, npm test, pytest) before returning PASS. Return ONLY a single JSON object matching {{\"status\": \"PASS\" | \"REJECT\" | \"INCOMPLETE\", \"summary\": \"...\", \"defects\": [...]}}. If required verification cannot be executed or evidence is missing, return INCOMPLETE and state the exact reason in summary.",
        profile.system_prompt.trim(),
        build_review_prompt(&request.payload)
    );

    let session_key = format!(
        "reviewer::{}::{}",
        derive_project_session_id(&request.repo_path.to_string_lossy()),
        request.job_id
    );
    let launch_ctx = AcpLaunchContext {
        session_key: session_key.clone(),
        workspace_root: request.repo_path.clone(),
        working_directory: Some(request.repo_path.clone()),
        env,
    };
    let session_ctx = AcpSessionContext {
        session_key,
        workspace_root: request.repo_path.clone(),
        working_directory: Some(request.repo_path.clone()),
        mcp_servers: Vec::new(),
    };
    let attempts = ads_native::max_attempts(retry_count);
    let mut completed_turn = None;

    for attempt in 1..=attempts {
        request
            .cancellation
            .check()
            .map_err(|_| ReviewerError::Cancelled)?;

        let mut transport_cfg = crate::transport::AcpTransportConfig::from_env();
        let mut cancel_drain_timeout = DEFAULT_CANCEL_DRAIN_TIMEOUT;
        if let Some(deadline) = hard_deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(max_duration_err());
            }
            transport_cfg.rpc_timeout = transport_cfg.rpc_timeout.min(remaining);
            transport_cfg.lifecycle_rpc_timeout =
                transport_cfg.lifecycle_rpc_timeout.min(remaining);
            cancel_drain_timeout = cancel_drain_timeout.min(remaining);
        }
        let session_cfg = AcpSessionConfig {
            transport: transport_cfg,
            // Never apply a hard wall-clock `prompt_timeout`; liveness is enforced by the
            // activity-aware, tool-paused watchdog (and optional `max_duration` ceiling).
            prompt_timeout: Duration::ZERO,
            cancel_drain_timeout,
            ..Default::default()
        };

        let unsafe_to_retry = Arc::new(AtomicBool::new(false));
        let inactivity_timed_out = Arc::new(AtomicBool::new(false));
        let active_session: Arc<StdMutex<Option<Arc<AcpSession>>>> = Arc::new(StdMutex::new(None));

        let attempt_fut = async {
            let session = tokio::select! {
                biased;
                _ = request.cancellation.cancelled() => {
                    return Err(("ACP reviewer spawn failed", crate::error::AcpError::Cancelled));
                }
                res = AcpSession::spawn(
                    Arc::clone(&request.driver),
                    &launch_ctx,
                    Arc::new(ReviewVerificationPermissionHandler),
                    session_cfg,
                ) => res.map_err(|error| ("ACP reviewer spawn failed", error))?,
            };
            *active_session.lock().expect("active review session lock") =
                Some(Arc::clone(&session));

            let init_res = tokio::select! {
                biased;
                _ = request.cancellation.cancelled() => Err(crate::error::AcpError::Cancelled),
                res = session.initialize() => res.map(|_| ()),
            };
            if let Err(error) = init_res {
                return Err(("ACP reviewer initialize failed", error));
            }

            let new_session_res = tokio::select! {
                biased;
                _ = request.cancellation.cancelled() => Err(crate::error::AcpError::Cancelled),
                res = session.new_session(&session_ctx) => res.map(|_| ()),
            };
            if let Err(error) = new_session_res {
                return Err(("ACP reviewer session creation failed", error));
            }

            let (cancel_tx, cancel_rx) = watch::channel(request.cancellation.is_cancelled());
            let cancel_tx_for_bridge = cancel_tx.clone();
            let cancellation = request.cancellation.clone();
            let _cancel_bridge = AbortOnDrop(Some(tokio::spawn(async move {
                cancellation.cancelled().await;
                let _ = cancel_tx_for_bridge.send(true);
            })));

            let liveness = AcpTurnLiveness::new();
            let (watchdog_stop_tx, watchdog_stop_rx) = watch::channel(false);
            let _watchdog = AbortOnDrop(idle_timeout.map(|timeout| {
                spawn_inactivity_watchdog(
                    timeout,
                    Arc::clone(&liveness),
                    Arc::clone(&inactivity_timed_out),
                    cancel_tx.clone(),
                    watchdog_stop_rx,
                )
            }));

            let prompt_req = AcpPromptRequest::text(request.job_id.clone(), prompt.clone())
                .with_alignment(DesiredConfigAlignment {
                    mode: Some(SessionMode::Plan),
                    model: Some(resolved_model_id.clone()),
                    thought_level: Some(profile.reasoning_effort.clone()),
                    extra_options: Vec::new(),
                })
                .with_cancel(cancel_rx)
                .with_liveness(liveness)
                .with_retry_fence(Arc::clone(&unsafe_to_retry));

            let prompt_res = session.prompt(prompt_req).await;
            let _ = watchdog_stop_tx.send(true);
            prompt_res.map_err(|error| ("ACP reviewer execution failed", error))
        };

        let attempt_res = match hard_deadline {
            Some(deadline) => match tokio::time::timeout_at(deadline, attempt_fut).await {
                Ok(result) => {
                    let spawned_session = active_session
                        .lock()
                        .expect("active review session lock")
                        .take();
                    if let Some(session) = spawned_session {
                        shutdown_session_bounded(session, Some(deadline)).await;
                    }
                    result
                }
                Err(_) => {
                    let spawned_session = active_session
                        .lock()
                        .expect("active review session lock")
                        .take();
                    if let Some(session) = spawned_session {
                        tokio::spawn(async move {
                            session.shutdown().await;
                        });
                    }
                    if request.cancellation.is_cancelled() {
                        return Err(ReviewerError::Cancelled);
                    }
                    return Err(max_duration_err());
                }
            },
            None => {
                let result = attempt_fut.await;
                let spawned_session = active_session
                    .lock()
                    .expect("active review session lock")
                    .take();
                if let Some(session) = spawned_session {
                    shutdown_session_bounded(session, None).await;
                }
                result
            }
        };

        let is_inactivity_timed_out = inactivity_timed_out.load(Ordering::Acquire);
        match attempt_res {
            Ok(turn) => {
                if is_inactivity_timed_out {
                    return Err(inactivity_err());
                }
                if request.cancellation.is_cancelled() || turn.stop_reason == StopReason::Cancelled {
                    return Err(ReviewerError::Cancelled);
                }
                completed_turn = Some(turn);
                break;
            }
            Err((stage, error)) => {
                if is_inactivity_timed_out {
                    return Err(inactivity_err());
                }
                if request.cancellation.is_cancelled() || error.is_cancelled() {
                    return Err(ReviewerError::Cancelled);
                }
                if error.is_timeout() {
                    if let Some(deadline) = hard_deadline
                        && tokio::time::Instant::now() >= deadline
                    {
                        return Err(max_duration_err());
                    }
                    return Err(ReviewerError::Incomplete(format!("{stage}: {error}")));
                }
                let can_retry = attempt < attempts
                    && !unsafe_to_retry.load(Ordering::Acquire)
                    && error.is_retryable();
                if can_retry {
                    let delay_ms = ads_native::resolve_transient_retry_delay_ms(
                        &error.to_string(),
                        attempt,
                        backoff_ms,
                        now_unix_millis(),
                    );
                    if let Some(deadline) = hard_deadline {
                        let remaining_after =
                            deadline.saturating_duration_since(tokio::time::Instant::now());
                        if remaining_after.is_zero() {
                            return Err(max_duration_err());
                        }
                        if Duration::from_millis(delay_ms) < remaining_after {
                            if delay_ms > 0 {
                                tokio::select! {
                                    biased;
                                    _ = request.cancellation.cancelled() => {
                                        return Err(ReviewerError::Cancelled);
                                    }
                                    _ = tokio::time::sleep_until(deadline) => {
                                        return Err(max_duration_err());
                                    }
                                    _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                                }
                            }
                            continue;
                        }
                    } else {
                        if delay_ms > 0 {
                            tokio::select! {
                                biased;
                                _ = request.cancellation.cancelled() => {
                                    return Err(ReviewerError::Cancelled);
                                }
                                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                            }
                        }
                        continue;
                    }
                }
                return Err(ReviewerError::Execution(format!("{stage}: {error}")));
            }
        }
    }

    let turn = completed_turn
        .ok_or_else(|| ReviewerError::Execution("ACP reviewer retry loop exhausted".to_string()))?;

    record_acp_verification_events(&request.verification_report, &turn.events);

    let trimmed = turn.response_text.trim();
    if trimmed.is_empty() {
        return Err(ReviewerError::Incomplete(
            DEFAULT_INCOMPLETE_SUMMARY.to_string(),
        ));
    }

    let verdict = parse_review_verdict(trimmed, Some(&profile.id))?;
    if verdict.status == ReviewVerdictStatus::Incomplete && verdict.summary.trim().is_empty() {
        return Err(ReviewerError::Incomplete(
            DEFAULT_INCOMPLETE_SUMMARY.to_string(),
        ));
    }
    Ok(verdict)
}

fn record_acp_verification_events(
    verification_report: &Arc<StdMutex<ReviewVerificationReport>>,
    events: &[AcpStreamEvent],
) {
    let mut index_by_tool_call_id: HashMap<String, usize> = HashMap::new();
    let mut report = verification_report
        .lock()
        .expect("verification report lock");

    for event in events {
        let AcpStreamEvent::ToolCall { tool_call, .. } = event else {
            continue;
        };
        let status = tool_call
            .status
            .as_deref()
            .map(str::trim)
            .unwrap_or_default();
        if !matches!(status, "completed" | "failed" | "declined") {
            continue;
        }
        let Some(command) = extract_permission_command(tool_call) else {
            continue;
        };
        let command = command.trim();
        if command.is_empty() || !is_verification_command(command) {
            continue;
        }
        let started = status != "declined";
        let normalized = tool_call.extra.get("normalized").and_then(Value::as_object);
        let raw_output_obj = tool_call.raw_output.as_ref().and_then(Value::as_object);
        let exit_code = normalized
            .and_then(|obj| obj.get("exitCode").and_then(Value::as_i64))
            .or_else(|| tool_call.extra.get("exit_code").and_then(Value::as_i64))
            .or_else(|| {
                raw_output_obj.and_then(|obj| {
                    obj.get("exitCode")
                        .or_else(|| obj.get("exit_code"))
                        .and_then(Value::as_i64)
                })
            })
            .unwrap_or(if status == "completed" { 0 } else { 1 });
        let raw_output = normalized
            .and_then(|obj| obj.get("aggregatedOutput").and_then(Value::as_str))
            .or_else(|| {
                raw_output_obj.and_then(|obj| {
                    obj.get("aggregatedOutput")
                        .or_else(|| obj.get("aggregated_output"))
                        .or_else(|| obj.get("combinedOutput"))
                        .or_else(|| obj.get("output"))
                        .or_else(|| obj.get("stdout"))
                        .and_then(Value::as_str)
                })
            })
            .unwrap_or("")
            .trim();
        let output = if raw_output.is_empty() {
            None
        } else {
            Some(truncate_tail_chars(
                raw_output,
                MAX_VERIFICATION_OUTPUT_CHARS,
            ))
        };
        let summary = if exit_code == 0 && started {
            "Verification command exited with code 0".to_string()
        } else if !started {
            "Verification command was declined".to_string()
        } else {
            raw_output
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| truncate_tail_chars(line.trim(), 500))
                .unwrap_or_else(|| format!("Verification command exited with code {exit_code}"))
        };

        let entry = ReviewTestReport {
            command: command.to_string(),
            exit_code,
            summary,
            output,
            started,
        };
        if !tool_call.tool_call_id.is_empty()
            && let Some(&existing_idx) = index_by_tool_call_id.get(&tool_call.tool_call_id)
        {
            report.commands[existing_idx] = entry;
            continue;
        }
        if report.commands.len() < MAX_VERIFICATION_COMMANDS {
            let idx = report.commands.len();
            report.commands.push(entry);
            if !tool_call.tool_call_id.is_empty() {
                index_by_tool_call_id.insert(tool_call.tool_call_id.clone(), idx);
            }
        }
    }
}

fn truncate_tail_chars(input: &str, max_chars: usize) -> String {
    let count = input.chars().count();
    if count <= max_chars {
        return input.to_string();
    }
    input.chars().skip(count - max_chars).collect()
}

pub fn augment_path_with_cargo_bin(
    existing_path: Option<&OsStr>,
    home: Option<&Path>,
    cargo_home: Option<&Path>,
) -> Option<String> {
    let cargo_bin = cargo_home
        .map(Path::to_path_buf)
        .or_else(|| home.map(|home| home.join(".cargo")))?
        .join("bin");
    if !cargo_bin.is_dir() {
        return None;
    }
    let mut paths: Vec<PathBuf> = existing_path
        .map(|value| std::env::split_paths(value).collect())
        .unwrap_or_default();
    if paths.iter().any(|entry| entry == &cargo_bin) {
        return None;
    }
    paths.insert(0, cargo_bin);
    std::env::join_paths(paths)
        .ok()
        .map(|joined| joined.to_string_lossy().into_owned())
}

pub fn is_mutating_review_command(command: &str) -> Option<&'static str> {
    is_mutating_review_command_inner(command, 0)
}

fn is_mutating_review_command_inner(command: &str, depth: usize) -> Option<&'static str> {
    if depth >= MAX_SHELL_UNWRAP_DEPTH {
        return Some("Reviewer cannot execute deeply nested shell commands.");
    }
    if find_security_violation(command).is_some() {
        return Some("Reviewer command violated ADS security policy.");
    }
    let unwrapped = unwrap_shell_command(command);
    if unwrapped != command.trim() {
        return is_mutating_review_command_inner(&unwrapped, depth + 1);
    }

    for segment in split_command_segments(&unwrapped) {
        if has_unsafe_output_redirection(&segment) {
            return Some("Reviewer cannot write files via shell output redirection.");
        }
        let tokens = tokenize_segment(&segment);
        let Some((program, args)) = extract_program_and_args(&tokens) else {
            continue;
        };

        // Recursively inspect nested shell commands (`sh`/`bash`/`zsh`/`dash -c|-lc ...`).
        if matches!(program.as_str(), "sh" | "bash" | "zsh" | "dash")
            && let Some(nested) = extract_shell_inline_script(args)
        {
            if let Some(reason) = is_mutating_review_command_inner(&nested, depth + 1) {
                return Some(reason);
            }
            continue;
        }

        match program.as_str() {
            "apply_patch" | "patch" => {
                return Some("Reviewer cannot apply patches or modify repository files.");
            }
            "rm" | "rmdir" | "mv" | "cp" | "tee" | "touch" | "mkdir" | "ln" | "chmod" | "chown"
            | "chgrp" | "truncate" | "dd" | "install" => {
                return Some("Reviewer cannot execute file-mutating shell commands.");
            }
            "sed"
                if args
                    .iter()
                    .any(|arg| arg == "--in-place" || arg == "-i" || arg.starts_with("-i")) =>
            {
                return Some("Reviewer cannot modify files in place with sed.");
            }
            "perl"
                if args.iter().any(|arg| {
                    arg == "-i"
                        || (arg.starts_with('-')
                            && !arg.starts_with("--")
                            && arg.chars().skip(1).any(|ch| ch == 'i'))
                }) =>
            {
                return Some("Reviewer cannot modify files in place with perl.");
            }
            "env" => {
                return Some("Reviewer cannot use unsupported or split-string env options.");
            }
            "timeout" => {
                return Some("Reviewer cannot use unrecognized timeout options.");
            }
            "find" => {
                if let Some(reason) = inspect_mutating_find(args, depth) {
                    return Some(reason);
                }
            }
            "xargs" => {
                if let Some(reason) = inspect_mutating_xargs(args, depth) {
                    return Some(reason);
                }
            }
            "git" => {
                if let Some((subcommand, sub_args)) = extract_git_subcommand(args) {
                    if matches!(
                        subcommand,
                        "add"
                            | "am"
                            | "apply"
                            | "cherry-pick"
                            | "checkout"
                            | "clean"
                            | "clone"
                            | "commit"
                            | "fetch"
                            | "init"
                            | "merge"
                            | "mv"
                            | "pull"
                            | "push"
                            | "rebase"
                            | "reset"
                            | "restore"
                            | "revert"
                            | "rm"
                            | "stash"
                            | "switch"
                            | "tag"
                            | "worktree"
                    ) {
                        return Some("Reviewer cannot execute mutating git commands.");
                    }
                    if subcommand == "config" && is_mutating_git_config(sub_args) {
                        return Some("Reviewer cannot modify git configuration.");
                    }
                    if subcommand == "remote" && is_mutating_git_remote(sub_args) {
                        return Some("Reviewer cannot modify git remotes.");
                    }
                    if subcommand == "branch"
                        && sub_args.iter().any(|arg| {
                            matches!(
                                arg.as_str(),
                                "-d" | "-D"
                                    | "-m"
                                    | "-M"
                                    | "-c"
                                    | "-C"
                                    | "--delete"
                                    | "--move"
                                    | "--copy"
                                    | "--edit-description"
                                    | "--unset-upstream"
                            ) || arg.starts_with("--set-upstream-to")
                        })
                    {
                        return Some("Reviewer cannot modify or delete git branches.");
                    }
                }
            }
            "gh" => {
                let first = args.first().map(String::as_str).unwrap_or("");
                let second = args.get(1).map(String::as_str).unwrap_or("");
                let mutating = match first {
                    "pr" => matches!(
                        second,
                        "merge"
                            | "edit"
                            | "close"
                            | "create"
                            | "reopen"
                            | "review"
                            | "comment"
                            | "ready"
                    ),
                    "issue" => matches!(
                        second,
                        "close" | "edit" | "create" | "reopen" | "delete" | "comment" | "transfer"
                    ),
                    "release" => matches!(second, "create" | "delete" | "edit"),
                    _ => false,
                };
                if mutating {
                    return Some("Reviewer cannot execute mutating GitHub CLI commands.");
                }
            }
            "cargo" => {
                let sub = args.first().map(String::as_str).unwrap_or("");
                if sub == "fmt" && !args.iter().any(|arg| arg == "--check") {
                    return Some("Reviewer cannot format files in place; use cargo fmt --check.");
                }
                if sub == "fix" || (sub == "clippy" && args.iter().any(|arg| arg == "--fix")) {
                    return Some("Reviewer cannot apply automatic cargo fixes.");
                }
            }
            "npm" | "pnpm" | "yarn" | "bun"
                if args.iter().any(|arg| {
                    matches!(
                        arg.as_str(),
                        "install" | "i" | "add" | "remove" | "uninstall" | "update" | "upgrade"
                    )
                }) =>
            {
                return Some("Reviewer cannot mutate package dependencies.");
            }
            _ => {}
        }
    }
    None
}

fn has_unsafe_output_redirection(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    while i < bytes.len() {
        let ch = bytes[i] as char;
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            i += 1;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if !in_single && !in_double && ch == '>' {
            let mut j = i + 1;
            // Skip second `>` for append (`>>`) or `|` for clobber (`>|`).
            if j < bytes.len() && matches!(bytes[j], b'>' | b'|') {
                j += 1;
            }
            // Allow fd duplication (`2>&1`, `1>&2`, `>&2`).
            if j < bytes.len() && bytes[j] == b'&' {
                let after_amp = j + 1;
                if after_amp < bytes.len()
                    && (bytes[after_amp].is_ascii_digit() || bytes[after_amp] == b'-')
                {
                    i = after_amp + 1;
                    continue;
                }
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let rest = &segment[j..];
            let target = rest
                .split(|c: char| c.is_whitespace() || matches!(c, ';' | '|' | '&'))
                .next()
                .unwrap_or("");
            if target == "/dev/null" {
                i = j + target.len();
                continue;
            }
            return true;
        }
        i += 1;
    }
    false
}

fn extract_shell_inline_script(args: &[String]) -> Option<String> {
    let mut index = 0usize;
    let mut saw_command_flag = false;
    while index < args.len() {
        let arg = args[index].as_str();
        if matches!(arg, "--" | "-") {
            index += 1;
            break;
        }
        if let Some(script) = arg.strip_prefix("--command=") {
            if !script.trim().is_empty() {
                return Some(script.to_string());
            }
            return None;
        }
        if arg == "--command" {
            saw_command_flag = true;
            index += 1;
            continue;
        }
        if matches!(arg, "-o" | "+o" | "-O" | "+O" | "--rcfile" | "--init-file") {
            index = (index + 2).min(args.len());
            continue;
        }
        if arg.starts_with("--") {
            index += 1;
            continue;
        }
        if (arg.starts_with('-') || arg.starts_with('+')) && arg.len() > 1 {
            let is_minus = arg.starts_with('-');
            let mut extra_args = 0usize;
            for ch in arg[1..].chars() {
                if is_minus && ch == 'c' {
                    saw_command_flag = true;
                }
                if matches!(ch, 'o' | 'O') {
                    extra_args += 1;
                }
            }
            index = (index + 1 + extra_args).min(args.len());
            continue;
        }
        if saw_command_flag {
            let script = args[index..].join(" ");
            if !script.trim().is_empty() {
                return Some(script);
            }
        }
        return None;
    }
    if saw_command_flag && index < args.len() {
        let script = args[index..].join(" ");
        if !script.trim().is_empty() {
            return Some(script);
        }
    }
    None
}

fn find_primary_arity(arg: &str) -> usize {
    if matches!(
        arg,
        "-name"
            | "-iname"
            | "-path"
            | "-ipath"
            | "-wholename"
            | "-iwholename"
            | "-lname"
            | "-ilname"
            | "-regex"
            | "-iregex"
            | "-regextype"
            | "-type"
            | "-xtype"
            | "-maxdepth"
            | "-mindepth"
            | "-mtime"
            | "-mmin"
            | "-atime"
            | "-amin"
            | "-ctime"
            | "-cmin"
            | "-newer"
            | "-anewer"
            | "-cnewer"
            | "-size"
            | "-perm"
            | "-user"
            | "-uid"
            | "-group"
            | "-gid"
            | "-inum"
            | "-samefile"
            | "-links"
            | "-fstype"
            | "-printf"
            | "-context"
            | "-used"
            | "-files0-from"
    ) || (arg.starts_with("-newer") && arg.len() == 8)
    {
        return 1;
    }
    0
}

fn inspect_mutating_find(args: &[String], depth: usize) -> Option<&'static str> {
    let mut index = 0usize;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "-delete" {
            return Some("Reviewer cannot delete files with find -delete.");
        }
        if matches!(arg, "-fprint" | "-fprint0" | "-fprintf" | "-fls") {
            return Some("Reviewer cannot write files with find output actions.");
        }
        if matches!(arg, "-exec" | "-execdir" | "-ok" | "-okdir") {
            let allows_plus = matches!(arg, "-exec" | "-execdir");
            let cmd_start = index + 1;
            let mut cmd_end = cmd_start;
            while cmd_end < args.len() {
                let token = args[cmd_end].as_str();
                if token == ";" {
                    break;
                }
                if allows_plus && token == "+" && cmd_end > cmd_start && args[cmd_end - 1] == "{}" {
                    break;
                }
                cmd_end += 1;
            }
            if cmd_start < cmd_end {
                let rebuilt = rebuild_shell_command(&args[cmd_start..cmd_end]);
                if let Some(reason) = is_mutating_review_command_inner(&rebuilt, depth + 1) {
                    return Some(reason);
                }
            }
            index = cmd_end + 1;
            continue;
        }
        let arity = find_primary_arity(arg);
        if arity > 0 {
            index = (index + 1 + arity).min(args.len());
            continue;
        }
        index += 1;
    }
    None
}

fn inspect_mutating_xargs(args: &[String], depth: usize) -> Option<&'static str> {
    let mut index = 0usize;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "--" {
            index += 1;
            break;
        }
        // GNU xargs long options that always take a separate argument (optional-arg options
        // like --eof, --replace, --max-lines only accept values via `=` and take 1 token alone).
        if matches!(
            arg,
            "--arg-file"
                | "--delimiter"
                | "--max-args"
                | "--max-procs"
                | "--max-chars"
                | "--process-slot-var"
        ) {
            index = (index + 2).min(args.len());
            continue;
        }
        if is_known_single_token_xargs_long_option(arg) {
            index += 1;
            continue;
        }
        if arg.starts_with("--") {
            // Fail closed on unrecognized or abbreviated GNU getopt_long options (e.g. --max-p).
            return Some("Reviewer cannot use unrecognized xargs options.");
        }
        if arg.starts_with('-') && arg.len() > 1 {
            let mut consumed_next = false;
            let chars: Vec<char> = arg[1..].chars().collect();
            for (pos, ch) in chars.iter().enumerate() {
                if matches!(ch, '0' | 'o' | 'p' | 'r' | 't' | 'x') {
                    continue;
                }
                if matches!(ch, 'a' | 'd' | 'E' | 'I' | 'L' | 'n' | 'P' | 's') {
                    // If characters follow in the same token, they are the attached value;
                    // otherwise the value is the next argv token.
                    if pos + 1 == chars.len() {
                        consumed_next = true;
                    }
                    break;
                }
                // Optional-value short options (-i, -e, -l) consume the rest of the current token
                // when attached, never the next whitespace-separated token.
                if matches!(ch, 'i' | 'e' | 'l') {
                    break;
                }
                return Some("Reviewer cannot use unrecognized xargs options.");
            }
            index = (index + if consumed_next { 2 } else { 1 }).min(args.len());
            continue;
        }
        break;
    }
    if index >= args.len() {
        return None;
    }
    let rebuilt = rebuild_shell_command(&args[index..]);
    is_mutating_review_command_inner(&rebuilt, depth + 1)
}

fn is_known_single_token_xargs_long_option(arg: &str) -> bool {
    if matches!(
        arg,
        "--null"
            | "--open-tty"
            | "--interactive"
            | "--no-run-if-empty"
            | "--show-limits"
            | "--verbose"
            | "--exit"
            | "--help"
            | "--version"
            | "--eof"
            | "--replace"
            | "--max-lines"
    ) {
        return true;
    }
    [
        "--arg-file=",
        "--delimiter=",
        "--max-args=",
        "--max-procs=",
        "--max-chars=",
        "--process-slot-var=",
        "--eof=",
        "--replace=",
        "--max-lines=",
    ]
    .iter()
    .any(|prefix| arg.starts_with(prefix))
}

fn rebuild_shell_command(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| {
            if token.is_empty()
                || token
                    .chars()
                    .any(|ch| ch.is_whitespace() || matches!(ch, '\'' | '"' | '\\' | ';' | '|' | '&' | '>' | '<'))
            {
                let escaped = token.replace('\'', "'\\''");
                format!("'{escaped}'")
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_mutating_git_config(sub_args: &[String]) -> bool {
    let mut explicit_read_flag = false;
    let mut positional: Vec<&str> = Vec::new();
    let mut index = 0usize;
    let mut after_double_dash = false;

    while index < sub_args.len() {
        let arg = sub_args[index].as_str();
        if !after_double_dash {
            if arg == "--" {
                after_double_dash = true;
                index += 1;
                continue;
            }
            if matches!(
                arg,
                "--add"
                    | "--unset"
                    | "--unset-all"
                    | "--replace-all"
                    | "--rename-section"
                    | "--remove-section"
                    | "--edit"
            ) {
                return true;
            }
            if arg.starts_with('-')
                && !arg.starts_with("--")
                && arg[1..].chars().any(|ch| ch == 'e')
            {
                return true;
            }
            if matches!(
                arg,
                "--get"
                    | "--get-all"
                    | "--get-regexp"
                    | "--get-urlmatch"
                    | "--list"
                    | "--get-color"
                    | "--get-colorbool"
                    | "--help"
            ) || (arg.starts_with('-')
                && !arg.starts_with("--")
                && arg[1..].chars().all(|ch| matches!(ch, 'l' | 'h' | 'z'))
                && arg[1..].chars().any(|ch| matches!(ch, 'l' | 'h')))
            {
                explicit_read_flag = true;
                index += 1;
                continue;
            }
            if matches!(arg, "-f" | "--file" | "--blob" | "-t" | "--type" | "--default") {
                index = (index + 2).min(sub_args.len());
                continue;
            }
            if is_known_readonly_git_config_flag(arg) {
                index += 1;
                continue;
            }
            if arg.starts_with('-') {
                // Unknown option before any positional key: fail closed.
                return true;
            }
            // git config parses options with PARSE_OPT_STOP_AT_NON_OPTION:
            // handle git 2.46+ subcommands on the first positional token, otherwise
            // stop option parsing so every token after <key> is treated as a value.
            if positional.is_empty() && !explicit_read_flag {
                if matches!(
                    arg,
                    "set" | "unset" | "rename-section" | "remove-section" | "edit"
                ) {
                    return true;
                }
                if matches!(arg, "list" | "get") {
                    return false;
                }
            }
            after_double_dash = true;
        }
        positional.push(arg);
        index += 1;
    }

    if explicit_read_flag {
        return false;
    }
    // `git config <key> <value>` (2+ positional args without read flag) writes config.
    positional.len() >= 2
}

fn is_known_readonly_git_config_flag(arg: &str) -> bool {
    if matches!(
        arg,
        "--local"
            | "--global"
            | "--system"
            | "--worktree"
            | "--includes"
            | "--no-includes"
            | "--show-origin"
            | "--show-scope"
            | "--name-only"
            | "--null"
            | "-z"
            | "--bool"
            | "--int"
            | "--bool-or-int"
            | "--bool-or-str"
            | "--path"
            | "--expiry-date"
            | "--no-type"
            | "--fixed-value"
    ) {
        return true;
    }
    if [
        "--file=",
        "--blob=",
        "--type=",
        "--default=",
        "-f",
        "-t",
    ]
    .iter()
    .any(|prefix| arg.starts_with(prefix) && arg.len() > prefix.len())
    {
        return true;
    }
    false
}

fn is_mutating_git_remote(sub_args: &[String]) -> bool {
    let first_subcommand = sub_args.iter().find(|arg| !arg.starts_with('-'));
    match first_subcommand.map(String::as_str) {
        None | Some("show") | Some("get-url") => false,
        Some(_) => true,
    }
}

pub fn is_verification_command(command: &str) -> bool {
    let unwrapped = unwrap_shell_command(command);
    for segment in split_command_segments(&unwrapped) {
        let tokens = tokenize_segment(&segment);
        let Some((program, args)) = extract_program_and_args(&tokens) else {
            continue;
        };
        if segment_is_verification(&program, args) {
            return true;
        }
    }
    false
}

fn segment_is_verification(program: &str, args: &[String]) -> bool {
    match program {
        "cargo" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "test" | "check" | "clippy" | "fmt" | "build" | "nextest" | "bench"
            )
        }),
        "rustc" => true,
        "npm" | "pnpm" | "yarn" | "bun" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "test" | "run" | "exec" | "check" | "typecheck" | "lint" | "build"
            )
        }),
        "npx" => args.first().is_some_and(|tool| {
            matches!(
                tool.as_str(),
                "tsc"
                    | "vue-tsc"
                    | "eslint"
                    | "vitest"
                    | "jest"
                    | "mocha"
                    | "playwright"
                    | "prettier"
                    | "biome"
                    | "svelte-check"
            )
        }),
        "tsc" | "vue-tsc" | "eslint" | "vitest" | "jest" | "mocha" | "biome" | "ruff" | "mypy"
        | "flake8" | "pyright" | "pytest" | "ctest" | "rspec" | "phpunit" | "shellcheck" => true,
        "node" => args.iter().any(|arg| {
            arg == "--test"
                || arg.contains("test")
                || arg.contains("conformance")
                || arg.contains("verify")
        }),
        "python" | "python3" => args.windows(2).any(|pair| {
            pair[0] == "-m"
                && matches!(
                    pair[1].as_str(),
                    "pytest" | "unittest" | "mypy" | "ruff" | "py_compile"
                )
        }),
        "go" => args
            .first()
            .is_some_and(|sub| matches!(sub.as_str(), "test" | "vet" | "build")),
        "make" | "just" => args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "test" | "check" | "lint" | "verify" | "build" | "typecheck"
            )
        }),
        "zig" => args
            .first()
            .is_some_and(|sub| matches!(sub.as_str(), "test" | "build")),
        "dotnet" => args
            .first()
            .is_some_and(|sub| matches!(sub.as_str(), "test" | "build")),
        "mvn" | "gradle" | "gradlew" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "check" | "verify" | "build")),
        "mix" => args
            .first()
            .is_some_and(|sub| matches!(sub.as_str(), "test" | "compile" | "credo")),
        _ => false,
    }
}

fn unwrap_shell_command(command: &str) -> String {
    let trimmed = command.trim();
    if split_command_segments(trimmed).len() != 1 || has_unsafe_output_redirection(trimmed) {
        return trimmed.to_string();
    }
    let tokens = tokenize_segment(trimmed);
    if let Some((exe, args)) = extract_program_and_args(&tokens)
        && matches!(exe.as_str(), "sh" | "bash" | "zsh" | "dash")
        && let Some(script) = extract_shell_inline_script(args)
    {
        return script;
    }
    trimmed.to_string()
}

fn split_command_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = command.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && !in_single {
            current.push(ch);
            escaped = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            current.push(ch);
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            current.push(ch);
            continue;
        }
        if !in_single && !in_double {
            if ch == ';' || ch == '\n' {
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                continue;
            }
            if (ch == '&' || ch == '|') && chars.peek() == Some(&ch) {
                chars.next();
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                continue;
            }
            if ch == '|' {
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                } else {
                    current.clear();
                }
                continue;
            }
            if ch == '&' {
                // Keep fd/combined redirections (`>&`, `<&`, `&>`) intact inside the segment.
                let prev_is_redir = current.ends_with('>') || current.ends_with('<');
                let next_is_redir = chars.peek() == Some(&'>');
                if !prev_is_redir && !next_is_redir {
                    if !current.trim().is_empty() {
                        segments.push(std::mem::take(&mut current));
                    } else {
                        current.clear();
                    }
                    continue;
                }
            }
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        segments.push(current);
    }
    segments
}

fn tokenize_segment(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut has_token = false;

    for ch in segment.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            has_token = true;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            has_token = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            has_token = true;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            has_token = true;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if has_token {
                tokens.push(std::mem::take(&mut current));
                has_token = false;
            }
            continue;
        }
        current.push(ch);
        has_token = true;
    }
    if has_token {
        tokens.push(current);
    }
    tokens
}

fn extract_program_and_args(tokens: &[String]) -> Option<(String, &[String])> {
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if is_env_assignment(token) {
            index += 1;
            continue;
        }
        let base = Path::new(token)
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or(token);
        if matches!(base, "env" | "command") {
            let wrapper_idx = index;
            index += 1;
            while index < tokens.len() {
                let current = tokens[index].as_str();
                if current == "--" {
                    index += 1;
                    break;
                }
                if base == "env" {
                    if current == "-" {
                        index += 1;
                        continue;
                    }
                    if matches!(current, "--unset" | "--chdir" | "--argv0") {
                        index = (index + 2).min(tokens.len());
                        continue;
                    }
                    if is_known_single_token_env_long_option(current) {
                        index += 1;
                        continue;
                    }
                    if current.starts_with("--") {
                        // Fail closed on --split-string*, GNU getopt_long prefix abbreviations
                        // (--uns, --chd, --split), or any unrecognized long option.
                        return Some(("env".to_string(), &tokens[wrapper_idx + 1..]));
                    }
                    if current.starts_with('-') && current.len() > 1 {
                        let chars: Vec<char> = current[1..].chars().collect();
                        let mut consumed_next = false;
                        for (pos, ch) in chars.iter().enumerate() {
                            if matches!(ch, 'i' | '0' | 'v') {
                                continue;
                            }
                            if matches!(ch, 'u' | 'C') {
                                if pos + 1 == chars.len() {
                                    consumed_next = true;
                                }
                                break;
                            }
                            // Fail closed on -S, -a, or any unrecognized short option.
                            return Some(("env".to_string(), &tokens[wrapper_idx + 1..]));
                        }
                        index = (index + if consumed_next { 2 } else { 1 }).min(tokens.len());
                        continue;
                    }
                } else if current.starts_with('-') && current.len() > 1 {
                    index += 1;
                    continue;
                }
                if is_env_assignment(current) {
                    index += 1;
                    continue;
                }
                break;
            }
            continue;
        }
        if base == "timeout" {
            let wrapper_idx = index;
            index += 1;
            while index < tokens.len() {
                let current = tokens[index].as_str();
                if current == "--" {
                    index += 1;
                    break;
                }
                if matches!(current, "--kill-after" | "--signal") {
                    index = (index + 2).min(tokens.len());
                    continue;
                }
                if matches!(
                    current,
                    "--preserve-status"
                        | "--foreground"
                        | "--verbose"
                        | "--help"
                        | "--version"
                ) || current.starts_with("--kill-after=")
                    || current.starts_with("--signal=")
                {
                    index += 1;
                    continue;
                }
                if current.starts_with("--") {
                    return Some(("timeout".to_string(), &tokens[wrapper_idx + 1..]));
                }
                if current.starts_with('-') && current.len() > 1 {
                    let chars: Vec<char> = current[1..].chars().collect();
                    let mut consumed_next = false;
                    for (pos, ch) in chars.iter().enumerate() {
                        if *ch == 'v' {
                            continue;
                        }
                        if matches!(ch, 'k' | 's') {
                            if pos + 1 == chars.len() {
                                consumed_next = true;
                            }
                            break;
                        }
                        return Some(("timeout".to_string(), &tokens[wrapper_idx + 1..]));
                    }
                    index = (index + if consumed_next { 2 } else { 1 }).min(tokens.len());
                    continue;
                }
                break;
            }
            if index < tokens.len() {
                index += 1;
            }
            continue;
        }
        return Some((base.to_string(), &tokens[index + 1..]));
    }
    None
}

fn is_known_single_token_env_long_option(arg: &str) -> bool {
    if matches!(
        arg,
        "--ignore-environment"
            | "--null"
            | "--debug"
            | "--list-signal-handling"
            | "--help"
            | "--version"
            | "--block-signal"
            | "--default-signal"
            | "--ignore-signal"
    ) {
        return true;
    }
    [
        "--unset=",
        "--chdir=",
        "--argv0=",
        "--block-signal=",
        "--default-signal=",
        "--ignore-signal=",
    ]
    .iter()
    .any(|prefix| arg.starts_with(prefix))
}

fn is_env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && !name.as_bytes()[0].is_ascii_digit()
}

fn extract_git_subcommand(args: &[String]) -> Option<(&str, &[String])> {
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if matches!(
            arg,
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--super-prefix"
        ) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return Some((arg, &args[index + 1..]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn classifies_verification_and_inspection_commands() {
        assert!(is_verification_command(
            "/bin/bash -lc 'cd rust-server && CARGO_BUILD_JOBS=2 cargo test -p ads-actions -- --test-threads=2'"
        ));
        assert!(is_verification_command(
            r#"bash -lc "npm --prefix client test""#
        ));
        assert!(is_verification_command("cargo clippy --all-targets"));
        assert!(is_verification_command("cargo fmt --check"));
        assert!(is_verification_command("pytest tests/"));
        assert!(is_verification_command("go test ./..."));

        assert!(!is_verification_command("git diff origin/dev...HEAD"));
        assert!(!is_verification_command("git status -sb"));
        assert!(!is_verification_command("rg -n foo rust-server/"));
        assert!(!is_verification_command("/bin/bash -lc 'ls -la'"));
    }

    #[test]
    fn blocks_mutating_commands_redirections_and_nested_shells_in_review_mode() {
        assert!(is_mutating_review_command("git commit -m 'nope'").is_some());
        assert!(is_mutating_review_command("/bin/bash -lc 'git push origin dev'").is_some());
        assert!(is_mutating_review_command("cd repo && bash -lc 'git push origin dev'").is_some());
        assert!(is_mutating_review_command("bash -lc \"sh -c 'git reset --hard'\"").is_some());
        assert!(is_mutating_review_command("echo ok & git push origin dev").is_some());
        assert!(is_mutating_review_command("echo hack > README.md").is_some());
        assert!(is_mutating_review_command("echo hack >> README.md").is_some());
        assert!(is_mutating_review_command("cat a | tee b").is_some());
        assert!(is_mutating_review_command("rm -rf foo").is_some());
        assert!(is_mutating_review_command("mv a b").is_some());
        assert!(is_mutating_review_command("sed -i 's/a/b/' file.rs").is_some());
        assert!(is_mutating_review_command("cargo fmt").is_some());
        assert!(is_mutating_review_command("cargo clippy --fix").is_some());
        assert!(is_mutating_review_command("apply_patch").is_some());

        // Shell flag bypass variants: combined short flags (-ec, -xc, -euc), separated flags
        // (-eu -c, -o pipefail -c), and --command.
        assert!(is_mutating_review_command("bash -ec 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("bash -xc 'git push origin dev'").is_some());
        assert!(is_mutating_review_command("sh -euc 'mv a b'").is_some());
        assert!(is_mutating_review_command("sh -eu -c 'git reset --hard'").is_some());
        assert!(is_mutating_review_command("bash -o pipefail -c 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("bash -oc pipefail 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("sh -oc errexit 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("bash -eO extglob -c 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("bash --noprofile --norc -c 'touch x'").is_some());
        assert!(is_mutating_review_command("sh --command 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("sh --command='git commit -m nope'").is_some());
        assert!(is_mutating_review_command("bash -c - 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("sh -c - 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env - rm -rf foo").is_some());
        assert!(is_mutating_review_command("env --uns PATH /bin/rm -rf foo").is_some());
        assert!(is_mutating_review_command("env --chd /tmp /bin/rm -rf foo").is_some());
        assert!(is_mutating_review_command("env --split 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env --split='rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env -a fake rm -rf foo").is_some());
        assert!(is_mutating_review_command("timeout -s KILL 5 rm -rf foo").is_some());
        assert!(is_mutating_review_command("timeout --sig KILL 5 rm -rf foo").is_some());
        assert!(is_mutating_review_command("env -u FOO bash -ec 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env -iu FOO bash -ec 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env -iC /tmp rm -rf foo").is_some());
        assert!(is_mutating_review_command("env -S 'rm -rf foo'").is_some());
        assert!(is_mutating_review_command("env --split-string='rm -rf foo'").is_some());

        // Mutating find, git config, git remote, and xargs payloads.
        assert!(is_mutating_review_command("find . -name '*.tmp' -delete").is_some());
        assert!(is_mutating_review_command("find . -name -exec -o -delete").is_some());
        assert!(is_mutating_review_command("find . -exec rm -f {} +").is_some());
        assert!(is_mutating_review_command("find . -exec env -u + rm -rf foo \\;").is_some());
        assert!(is_mutating_review_command("find . -ok env -u + rm -rf foo \\;").is_some());
        assert!(is_mutating_review_command("find . -okdir env -u + rm -rf foo \\;").is_some());
        assert!(is_mutating_review_command("git config user.name evil").is_some());
        assert!(is_mutating_review_command("git config user.name -evil").is_some());
        assert!(is_mutating_review_command("git config core.sshCommand '-o ProxyCommand=evil'").is_some());
        assert!(is_mutating_review_command("git config core.sshCommand '-f; echo hi'").is_some());
        assert!(is_mutating_review_command("git config user.name --list").is_some());
        assert!(is_mutating_review_command("git config user.name --get").is_some());
        assert!(is_mutating_review_command("git config user.name --global").is_some());
        assert!(is_mutating_review_command("git config user.name -v").is_some());
        assert!(is_mutating_review_command("git config user.name --all").is_some());
        assert!(is_mutating_review_command("git config --expiry-date gc.pruneExpire '2 weeks ago'").is_some());
        assert!(is_mutating_review_command("git config -ze").is_some());
        assert!(is_mutating_review_command("git config --global user.email e@x.com").is_some());
        assert!(is_mutating_review_command("git config --unset user.name").is_some());
        assert!(is_mutating_review_command("git config --add core.autocrlf false").is_some());
        assert!(is_mutating_review_command("git config set user.name evil").is_some());
        assert!(is_mutating_review_command("git remote set-url origin https://evil").is_some());
        assert!(is_mutating_review_command("git remote add evil https://evil").is_some());
        assert!(is_mutating_review_command("git remote remove origin").is_some());
        assert!(is_mutating_review_command("find . -name '*.tmp' | xargs rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -0 -P 4 -I {} sh -ec 'rm -f {}'").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -0I {} rm -f {}").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --replace rm -f {}").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --eof rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --max-lines rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --max-p 2 rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --max-a 1 rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs --del '\\n' rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -l rm -f").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -Ia rm -f a").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -In rm -f n").is_some());
        assert!(is_mutating_review_command("git ls-files | xargs -Eend rm -f").is_some());
        assert!(is_verification_command("bash -eu -c 'cargo test -p ads-acp'"));

        // Safe read-only & verification commands (including 2>&1 and >/dev/null) remain allowed.
        assert!(is_mutating_review_command("git diff origin/dev...HEAD").is_none());
        assert!(is_mutating_review_command("git branch --show-current").is_none());
        assert!(is_mutating_review_command("git config --get user.name").is_none());
        assert!(is_mutating_review_command("git config -t bool core.bare").is_none());
        assert!(is_mutating_review_command("git config --bool-or-str core.autocrlf").is_none());
        assert!(is_mutating_review_command("git config --list").is_none());
        assert!(is_mutating_review_command("git config -l").is_none());
        assert!(is_mutating_review_command("git config user.name").is_none());
        assert!(is_mutating_review_command("git config get --all user.name").is_none());
        assert!(is_mutating_review_command("git config list --show-origin").is_none());
        assert!(is_mutating_review_command("timeout 30 cargo test -p ads-acp").is_none());
        assert!(is_mutating_review_command("env -i PATH=/usr/bin git status").is_none());
        assert!(is_mutating_review_command("git remote -v").is_none());
        assert!(is_mutating_review_command("git remote show origin").is_none());
        assert!(is_mutating_review_command("git remote get-url origin").is_none());
        assert!(is_mutating_review_command("find rust-server -name '*.rs'").is_none());
        assert!(is_mutating_review_command("find rust-server -name '*.rs' | xargs -n 10 wc -l").is_none());
        assert!(is_mutating_review_command("bash -eu -c 'cargo test -p ads-acp'").is_none());
        assert!(is_mutating_review_command("cargo fmt --check").is_none());
        assert!(is_mutating_review_command("cargo test -p ads-actions 2>&1").is_none());
        assert!(is_mutating_review_command("cargo check 2>/dev/null").is_none());
    }

    #[test]
    fn augments_path_with_cargo_bin_when_missing() {
        let dir = tempdir().expect("tempdir");
        let cargo_bin = dir.path().join(".cargo").join("bin");
        std::fs::create_dir_all(&cargo_bin).expect("mkdir cargo bin");
        let augmented = augment_path_with_cargo_bin(
            Some(OsStr::new("/usr/local/bin:/usr/bin:/bin")),
            Some(dir.path()),
            None,
        )
        .expect("augmented path");
        assert!(augmented.starts_with(&cargo_bin.to_string_lossy().to_string()));
        assert!(augmented.contains("/usr/bin"));
        assert!(
            augment_path_with_cargo_bin(Some(OsStr::new(&augmented)), Some(dir.path()), None)
                .is_none()
        );
    }
}
