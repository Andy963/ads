use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_native::Cancellation;
use ads_reviewer::{
    ReviewPayload, ReviewTestReport, ReviewVerdict, ReviewVerdictStatus, ReviewVerificationReport,
    ReviewerError, build_review_prompt, parse_review_verdict,
};
use ads_state::{
    ROLE_REVIEWER, StateDb, derive_project_session_id, get_default_role_profile,
    get_role_profile_by_id,
};
use serde_json::Value;
use tokio::sync::watch;

use crate::SpawnOptions;
use crate::agent::{
    AgentError, AgentEvent, AgentInputPart, AgentSendOptions, AutoCompactConfig,
    CodexAppServerAgent, CodexAppServerAgentOptions, RetryConfig, SandboxMode,
};
use crate::daemon_registry::CodexAppServerDaemonRegistry;
use crate::provider_injection::resolve_codex_model_selection;

const MAX_VERIFICATION_COMMANDS: usize = 32;
const MAX_VERIFICATION_OUTPUT_CHARS: usize = 6_000;
const DEFAULT_INCOMPLETE_SUMMARY: &str =
    "Reviewer reported insufficient evidence; developer rework was not requested.";

pub struct CodexReviewRequest {
    pub db: StateDb,
    pub payload: ReviewPayload,
    pub repo_path: PathBuf,
    pub profile_id: Option<String>,
    pub job_id: String,
    pub owner: String,
    pub timeout: Duration,
    pub cancellation: Cancellation,
    pub verification_report: Arc<StdMutex<ReviewVerificationReport>>,
    pub daemon_options: SpawnOptions,
    pub registry: Option<Arc<CodexAppServerDaemonRegistry>>,
}

pub async fn run_codex_review(request: CodexReviewRequest) -> Result<ReviewVerdict, ReviewerError> {
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
    drop(connection);

    let mut selection = resolve_codex_model_selection(
        &request.db,
        &request.owner,
        Some(&profile.model_id),
        request.daemon_options,
    )
    .map_err(|error| ReviewerError::Execution(error.to_string()))?;

    let existing_path = selection
        .daemon_options
        .env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let cargo_home = std::env::var_os("CARGO_HOME").map(PathBuf::from);
    if let Some(augmented) = augment_path_with_cargo_bin(
        existing_path.as_deref(),
        home.as_deref(),
        cargo_home.as_deref(),
    ) {
        selection
            .daemon_options
            .env
            .insert("PATH".to_string(), augmented);
    }

    let prompt = format!(
        "{}\n\nReview runtime protocol: you are operating as a detached, clean-room Reviewer. Do NOT edit files, apply patches, or run mutating git/gh commands (commit, push, checkout, reset, merge, close). Inspect the exact diff and repository files as needed, then run bounded, relevant verification commands (for example cargo test, cargo clippy, npm test, pytest) before returning PASS. Return ONLY a single JSON object matching {{\"status\": \"PASS\" | \"REJECT\" | \"INCOMPLETE\", \"summary\": \"...\", \"defects\": [...]}}. If required verification cannot be executed or evidence is missing, return INCOMPLETE and state the exact reason in summary.",
        build_review_prompt(&request.payload)
    );

    let daemon_key = format!(
        "reviewer::{}",
        derive_project_session_id(&request.repo_path.to_string_lossy())
    );
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: daemon_key,
        workspace_root: request.repo_path.clone(),
        working_directory: Some(request.repo_path.clone()),
        model: selection.model,
        resume_thread_id: None,
        reasoning_effort: profile.reasoning_effort.clone(),
        sandbox_mode: SandboxMode::ReviewVerification,
        developer_instructions: Some(profile.system_prompt.clone()),
        dynamic_tools: Vec::new(),
        daemon_options: selection.daemon_options,
        registry: request.registry,
        turn_timeout: Some(request.timeout),
        auto_compact: AutoCompactConfig::default(),
        retry: RetryConfig::default(),
    });

    let verification_report = Arc::clone(&request.verification_report);
    let event_sub = agent.on_event(move |event| {
        record_verification_event(&verification_report, &event);
    });

    let (abort_tx, abort_rx) = watch::channel(false);
    let cancellation = request.cancellation.clone();
    let cancel_bridge = tokio::spawn(async move {
        cancellation.cancelled().await;
        let _ = abort_tx.send(true);
    });

    let send_future = agent.send_with_options(
        vec![AgentInputPart::text(prompt)],
        AgentSendOptions {
            abort: Some(abort_rx),
            action_tools: None,
        },
    );

    let run_result = tokio::select! {
        result = send_future => result,
        _ = tokio::time::sleep(request.timeout) => {
            Err(AgentError::TimedOut { timeout: request.timeout })
        }
        _ = request.cancellation.cancelled() => {
            Err(AgentError::Aborted)
        }
    };

    cancel_bridge.abort();
    agent.off_event(event_sub);

    let result = match run_result {
        Ok(result) => result,
        Err(AgentError::Aborted) => return Err(ReviewerError::Cancelled),
        Err(AgentError::TimedOut { .. }) => {
            return Err(ReviewerError::Execution(
                "Reviewer execution timed out.".to_string(),
            ));
        }
        Err(error) => return Err(ReviewerError::Execution(error.to_string())),
    };

    let verdict = parse_review_verdict(&result.response, Some(&profile.id))?;
    if verdict.status == ReviewVerdictStatus::Incomplete {
        let summary = verdict.summary.trim();
        let message = if summary.is_empty() {
            DEFAULT_INCOMPLETE_SUMMARY.to_string()
        } else {
            summary.to_string()
        };
        return Err(ReviewerError::Incomplete(message));
    }
    Ok(ReviewVerdict {
        reviewer_profile_id: Some(profile.id),
        ..verdict
    })
}

fn record_verification_event(
    verification_report: &Arc<StdMutex<ReviewVerificationReport>>,
    event: &AgentEvent,
) {
    if event.phase != "command" {
        return;
    }
    if event.raw.get("type").and_then(Value::as_str) != Some("item.completed") {
        return;
    }
    let Some(item) = event.raw.get("item") else {
        return;
    };
    if item.get("type").and_then(Value::as_str) != Some("command_execution") {
        return;
    }
    let command = item
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if command.is_empty() || !is_verification_command(command) {
        return;
    }
    let status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let started = status != "declined";
    let exit_code = item
        .get("exit_code")
        .and_then(Value::as_i64)
        .unwrap_or(if status == "completed" { 0 } else { 1 });
    let raw_output = item
        .get("aggregated_output")
        .and_then(Value::as_str)
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

    let mut report = verification_report
        .lock()
        .expect("verification report lock");
    if report.commands.len() < MAX_VERIFICATION_COMMANDS {
        report.commands.push(ReviewTestReport {
            command: command.to_string(),
            exit_code,
            summary,
            output,
            started,
        });
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
    let unwrapped = unwrap_shell_command(command);
    for segment in split_command_segments(&unwrapped) {
        let tokens = tokenize_segment(&segment);
        let Some((program, args)) = extract_program_and_args(&tokens) else {
            continue;
        };
        match program.as_str() {
            "apply_patch" | "patch" => {
                return Some("Reviewer cannot apply patches or modify repository files.");
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
            "cargo"
                if args.first().map(String::as_str) == Some("fmt")
                    && !args.iter().any(|arg| arg == "--check") =>
            {
                return Some("Reviewer cannot format files in place; use cargo fmt --check.");
            }
            _ => {}
        }
    }
    None
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
    let tokens = tokenize_segment(trimmed);
    if tokens.len() >= 3 {
        let exe = Path::new(&tokens[0])
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or(&tokens[0]);
        if matches!(exe, "sh" | "bash" | "zsh" | "dash")
            && matches!(tokens[1].as_str(), "-c" | "-lc" | "-cl")
        {
            return tokens[2..].join(" ");
        }
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
            index += 1;
            while index < tokens.len()
                && (tokens[index].starts_with('-') || is_env_assignment(&tokens[index]))
            {
                index += 1;
            }
            continue;
        }
        if base == "timeout" {
            index += 1;
            while index < tokens.len() && tokens[index].starts_with('-') {
                index += 1;
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
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace"
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
            r#"bash -lc "npm --prefix ts-server test""#
        ));
        assert!(is_verification_command("cargo clippy --all-targets"));
        assert!(is_verification_command("cargo fmt --check"));
        assert!(is_verification_command("pytest tests/"));
        assert!(is_verification_command("python3 -m unittest discover"));
        assert!(is_verification_command("go test ./..."));
        assert!(is_verification_command("npx tsc --noEmit"));

        assert!(!is_verification_command("git diff origin/dev...HEAD"));
        assert!(!is_verification_command("git status -sb"));
        assert!(!is_verification_command("rg -n foo rust-server/"));
        assert!(!is_verification_command("cat rust-server/Cargo.toml"));
        assert!(!is_verification_command("/bin/bash -lc 'ls -la'"));
    }

    #[test]
    fn blocks_mutating_commands_in_review_mode() {
        assert!(is_mutating_review_command("git commit -m 'nope'").is_some());
        assert!(is_mutating_review_command("/bin/bash -lc 'git push origin dev'").is_some());
        assert!(is_mutating_review_command("git -C repo checkout -b x").is_some());
        assert!(is_mutating_review_command("git branch -D codex/issue-1").is_some());
        assert!(is_mutating_review_command("gh pr merge 702 --squash").is_some());
        assert!(is_mutating_review_command("cargo fmt").is_some());
        assert!(is_mutating_review_command("apply_patch").is_some());

        assert!(is_mutating_review_command("git diff origin/dev...HEAD").is_none());
        assert!(is_mutating_review_command("git branch --show-current").is_none());
        assert!(is_mutating_review_command("gh pr view 702 --json number").is_none());
        assert!(is_mutating_review_command("cargo fmt --check").is_none());
        assert!(is_mutating_review_command("cargo test -p ads-actions").is_none());
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

        let already =
            augment_path_with_cargo_bin(Some(OsStr::new(&augmented)), Some(dir.path()), None);
        assert!(already.is_none());
    }
}
