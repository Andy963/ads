use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ads_state::redact_native_transcript_text;
use regex::Regex;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{Mutex as AsyncMutex, watch};
use uuid::Uuid;

use crate::{Cancellation, NativeError, NativeResult};

const MAX_SESSIONS: usize = 16;
const KILL_GRACE: Duration = Duration::from_millis(1_200);
const SHELL_BUILTINS: &[&str] = &[
    "[", "cd", "echo", "export", "false", "printf", "pwd", "test", "true", "unset",
];
const PRIVATE_KEY_LABELS: &[&str] = &[
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "DSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK",
];

#[derive(Debug, Clone)]
pub(crate) struct CommandRequest {
    pub call_id: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub shell: bool,
    pub cwd: PathBuf,
    pub env: Option<Vec<(String, String)>>,
    pub allowlist: Option<Vec<String>>,
    pub max_output_bytes: usize,
    pub max_runtime_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct CommandRead {
    pub session_id: String,
    pub call_id: String,
    pub command: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated_stdout: bool,
    pub truncated_stderr: bool,
}

impl CommandRead {
    pub fn payload(&self) -> Value {
        json!({
            "command": self.command,
            "session_id": if self.running { Some(self.session_id.as_str()) } else { None },
            "running": self.running,
            "exit_code": self.exit_code,
            "signal": self.signal,
            "elapsed_ms": self.elapsed_ms,
            "timed_out": self.timed_out,
            "cancelled": self.cancelled,
            "stdout": self.stdout.trim_end(),
            "stderr": self.stderr.trim_end(),
            "truncated_stdout": self.truncated_stdout,
            "truncated_stderr": self.truncated_stderr,
        })
    }

    pub fn terminal_status(&self) -> &'static str {
        if self.running {
            "in_progress"
        } else if self.cancelled || self.timed_out || self.exit_code != Some(0) {
            "failed"
        } else {
            "completed"
        }
    }
}

pub(crate) struct CommandManager {
    sessions: Mutex<Vec<Arc<CommandSession>>>,
    closed: AtomicBool,
    redactions: Vec<String>,
    cancellation: Cancellation,
}

impl CommandManager {
    pub fn new(redactions: Vec<String>, cancellation: Cancellation) -> Self {
        Self {
            sessions: Mutex::new(Vec::new()),
            closed: AtomicBool::new(cancellation.is_cancelled()),
            redactions,
            cancellation,
        }
    }

    pub fn pending_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .expect("command sessions")
            .iter()
            .map(|session| session.id.clone())
            .collect()
    }

    pub async fn start(&self, request: CommandRequest, yield_ms: u64) -> NativeResult<CommandRead> {
        self.check_open()?;
        validate_request(&request)?;
        if self.pending_ids().len() >= MAX_SESSIONS {
            return Err(NativeError::Tool(
                "Too many pending command sessions. Wait for or cancel an existing session before starting another."
                    .to_string(),
            ));
        }

        let command_line = if request.shell {
            request.cmd.clone()
        } else {
            std::iter::once(request.cmd.as_str())
                .chain(request.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string()
        };
        let mut command = if request.shell {
            let mut command = Command::new("/bin/sh");
            command.arg("-c").arg(&request.cmd);
            command
        } else {
            let mut command = Command::new(&request.cmd);
            command.args(&request.args);
            command
        };
        command
            .current_dir(&request.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        if let Some(env) = request.env.as_ref() {
            command.env_clear();
            command.envs(env.iter().map(|(key, value)| (key, value)));
        }
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|error| {
            NativeError::Tool(format!("failed to start command {command_line}: {error}"))
        })?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let session = Arc::new(CommandSession::new(
            request.call_id,
            command_line,
            pid,
            request.max_output_bytes,
            self.redactions.clone(),
        ));
        let session_for_task = Arc::clone(&session);
        let stdout_task = stdout.map(|stdout| {
            let output = Arc::clone(&session_for_task.stdout);
            let redactions = session_for_task.redactions.clone();
            tokio::spawn(async move { pump(stdout, output, redactions).await })
        });
        let stderr_task = stderr.map(|stderr| {
            let output = Arc::clone(&session_for_task.stderr);
            let redactions = session_for_task.redactions.clone();
            tokio::spawn(async move { pump(stderr, output, redactions).await })
        });
        let session_for_wait = Arc::clone(&session);
        tokio::spawn(async move {
            let status = child.wait().await;
            // The shell may exit while a descendant still owns the output pipes.
            // Reap the remaining process group before waiting for the pumps.
            session_for_wait.terminate_group_once();
            if let Some(task) = stdout_task {
                let _ = task.await;
            }
            if let Some(task) = stderr_task {
                let _ = task.await;
            }
            session_for_wait.finish(status);
        });
        if let Some(timeout_ms) = request.max_runtime_ms {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                if !session.is_finished() {
                    session.stop(true).await;
                }
            });
        }
        self.sessions
            .lock()
            .expect("command sessions")
            .push(Arc::clone(&session));
        let result = session.read(yield_ms.max(1), false).await?;
        if !result.running {
            self.sessions
                .lock()
                .expect("command sessions")
                .retain(|candidate| candidate.id != result.session_id);
        }
        Ok(result)
    }

    pub async fn read(
        &self,
        session_id: &str,
        yield_ms: u64,
        cancel: bool,
    ) -> NativeResult<CommandRead> {
        self.check_open()?;
        let session = self
            .sessions
            .lock()
            .expect("command sessions")
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| {
                NativeError::Tool(
                    "Unknown or completed command session in this turn. It may belong to an earlier turn or server process. Never rerun a command merely to recover its output; inspect execution history and workspace state first."
                        .to_string(),
                )
            })?;
        if cancel {
            session.stop(false).await;
        }
        let result = tokio::select! {
            result = session.read(yield_ms.max(1), false) => result,
            _ = self.cancellation.cancelled() => {
                session.stop(false).await;
                Err(NativeError::Cancelled)
            }
        };
        match result {
            Ok(result) => {
                if !result.running {
                    self.sessions
                        .lock()
                        .expect("command sessions")
                        .retain(|candidate| candidate.id != session_id);
                }
                Ok(result)
            }
            Err(error) => {
                session.stop(false).await;
                self.sessions
                    .lock()
                    .expect("command sessions")
                    .retain(|candidate| candidate.id != session_id);
                Err(error)
            }
        }
    }

    pub async fn dispose(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let sessions = std::mem::take(&mut *self.sessions.lock().expect("command sessions"));
        for session in sessions {
            session.stop(false).await;
        }
    }

    fn check_open(&self) -> NativeResult<()> {
        if self.closed.load(Ordering::SeqCst) || self.cancellation.is_cancelled() {
            Err(NativeError::Cancelled)
        } else {
            Ok(())
        }
    }
}

impl Drop for CommandManager {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        for session in self.sessions.get_mut().expect("command sessions").drain(..) {
            session.terminate_group_once();
        }
    }
}

struct CommandSession {
    id: String,
    call_id: String,
    command: String,
    pid: Option<u32>,
    group_terminated: AtomicBool,
    #[cfg(test)]
    dispatched_signals: Mutex<Vec<i32>>,
    started_at: Instant,
    stdout: Arc<Mutex<OutputBuffer>>,
    stderr: Arc<Mutex<OutputBuffer>>,
    state: Mutex<SessionState>,
    done_tx: watch::Sender<bool>,
    done_rx: watch::Receiver<bool>,
    stop_lock: AsyncMutex<()>,
    redactions: Vec<String>,
}

#[derive(Default)]
struct SessionState {
    exit_code: Option<i32>,
    signal: Option<String>,
    timed_out: bool,
    cancelled: bool,
    finished_at: Option<Instant>,
}

impl CommandSession {
    fn new(
        call_id: String,
        command: String,
        pid: Option<u32>,
        max_output_bytes: usize,
        redactions: Vec<String>,
    ) -> Self {
        let (done_tx, done_rx) = watch::channel(false);
        Self {
            id: Uuid::new_v4().to_string(),
            call_id,
            command,
            pid,
            group_terminated: AtomicBool::new(false),
            #[cfg(test)]
            dispatched_signals: Mutex::new(Vec::new()),
            started_at: Instant::now(),
            stdout: Arc::new(Mutex::new(OutputBuffer::new(
                max_output_bytes,
                redactions.clone(),
            ))),
            stderr: Arc::new(Mutex::new(OutputBuffer::new(
                max_output_bytes,
                redactions.clone(),
            ))),
            state: Mutex::new(SessionState::default()),
            done_tx,
            done_rx,
            stop_lock: AsyncMutex::new(()),
            redactions,
        }
    }

    fn finish(&self, status: std::io::Result<std::process::ExitStatus>) {
        if self.is_finished() {
            return;
        }
        self.stdout.lock().expect("stdout").finish();
        self.stderr.lock().expect("stderr").finish();
        let mut state = self.state.lock().expect("session state");
        match status {
            Ok(status) => {
                state.exit_code = status.code();
                state.signal = exit_signal(&status);
            }
            Err(error) => {
                state.exit_code = Some(-1);
                self.stderr
                    .lock()
                    .expect("stderr")
                    .append_error(&format!("{error}\n"), &self.redactions);
            }
        }
        state.finished_at = Some(Instant::now());
        drop(state);
        self.terminate_group_once();
        let _ = self.done_tx.send(true);
    }

    fn is_finished(&self) -> bool {
        self.state
            .lock()
            .expect("session state")
            .finished_at
            .is_some()
    }

    async fn stop(&self, timed_out: bool) {
        let _guard = self.stop_lock.lock().await;
        if self.is_finished() {
            return;
        }
        {
            let mut state = self.state.lock().expect("session state");
            state.timed_out |= timed_out;
            state.cancelled |= !timed_out;
        }
        self.signal_term();
        let mut done = self.done_rx.clone();
        if !*done.borrow() {
            let _ = tokio::time::timeout(KILL_GRACE, done.changed()).await;
        }
        if !*done.borrow() {
            self.terminate_group_once();
            let _ = tokio::time::timeout(KILL_GRACE, done.changed()).await;
        }
    }

    async fn read(&self, yield_ms: u64, cancel: bool) -> NativeResult<CommandRead> {
        if cancel {
            self.stop(false).await;
        }
        if !self.is_finished() {
            let mut done = self.done_rx.clone();
            let _ = tokio::time::timeout(Duration::from_millis(yield_ms), async {
                while !*done.borrow() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }
        let (stdout, truncated_stdout) = self.stdout.lock().expect("stdout").drain();
        let (stderr, truncated_stderr) = self.stderr.lock().expect("stderr").drain();
        let state = self.state.lock().expect("session state");
        Ok(CommandRead {
            session_id: self.id.clone(),
            call_id: self.call_id.clone(),
            command: self.command.clone(),
            running: state.finished_at.is_none(),
            exit_code: state.exit_code,
            signal: state.signal.clone(),
            timed_out: state.timed_out,
            cancelled: state.cancelled,
            elapsed_ms: state
                .finished_at
                .unwrap_or_else(Instant::now)
                .duration_since(self.started_at)
                .as_millis() as u64,
            stdout,
            stderr,
            truncated_stdout,
            truncated_stderr,
        })
    }

    fn signal_term(&self) -> bool {
        if self.group_terminated.load(Ordering::Acquire) || self.is_finished() {
            return false;
        };
        self.signal_group_raw(libc::SIGTERM)
    }

    fn terminate_group_once(&self) -> bool {
        if self.group_terminated.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.signal_group_raw(libc::SIGKILL)
    }

    fn signal_group_raw(&self, signal: i32) -> bool {
        let Some(pid) = self.pid.and_then(|pid| i32::try_from(pid).ok()) else {
            return false;
        };
        #[cfg(test)]
        self.dispatched_signals
            .lock()
            .expect("dispatched signals")
            .push(signal);
        #[cfg(unix)]
        unsafe {
            libc::kill(-pid, signal);
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
        }
        true
    }
}

async fn pump<R: AsyncRead + Unpin>(
    mut reader: R,
    output: Arc<Mutex<OutputBuffer>>,
    redactions: Vec<String>,
) {
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => output
                .lock()
                .expect("output buffer")
                .append(&chunk[..read], &redactions),
            Err(_) => break,
        }
    }
}

struct OutputBuffer {
    partial: Vec<u8>,
    lines: VecDeque<String>,
    line_bytes: usize,
    limit: usize,
    truncated: bool,
    dropping_line: bool,
    private_key: Option<usize>,
    redactions: Vec<String>,
}

impl OutputBuffer {
    fn new(limit: usize, redactions: Vec<String>) -> Self {
        Self {
            partial: Vec::new(),
            lines: VecDeque::new(),
            line_bytes: 0,
            limit,
            truncated: false,
            dropping_line: false,
            private_key: None,
            redactions,
        }
    }

    fn append(&mut self, bytes: &[u8], redactions: &[String]) {
        for byte in bytes {
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.partial);
                line.push(b'\n');
                if self.dropping_line {
                    self.dropping_line = false;
                } else {
                    self.store_bytes(&line, redactions);
                }
                continue;
            }
            if self.dropping_line {
                continue;
            }
            self.partial.push(*byte);
            if self.partial.len() > self.limit {
                self.partial.clear();
                self.dropping_line = true;
                self.truncated = true;
            }
        }
    }

    fn finish(&mut self) {
        if !self.dropping_line && !self.partial.is_empty() {
            let line = std::mem::take(&mut self.partial);
            let redactions = self.redactions.clone();
            self.store_bytes(&line, &redactions);
        }
        self.dropping_line = false;
    }

    fn append_error(&mut self, value: &str, redactions: &[String]) {
        self.store_bytes(value.as_bytes(), redactions);
    }

    fn drain(&mut self) -> (String, bool) {
        let text = self.lines.drain(..).collect::<String>();
        self.line_bytes = 0;
        let truncated = std::mem::take(&mut self.truncated);
        (text, truncated)
    }

    fn store_bytes(&mut self, bytes: &[u8], redactions: &[String]) {
        let text = String::from_utf8_lossy(bytes);
        self.store_line(&text, redactions);
    }

    fn store_line(&mut self, line: &str, redactions: &[String]) {
        let sanitized = sanitize_line(line, redactions, &mut self.private_key);
        if sanitized.is_empty() {
            return;
        }
        let bytes = sanitized.len();
        self.lines.push_back(sanitized);
        self.line_bytes = self.line_bytes.saturating_add(bytes);
        while self.line_bytes > self.limit {
            if let Some(removed) = self.lines.pop_front() {
                self.line_bytes = self.line_bytes.saturating_sub(removed.len());
                self.truncated = true;
            } else {
                break;
            }
        }
    }
}

fn sanitize_line(line: &str, redactions: &[String], private_key: &mut Option<usize>) -> String {
    let mut output = String::new();
    let mut remaining = line;
    loop {
        if let Some(label) = *private_key {
            let marker = format!("-----END {}-----", PRIVATE_KEY_LABELS[label]);
            if let Some(position) = remaining.find(&marker) {
                *private_key = None;
                remaining = &remaining[position + marker.len()..];
                continue;
            }
            break;
        }

        let next_marker = PRIVATE_KEY_LABELS
            .iter()
            .enumerate()
            .filter_map(|(index, label)| {
                let marker = format!("-----BEGIN {label}-----");
                remaining
                    .find(&marker)
                    .map(|position| (position, index, marker))
            })
            .min_by_key(|(position, _, _)| *position);
        match next_marker {
            Some((position, index, marker)) => {
                output.push_str(&remaining[..position]);
                output.push_str("[redacted]");
                *private_key = Some(index);
                remaining = &remaining[position + marker.len()..];
            }
            None => {
                output.push_str(remaining);
                break;
            }
        }
    }
    redact_native_transcript_text(&output, redactions, 0)
}

pub(crate) fn tokenize_command_line(value: &str) -> NativeResult<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut token_started = false;
    let mut quote = None;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            token.push(character);
            token_started = true;
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            token_started = true;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            } else {
                token.push(character);
            }
            token_started = true;
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            token_started = true;
            continue;
        }
        if character.is_whitespace() {
            if token_started {
                tokens.push(std::mem::take(&mut token));
                token_started = false;
            }
            continue;
        }
        token.push(character);
        token_started = true;
    }
    if escaped {
        return Err(NativeError::Tool(
            "exec_command cmd has a dangling escape".to_string(),
        ));
    }
    if quote.is_some() {
        return Err(NativeError::Tool(
            "exec_command cmd has an unterminated quote".to_string(),
        ));
    }
    if token_started {
        tokens.push(token);
    }
    Ok(tokens)
}

pub(crate) fn has_shell_syntax(value: &str) -> bool {
    let characters = value.chars().collect::<Vec<_>>();
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in characters.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            continue;
        }
        if "|;&<>*?\n\r".contains(character) || character == '`' {
            return true;
        }
        if character == '$'
            && characters.get(index + 1).is_some_and(|next| {
                "({ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_".contains(*next)
            })
        {
            return true;
        }
    }
    false
}

pub(crate) fn allowlist_from_env() -> Option<Vec<String>> {
    let raw = std::env::var("AGENT_EXEC_TOOL_ALLOWLIST").ok()?;
    parse_allowlist(&raw)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ShellBlock {
    Brace,
    IfBody,
    IfCondition,
    LoopBody,
    LoopHeader,
}

pub fn command_has_executable(command: &str, cwd: &std::path::Path) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let segments = if has_shell_syntax(command) {
        split_shell_segments(command)
    } else {
        vec![command.to_string()]
    };
    let mut blocks = Vec::new();
    let mut effective_cwd = cwd.to_path_buf();
    let mut effective_path = std::env::var("PATH").ok();
    let valid = !segments.is_empty()
        && segments.iter().all(|segment| {
            let Ok(tokens) = tokenize_command_line(segment) else {
                return false;
            };
            let mut executable_index = 0;
            let mut segment_path = effective_path.clone();
            loop {
                while let Some((key, value)) = tokens.get(executable_index).and_then(|token| {
                    token
                        .split_once('=')
                        .filter(|(key, _)| is_shell_variable_name(key))
                }) {
                    if key == "PATH" {
                        segment_path = Some(expand_path_value(value, effective_path.as_deref()));
                    }
                    executable_index += 1;
                }
                let Some(token) = tokens.get(executable_index) else {
                    return false;
                };
                match command_basename(token).as_str() {
                    "fi" => {
                        return executable_index + 1 == tokens.len()
                            && blocks.pop() == Some(ShellBlock::IfBody);
                    }
                    "}" => {
                        return executable_index + 1 == tokens.len()
                            && blocks.pop() == Some(ShellBlock::Brace);
                    }
                    "done" => {
                        return executable_index + 1 == tokens.len()
                            && blocks.pop() == Some(ShellBlock::LoopBody);
                    }
                    "if" => {
                        blocks.push(ShellBlock::IfCondition);
                        executable_index += 1;
                    }
                    "{" => {
                        blocks.push(ShellBlock::Brace);
                        executable_index += 1;
                    }
                    "while" | "until" => {
                        blocks.push(ShellBlock::LoopHeader);
                        executable_index += 1;
                    }
                    "for" => {
                        blocks.push(ShellBlock::LoopHeader);
                        return tokens.iter().any(|token| command_basename(token) == "in")
                            && executable_index + 1 < tokens.len();
                    }
                    "then" if blocks.last() == Some(&ShellBlock::IfCondition) => {
                        blocks.pop();
                        blocks.push(ShellBlock::IfBody);
                        executable_index += 1;
                    }
                    "elif" if blocks.last() == Some(&ShellBlock::IfBody) => {
                        blocks.pop();
                        blocks.push(ShellBlock::IfCondition);
                        executable_index += 1;
                    }
                    "else" if blocks.last() == Some(&ShellBlock::IfBody) => {
                        executable_index += 1;
                    }
                    "do" if blocks.last() == Some(&ShellBlock::LoopHeader) => {
                        blocks.pop();
                        blocks.push(ShellBlock::LoopBody);
                        executable_index += 1;
                    }
                    "!" | "time" => {
                        executable_index += 1;
                    }
                    "export" => {
                        let mut updated_path = None;
                        for token in tokens.iter().skip(executable_index + 1) {
                            let Some((key, value)) = token
                                .split_once('=')
                                .filter(|(key, _)| is_shell_variable_name(key))
                            else {
                                return false;
                            };
                            if key == "PATH" {
                                updated_path =
                                    Some(expand_path_value(value, effective_path.as_deref()));
                            }
                        }
                        if let Some(path) = updated_path {
                            effective_path = Some(path);
                        }
                        return true;
                    }
                    _ => {
                        if !SHELL_BUILTINS.contains(&command_basename(token).as_str())
                            && !executable_exists(token, &effective_cwd, segment_path.as_deref())
                        {
                            return false;
                        }
                        if command_basename(token) == "cd" {
                            effective_cwd =
                                cd_target(&tokens[executable_index + 1..], &effective_cwd);
                        }
                        return true;
                    }
                }
            }
        });
    valid && blocks.is_empty()
}

fn expand_path_value(value: &str, current: Option<&str>) -> String {
    let current = current.unwrap_or_default();
    value.replace("${PATH}", current).replace("$PATH", current)
}

fn cd_target(arguments: &[String], cwd: &Path) -> PathBuf {
    let Some(target) = arguments.first().map(String::as_str) else {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.to_path_buf());
    };
    if target == "-" || target.starts_with('$') {
        return cwd.to_path_buf();
    }
    let target = Path::new(target);
    if target.is_absolute() {
        target.to_path_buf()
    } else {
        cwd.join(target)
    }
}

fn executable_exists(command: &str, cwd: &std::path::Path, path: Option<&str>) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        let resolved = if command_path.is_absolute() {
            command_path.to_path_buf()
        } else {
            cwd.join(command_path)
        };
        return is_executable_file(&resolved);
    }
    let environment_path = std::env::var("PATH").ok();
    path.or(environment_path.as_deref()).is_some_and(|paths| {
        std::env::split_paths(std::ffi::OsStr::new(&paths)).any(|directory| {
            let candidate = if directory.is_absolute() {
                directory.join(command)
            } else {
                cwd.join(directory).join(command)
            };
            is_executable_file(&candidate)
        })
    })
}

fn is_executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn parse_allowlist(raw: &str) -> Option<Vec<String>> {
    let parsed = raw
        .split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    if parsed.is_empty() || parsed.iter().any(|entry| entry == "*" || entry == "all") {
        None
    } else {
        Some(parsed)
    }
}

pub(crate) fn validate_request(request: &CommandRequest) -> NativeResult<()> {
    if request.args.len() > 128 {
        return Err(NativeError::Tool("Too many command arguments".to_string()));
    }
    if request.shell {
        assert_shell_command_allowed(&request.cmd, request.allowlist.as_deref())?;
    } else {
        assert_command_allowed(&request.cmd, request.allowlist.as_deref())?;
    }
    if let Some(violation) = find_security_violation(&if request.shell {
        request.cmd.clone()
    } else {
        std::iter::once(request.cmd.as_str())
            .chain(request.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }) {
        return Err(NativeError::Tool(format!(
            "Command blocked by security rule: {violation}"
        )));
    }
    Ok(())
}

fn assert_command_allowed(command: &str, allowlist: Option<&[String]>) -> NativeResult<()> {
    let Some(allowlist) = allowlist else {
        return Ok(());
    };
    if command.contains('/') || command.contains('\\') {
        return Err(NativeError::Tool(format!(
            "command path is not allowed when allowlist is enabled: {command}"
        )));
    }
    let executable = command_basename(command);
    if !allowlist.contains(&executable) {
        return Err(NativeError::Tool(format!(
            "command not allowed: {executable}"
        )));
    }
    Ok(())
}

fn assert_shell_command_allowed(command: &str, allowlist: Option<&[String]>) -> NativeResult<()> {
    let Some(allowlist) = allowlist else {
        return Ok(());
    };
    if command.contains('`') || command.contains("$(") {
        return Err(NativeError::Tool(
            "command substitution is not allowed when an executable allowlist is enabled"
                .to_string(),
        ));
    }
    for segment in split_shell_segments(command) {
        let tokens = tokenize_command_line(&segment)?;
        let mut executable_index = 0;
        while tokens.get(executable_index).is_some_and(|token| {
            token
                .split_once('=')
                .is_some_and(|(key, _)| is_shell_variable_name(key))
        }) {
            executable_index += 1;
        }
        let Some(executable) = tokens.get(executable_index) else {
            return Err(NativeError::Tool(
                "shell command segment has no executable".to_string(),
            ));
        };
        let normalized = command_basename(executable);
        if SHELL_BUILTINS.contains(&normalized.as_str()) {
            continue;
        }
        if !allowlist.contains(&normalized) {
            return Err(NativeError::Tool(format!(
                "command not allowed: {normalized}"
            )));
        }
    }
    Ok(())
}

fn is_shell_variable_name(value: &str) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn command_basename(command: &str) -> String {
    command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_ascii_lowercase()
}

fn split_shell_segments(value: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut escaped = false;
    let characters = value.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            index += 1;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            }
            index += 1;
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            index += 1;
            continue;
        }
        let next = characters.get(index + 1).copied();
        if character == '|' || character == '&' {
            push_segment(&mut segments, value, start, index);
            if next == Some(character) {
                index += 2;
                start = index;
                continue;
            }
            index += 1;
            start = index;
        } else if character == ';' || character == '\n' {
            push_segment(&mut segments, value, start, index);
            index += 1;
            start = index;
        } else {
            index += 1;
        }
    }
    push_segment(&mut segments, value, start, characters.len());
    segments
}

fn push_segment(segments: &mut Vec<String>, value: &str, start: usize, end: usize) {
    let segment = value
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect::<String>();
    let segment = segment.trim();
    if !segment.is_empty() {
        segments.push(segment.to_string());
    }
}

pub fn find_security_violation(command: &str) -> Option<String> {
    static PATTERNS: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)\b(?:pkill|killall)\b[\s\S]*(?:\bads(?:-web|-tg)?\b|\bcli\.js\b|\bnode(?:js)?\b)",
            r"(?i)\bkill\b[\s\S]*(?:\$\(\s*(?:pgrep|pidof)\b[^)]*(?:ads|cli\.js|node)[^)]*\)|\bads(?:-web|-tg)?\b|\bcli\.js\b)",
            r"(?i)\bsystemctl\s+(?:--user\s+)?(?:stop|disable|mask|kill)\s+[\s\S]*(?:\bads-web\b|\bads-tg\b)",
            r"\b(?:rm|unlink|shred|truncate)\b[\s\S]*\.(?:db|sqlite|sqlite3)\b",
            r"\b(?:tee|cp|mv|install)\b[\s\S]*\.(?:db|sqlite|sqlite3)\b",
            r"(?:^|[;&|\s])(?:\d+\s*)?>{1,2}\s*[^\s]+\.(?:db|sqlite|sqlite3)\b",
            r#"(?:^|[;&|\s])(?:\d+\s*)?>{1,2}\s*["'][^"']+\.(?:db|sqlite|sqlite3)\b["']"#,
            r"\bsqlite3?\b[\s\S]*\.(?:db|sqlite|sqlite3)\b[\s\S]*(?:\b(?:delete|insert|update|drop|alter|vacuum|reindex)\b)",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("valid command security regex"))
        .collect()
    });
    for segment in split_shell_commands(command) {
        for pattern in patterns {
            if pattern.is_match(&segment) {
                return Some(segment);
            }
        }
    }
    None
}

fn split_shell_commands(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut paren_depth = 0usize;
    let characters = command.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < characters.len() {
        let character = characters[index];
        if let Some(active) = quote {
            current.push(character);
            if character == '\\' && active != '\'' && index + 1 < characters.len() {
                current.push(characters[index + 1]);
                index += 2;
                continue;
            }
            if character == active {
                quote = None;
            }
            index += 1;
            continue;
        }
        if character == '\\' && index + 1 < characters.len() {
            current.push(character);
            current.push(characters[index + 1]);
            index += 2;
            continue;
        }
        if character == '\'' || character == '"' || character == '`' {
            quote = Some(character);
            current.push(character);
            index += 1;
            continue;
        }
        if character == '(' {
            paren_depth += 1;
            current.push(character);
            index += 1;
            continue;
        }
        if character == ')' {
            paren_depth = paren_depth.saturating_sub(1);
            current.push(character);
            index += 1;
            continue;
        }
        if paren_depth == 0
            && (character == '|' || character == '&' || character == ';' || character == '\n')
        {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                segments.push(trimmed.to_string());
            }
            current.clear();
            index += 1;
            continue;
        }
        current.push(character);
        index += 1;
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(trimmed.to_string());
    }
    segments
}

fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status.signal()?;
        Some(
            match signal {
                libc::SIGTERM => "SIGTERM",
                libc::SIGKILL => "SIGKILL",
                libc::SIGINT => "SIGINT",
                libc::SIGHUP => "SIGHUP",
                libc::SIGQUIT => "SIGQUIT",
                _ => return Some(signal.to_string()),
            }
            .to_string(),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn recognizes_shell_syntax_without_treating_quotes_as_syntax() {
        assert!(has_shell_syntax("printf 'x' | cat"));
        assert!(has_shell_syntax("cd nested && cat file"));
        assert!(!has_shell_syntax("echo 'a|b'"));
        assert!(!has_shell_syntax("git log -n 5"));
    }

    #[test]
    fn tokenizes_command_lines_like_the_typescript_runner() {
        assert_eq!(
            tokenize_command_line("node -e \"a b\" 'c d'").expect("tokens"),
            vec!["node", "-e", "a b", "c d"]
        );
        assert!(tokenize_command_line("echo 'unterminated").is_err());
    }

    #[test]
    fn requires_a_real_executable_or_shell_construct() {
        let directory = tempdir().expect("tempdir");
        let valid = |command: &str| command_has_executable(command, directory.path());
        assert!(!valid("Please inspect the logs"));
        assert!(!valid("{ Please inspect the logs; }"));
        assert!(!valid("for the logs"));
        assert!(!valid("case the logs"));
        assert!(!valid("function"));
        assert!(!valid("in"));
        assert!(!valid("{ echo ok; } Please inspect"));
        assert!(!valid("fi; echo if"));
        assert!(!valid("}; echo {"));
        assert!(!valid("if echo ok; fi"));
        assert!(!valid("for x in a b; done"));
        assert!(!valid("for please in inspect the logs; done"));
        assert!(!valid("done"));
        assert!(!valid("fi"));
        assert!(!valid("definitely-not-an-installed-command"));
        assert!(valid("[ -f file ]"));
        assert!(valid("{ echo ok; }"));
        assert!(valid("if [ -f file ]; then echo ok; fi"));
        assert!(valid("if true && false; then echo ok; fi"));
        assert!(valid("while true || false; do echo ok; done"));
        assert!(valid("for x in a b; do echo ok; done"));
        assert!(valid("printf 'x' | cat"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_relative_executables_against_the_command_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("tempdir");
        let nested = directory.path().join("nested");
        std::fs::create_dir_all(&nested).expect("nested directory");
        let script = nested.join("script.sh");
        std::fs::write(&script, "#!/bin/sh\n").expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        assert!(command_has_executable("./script.sh", &nested));
        assert!(command_has_executable(
            "cd nested && ./script.sh",
            directory.path()
        ));
        assert!(!command_has_executable(
            "./script.sh",
            std::path::Path::new("/")
        ));

        let bin = directory.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin directory");
        let tool = bin.join("local-tool");
        std::fs::write(&tool, "#!/bin/sh\n").expect("tool");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755))
            .expect("permissions");
        assert!(command_has_executable(
            "PATH=bin local-tool",
            directory.path()
        ));
    }

    #[test]
    fn blocks_database_destructive_commands() {
        assert!(find_security_violation("rm -f state.db").is_some());
        assert!(find_security_violation("echo state.db").is_none());
    }

    #[test]
    fn preserves_content_after_a_private_key_end_marker() {
        let mut private_key = None;
        let input = format!(
            "-----BEGIN {} PRIVATE KEY-----secret-----END {} PRIVATE KEY-----after\n",
            "RSA", "RSA"
        );
        assert_eq!(
            sanitize_line(&input, &[], &mut private_key),
            "[redacted]after\n"
        );
        assert_eq!(private_key, None);
    }

    #[test]
    fn suppresses_private_key_bodies_across_lines() {
        let mut private_key = None;
        assert_eq!(sanitize_line("before\n", &[], &mut private_key), "before\n");
        assert_eq!(
            sanitize_line(
                concat!("-----BEGIN ", "RSA", " PRIVATE KEY-----\n"),
                &[],
                &mut private_key,
            ),
            "[redacted]"
        );
        assert_eq!(
            sanitize_line("private material\n", &[], &mut private_key),
            ""
        );
        assert_eq!(
            sanitize_line(
                "-----END RSA PRIVATE KEY-----after\n",
                &[],
                &mut private_key
            ),
            "after\n"
        );
        assert_eq!(private_key, None);
    }

    #[test]
    fn parses_the_executable_allowlist_like_typescript() {
        assert_eq!(
            parse_allowlist(" printf , , cat "),
            Some(vec!["printf".to_string(), "cat".to_string()])
        );
        assert_eq!(parse_allowlist(" , "), None);
        assert_eq!(parse_allowlist("*,printf"), None);
        assert_eq!(
            parse_allowlist("\"printf\",cat"),
            Some(vec!["\"printf\"".to_string(), "cat".to_string()])
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bounds_pending_command_sessions() {
        let directory = tempdir().expect("temp dir");
        let manager = CommandManager::new(Vec::new(), Cancellation::new());
        let request = || CommandRequest {
            call_id: Uuid::new_v4().to_string(),
            cmd: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "sleep 30".to_string()],
            shell: false,
            cwd: directory.path().to_path_buf(),
            env: None,
            allowlist: None,
            max_output_bytes: 64 * 1024,
            max_runtime_ms: None,
        };
        for _ in 0..MAX_SESSIONS {
            let result = manager.start(request(), 1).await.expect("start");
            assert!(result.running);
        }
        let error = manager
            .start(request(), 1)
            .await
            .expect_err("session limit");
        assert!(
            error
                .to_string()
                .contains("Too many pending command sessions")
        );
        manager.dispose().await;
        assert!(manager.pending_ids().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatches_sigkill_at_most_once_across_finish_reads_stop_and_drop() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "echo done"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().expect("spawn");
        let pid = child.id();
        let session = Arc::new(CommandSession::new(
            "call-once".to_string(),
            "/bin/sh -c echo done".to_string(),
            pid,
            64 * 1024,
            Vec::new(),
        ));
        let status = child.wait().await;
        assert!(session.terminate_group_once());
        session.finish(status);

        // Repeated reads, finish, stop, and explicit terminate after exit must never signal again.
        let first_read = session.read(10, false).await.expect("first read");
        assert!(!first_read.running);
        let second_read = session.read(10, false).await.expect("second read");
        assert!(!second_read.running);
        session.stop(false).await;
        assert!(!session.terminate_group_once());
        assert!(!session.signal_term());

        let signals = session
            .dispatched_signals
            .lock()
            .expect("dispatched signals")
            .clone();
        assert_eq!(signals, vec![libc::SIGKILL]);
    }
}
