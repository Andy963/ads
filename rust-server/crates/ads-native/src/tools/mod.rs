mod command;
mod loop_guard;
mod patch;

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use ads_state::redact_native_transcript_text;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::{
    Cancellation, MiddlewareItem, MiddlewarePipeline, NativeError, NativeResult, NativeToolCall,
    NativeToolDefinition, NativeToolFunctionDefinition, TurnContext,
};

pub use self::command::command_has_executable;
pub use self::command::find_security_violation;
use self::command::{
    CommandManager, CommandRead, CommandRequest, allowlist_from_env, has_shell_syntax,
    tokenize_command_line,
};
pub(crate) use self::loop_guard::{ToolLoopDecision, ToolLoopGuard, paused_error};
pub(crate) use self::patch::ChangedFile;

pub(crate) fn command_cwd_for_args(workspace_root: &Path, arguments: &Value) -> Option<PathBuf> {
    let arguments = arguments.as_object()?;
    match string_argument(arguments, "cwd", false).ok()? {
        value if value.is_empty() => Some(workspace_root.to_path_buf()),
        value => resolve_path(workspace_root, &value, false).ok(),
    }
}

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
const DEFAULT_READ_LINES: usize = 1_000;
const MAX_READ_LINES: usize = 2_000;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_COMMAND_YIELD_MS: u64 = 10_000;
const MAX_COMMAND_YIELD_MS: u64 = 30_000;
const MAX_TIMER_MS: i64 = 2_147_483_647;
const MAX_SEARCH_RESULTS: usize = 500;

pub(crate) type ReadHistory = Arc<dyn Fn(i64, usize) -> Result<String, String> + Send + Sync>;

pub type ActionToolFuture = Pin<Box<dyn Future<Output = NativeResult<Value>> + Send>>;
pub type ActionToolsFactory =
    Arc<dyn Fn(&ads_state::PromptQueueEntry) -> Option<ActionTools> + Send + Sync>;

#[derive(Clone)]
pub struct ActionTools {
    review_action: Arc<dyn Fn(Value) -> ActionToolFuture + Send + Sync>,
}

impl ActionTools {
    pub fn new<F, Fut>(review_action: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = NativeResult<Value>> + Send + 'static,
    {
        Self {
            review_action: Arc::new(move |_| Box::pin(review_action())),
        }
    }

    pub fn new_with_arguments<F, Fut>(review_action: F) -> Self
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = NativeResult<Value>> + Send + 'static,
    {
        Self {
            review_action: Arc::new(move |arguments| Box::pin(review_action(arguments))),
        }
    }

    pub async fn review_action(&self) -> NativeResult<Value> {
        (self.review_action)(Value::Null).await
    }

    pub async fn review_action_with_arguments(&self, arguments: Value) -> NativeResult<Value> {
        (self.review_action)(arguments).await
    }
}

#[derive(Clone)]
struct BuiltinCall {
    name: String,
    arguments: String,
    result: Result<NativeToolExecutionResult, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct CommandArtifact {
    pub id: String,
    pub command: String,
    #[serde(skip)]
    pub frame_allowed: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregated_output: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeToolExecutionResult {
    pub output: String,
    pub failed: bool,
    pub state_version: Option<String>,
    pub poll: bool,
    pub loop_result: Option<String>,
    pub changed_files: Vec<ChangedFile>,
    pub command: Option<CommandArtifact>,
}

impl NativeToolExecutionResult {
    fn output(output: String) -> Self {
        Self {
            output,
            failed: false,
            state_version: None,
            poll: false,
            loop_result: None,
            changed_files: Vec::new(),
            command: None,
        }
    }
}

pub(crate) struct NativeToolExecutor {
    workspace_root: PathBuf,
    working_directory: PathBuf,
    redactions: Vec<String>,
    cancellation: Cancellation,
    read_history: Option<ReadHistory>,
    action_tools: Option<ActionTools>,
    middleware: Option<MiddlewarePipeline>,
    middleware_context: Option<TurnContext>,
    builtin_calls: Mutex<HashMap<String, BuiltinCall>>,
    commands: CommandManager,
    command_output: Mutex<HashMap<String, String>>,
}

impl NativeToolExecutor {
    pub fn new(
        workspace_root: PathBuf,
        redactions: Vec<String>,
        cancellation: Cancellation,
        read_history: Option<ReadHistory>,
    ) -> NativeResult<Self> {
        let workspace_root = fs::canonicalize(&workspace_root).map_err(|error| {
            NativeError::Tool(format!(
                "workspace root is unavailable ({}): {error}",
                workspace_root.display()
            ))
        })?;
        if !workspace_root.is_dir() {
            return Err(NativeError::Tool(
                "workspace root is not a directory".to_string(),
            ));
        }
        let redactions = deduplicate_redactions(redactions);
        Ok(Self {
            working_directory: workspace_root.clone(),
            commands: CommandManager::new(redactions.clone(), cancellation.clone()),
            workspace_root,
            redactions,
            cancellation,
            read_history,
            action_tools: None,
            middleware: None,
            middleware_context: None,
            builtin_calls: Mutex::new(HashMap::new()),
            command_output: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_action_tools(mut self, action_tools: ActionTools) -> Self {
        self.action_tools = Some(action_tools);
        self
    }

    pub fn with_middleware(mut self, pipeline: MiddlewarePipeline, context: TurnContext) -> Self {
        self.middleware = Some(pipeline);
        self.middleware_context = Some(context);
        self
    }

    pub fn pending_command_ids(&self) -> Vec<String> {
        self.commands.pending_ids()
    }

    pub async fn dispose(&self) {
        self.commands.dispose().await;
        self.command_output.lock().expect("command output").clear();
        self.builtin_calls.lock().expect("builtin calls").clear();
    }

    pub async fn execute(&self, call: &NativeToolCall) -> NativeResult<NativeToolExecutionResult> {
        self.cancellation.check()?;
        let args = parse_arguments(call)?;
        match call.function.name.as_str() {
            "read_execution_history" => {
                let Some(read_history) = self.read_history.as_ref() else {
                    return Err(NativeError::Tool(
                        "Durable execution history is unavailable in this session.".to_string(),
                    ));
                };
                let after = integer_argument(&args, "after", 0, 0, i64::MAX)?;
                let offset = integer_argument(&args, "offset", 0, 0, i64::MAX)?;
                let output = read_history(after, usize::try_from(offset).unwrap_or(usize::MAX))
                    .map_err(NativeError::Tool)?;
                let mut result = NativeToolExecutionResult::output(output);
                result.state_version = Some("archived-evidence".to_string());
                Ok(result)
            }
            "exec_command" => self.exec_command(call.id.clone(), args).await,
            "wait_command" | "cancel_command" => {
                let session_id = string_argument(&args, "session_id", true)?;
                let yield_ms = command_yield_ms(&args)?;
                let result = self
                    .commands
                    .read(
                        &session_id,
                        yield_ms,
                        call.function.name == "cancel_command",
                    )
                    .await?;
                Ok(self
                    .command_result(result, call.function.name == "wait_command")
                    .await)
            }
            "read_file" => self.read_file(args),
            "search" => self.search(args).await,
            "apply_patch" => self.apply_patch(args),
            "review_action" => self.execute_builtin(call).await,
            _ => Err(NativeError::Tool("Unknown native tool".to_string())),
        }
    }

    async fn execute_builtin(
        &self,
        call: &NativeToolCall,
    ) -> NativeResult<NativeToolExecutionResult> {
        if let Some(cached) = self
            .builtin_calls
            .lock()
            .expect("builtin calls")
            .get(&call.id)
            .cloned()
        {
            if cached.name != call.function.name || cached.arguments != call.function.arguments {
                return Err(NativeError::Tool(
                    "Conflicting arguments for built-in call ID".to_string(),
                ));
            }
            return cached.result.map_err(NativeError::Tool);
        }
        let result = self.run_builtin(call).await;
        let cached_result = result
            .as_ref()
            .map(Clone::clone)
            .map_err(ToString::to_string);
        self.builtin_calls.lock().expect("builtin calls").insert(
            call.id.clone(),
            BuiltinCall {
                name: call.function.name.clone(),
                arguments: call.function.arguments.clone(),
                result: cached_result,
            },
        );
        result
    }

    async fn run_builtin(&self, call: &NativeToolCall) -> NativeResult<NativeToolExecutionResult> {
        let args = parse_arguments(call)?;
        match call.function.name.as_str() {
            "review_action" => {
                if args.keys().any(|key| key != "rework") {
                    return Err(NativeError::Tool(
                        "review_action accepts only the optional rework declaration.".to_string(),
                    ));
                }
                let Some(action_tools) = self.action_tools.as_ref() else {
                    return Err(NativeError::Tool(
                        "review_action is unavailable without an authenticated Acopilot project context."
                            .to_string(),
                    ));
                };
                let result = action_tools
                    .review_action_with_arguments(Value::Object(args))
                    .await?;
                Ok(NativeToolExecutionResult::output(
                    format_builtin_tool_result("review_action", &result),
                ))
            }
            _ => Err(NativeError::Tool("Unknown built-in tool".to_string())),
        }
    }

    async fn exec_command(
        &self,
        call_id: String,
        args: Map<String, Value>,
    ) -> NativeResult<NativeToolExecutionResult> {
        let raw_command = string_argument(&args, "cmd", true)?;
        let provided_args = match args.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(values)) => values.iter().map(argument_text).collect(),
            Some(_) => {
                return Err(NativeError::Tool(
                    "Tool argument args must be an array".to_string(),
                ));
            }
        };
        let shell = provided_args.is_empty() && has_shell_syntax(&raw_command);
        let command_parts = if shell {
            vec![raw_command.clone()]
        } else if provided_args.is_empty() {
            tokenize_command_line(&raw_command)?
        } else {
            vec![raw_command.clone()]
        };
        let Some(command) = command_parts.first().cloned() else {
            return Err(NativeError::Tool(
                "Tool argument cmd is required".to_string(),
            ));
        };
        if !shell && command_parts.len() > 1 && !provided_args.is_empty() {
            return Err(NativeError::Tool(
                "exec_command cmd cannot contain spaces when args is provided".to_string(),
            ));
        }
        let command_args = if shell {
            Vec::new()
        } else if command_parts.len() > 1 {
            command_parts[1..].to_vec()
        } else {
            provided_args
        };
        let command_line = if shell {
            raw_command.clone()
        } else {
            std::iter::once(command.as_str())
                .chain(command_args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string()
        };
        if let (Some(pipeline), Some(context)) =
            (self.middleware.clone(), self.middleware_context.clone())
        {
            let item = MiddlewareItem::command(
                call_id.clone(),
                command_line.clone(),
                "in_progress",
                None,
                "",
            );
            if let Some(reason) = pipeline.execute_item_start(&context, &item).await {
                return Err(NativeError::Tool(reason));
            }
        }
        let cwd = match string_argument(&args, "cwd", false)? {
            value if value.is_empty() => self.working_directory.clone(),
            value => resolve_path(&self.workspace_root, &value, false)?,
        };
        let yield_ms = command_yield_ms(&args)?;
        let max_runtime_ms = if args.contains_key("max_runtime_ms") {
            Some(integer_argument(&args, "max_runtime_ms", 0, 1, MAX_TIMER_MS)? as u64)
        } else {
            None
        };
        let max_output_bytes =
            integer_argument(&args, "max_output_bytes", 64 * 1024, 1024, 262_144)? as usize;
        let request = CommandRequest {
            call_id: call_id.clone(),
            cmd: command,
            args: command_args,
            shell,
            cwd,
            env: None,
            allowlist: allowlist_from_env(),
            max_output_bytes,
            max_runtime_ms,
        };
        command::validate_request(&request)?;
        match self.commands.start(request, yield_ms).await {
            Ok(result) => Ok(self.command_result(result, false).await),
            Err(NativeError::Cancelled) => Err(NativeError::Cancelled),
            Err(error) => Ok(spawn_failure(
                call_id,
                self.redact(&command_line),
                &self.redact(&error.to_string()),
            )),
        }
    }

    async fn command_result(&self, result: CommandRead, poll: bool) -> NativeToolExecutionResult {
        let delta = match (result.stdout.is_empty(), result.stderr.is_empty()) {
            (true, true) => String::new(),
            (false, true) => result.stdout.clone(),
            (true, false) => format!("stderr:\n{}", result.stderr),
            (false, false) => format!("{}\nstderr:\n{}", result.stdout, result.stderr),
        };
        let mut aggregated = self
            .command_output
            .lock()
            .expect("command output")
            .get(&result.session_id)
            .cloned()
            .unwrap_or_default();
        aggregated.push_str(&delta);
        let aggregated = trim_output(&slice_tail_utf16(&aggregated, MAX_TOOL_OUTPUT_CHARS));
        if result.running {
            self.command_output
                .lock()
                .expect("command output")
                .insert(result.session_id.clone(), aggregated.clone());
        } else {
            self.command_output
                .lock()
                .expect("command output")
                .remove(&result.session_id);
        }
        let status = result.terminal_status().to_string();
        let mut payload = result.payload();
        if let Value::Object(record) = &mut payload {
            shrink_payload(record);
        }
        let mut output = payload.to_string();
        if !result.running
            && let (Some(pipeline), Some(context)) =
                (self.middleware.clone(), self.middleware_context.clone())
        {
            let item = MiddlewareItem::command(
                result.call_id.clone(),
                result.command.clone(),
                status.clone(),
                result.exit_code,
                aggregated.trim_end(),
            );
            if let Some(modified) = pipeline.execute_item_end(&context, &item, &output).await {
                output = modified;
            }
        }
        let output = self.redact(&output);
        let loop_result = Some(
            self.redact(
                &json!({
                    "exit_code": result.exit_code,
                    "timed_out": result.timed_out,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                })
                .to_string(),
            ),
        );
        NativeToolExecutionResult {
            output,
            failed: status == "failed",
            state_version: None,
            poll: poll && result.running,
            loop_result,
            changed_files: Vec::new(),
            command: Some(CommandArtifact {
                id: result.call_id,
                command: self.redact(&result.command),
                frame_allowed: false,
                status,
                exit_code: result.exit_code,
                aggregated_output: Some(self.redact(aggregated.trim_end())),
            }),
        }
    }

    fn read_file(&self, args: Map<String, Value>) -> NativeResult<NativeToolExecutionResult> {
        let file = string_argument(&args, "file", true)?;
        let path = resolve_path(&self.workspace_root, &file, false)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| NativeError::Tool(format!("failed to stat {file}: {error}")))?;
        if !metadata.is_file() {
            return Err(NativeError::Tool(
                "read_file target is not a regular file".to_string(),
            ));
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err(NativeError::Tool(
                "File is too large; request a narrower file or use search".to_string(),
            ));
        }
        let start_line = integer_argument(&args, "start_line", 1, 1, i64::MAX)? as usize;
        let line_count = integer_argument(
            &args,
            "line_count",
            DEFAULT_READ_LINES as i64,
            1,
            MAX_READ_LINES as i64,
        )? as usize;
        let content = fs::read_to_string(&path)
            .map_err(|error| NativeError::Tool(format!("failed to read {file}: {error}")))?;
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        hasher.update(mtime_ms.to_string().as_bytes());
        let state_version = format!("{:x}", hasher.finalize());
        let normalized = content.replace("\r\n", "\n");
        let lines = normalized.split('\n').collect::<Vec<_>>();
        let selected_lines = lines
            .iter()
            .skip(start_line.saturating_sub(1))
            .take(line_count)
            .enumerate()
            .map(|(index, line)| format!("{}: {line}", start_line + index))
            .collect::<Vec<_>>();
        let selected_count = selected_lines.len();
        let selected = selected_lines.join("\n");
        let output = self.redact(
            &json!({
                "file": file,
                "start_line": start_line,
                "line_count": selected_count,
                "content": selected,
            })
            .to_string(),
        );
        Ok(NativeToolExecutionResult {
            output,
            failed: false,
            state_version: Some(state_version),
            poll: false,
            loop_result: None,
            changed_files: Vec::new(),
            command: None,
        })
    }

    async fn search(&self, args: Map<String, Value>) -> NativeResult<NativeToolExecutionResult> {
        let pattern = string_argument(&args, "pattern", true)?;
        let target = string_argument(&args, "path", false)?;
        let target_path = if target.is_empty() {
            self.workspace_root.clone()
        } else {
            resolve_path(&self.workspace_root, &target, false)?
        };
        let relative_target = target_path
            .strip_prefix(&self.workspace_root)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let relative_target = if relative_target.is_empty() {
            ".".to_string()
        } else {
            relative_target
        };
        let glob = string_argument(&args, "glob", false)?;
        let max_results =
            integer_argument(&args, "max_results", 200, 1, MAX_SEARCH_RESULTS as i64)? as usize;
        let mut command_args = vec![
            "--line-number".to_string(),
            "--no-heading".to_string(),
            "--color".to_string(),
            "never".to_string(),
        ];
        if !glob.is_empty() {
            command_args.push("--glob".to_string());
            command_args.push(glob);
        }
        command_args.push("--".to_string());
        command_args.push(pattern.clone());
        command_args.push(relative_target.clone());
        command::validate_request(&CommandRequest {
            call_id: String::new(),
            cmd: "rg".to_string(),
            args: command_args.clone(),
            shell: false,
            cwd: self.workspace_root.clone(),
            env: None,
            allowlist: allowlist_from_env(),
            max_output_bytes: 128 * 1024,
            max_runtime_ms: None,
        })?;
        let captured = run_capture(
            "rg",
            &command_args,
            &self.workspace_root,
            128 * 1024,
            SEARCH_TIMEOUT,
            &self.cancellation,
        )
        .await?;
        if captured.exit_code != Some(0) && captured.exit_code != Some(1) {
            let message = if captured.stderr.trim().is_empty() {
                format!("ripgrep exited with {:?}", captured.exit_code)
            } else {
                captured.stderr.trim().to_string()
            };
            return Err(NativeError::Tool(self.redact(&message)));
        }
        let output = captured
            .stdout
            .replace("\r\n", "\n")
            .split('\n')
            .take(max_results)
            .collect::<Vec<_>>()
            .join("\n");
        let state_version = (!captured.truncated_stdout).then(|| {
            let mut hasher = Sha256::new();
            hasher.update(captured.stdout.as_bytes());
            format!("{:x}", hasher.finalize())
        });
        Ok(NativeToolExecutionResult {
            output: self.redact(
                &json!({
                    "pattern": pattern,
                    "path": if target.is_empty() { "." } else { target.as_str() },
                    "results": output,
                })
                .to_string(),
            ),
            failed: false,
            state_version,
            poll: false,
            loop_result: None,
            changed_files: Vec::new(),
            command: None,
        })
    }

    fn apply_patch(&self, args: Map<String, Value>) -> NativeResult<NativeToolExecutionResult> {
        self.cancellation.check()?;
        let patch = string_argument(&args, "patch", true)?;
        let files = patch::apply_patch(&self.workspace_root, &patch, &self.cancellation)?;
        Ok(NativeToolExecutionResult {
            output: self.redact(&json!({ "files": files, "status": "applied" }).to_string()),
            failed: false,
            state_version: None,
            poll: false,
            loop_result: None,
            changed_files: files,
            command: None,
        })
    }

    fn redact(&self, value: &str) -> String {
        truncate_utf16(
            &redact_native_transcript_text(value, &self.redactions, 0),
            MAX_TOOL_OUTPUT_CHARS,
        )
    }
}

pub(crate) fn native_tool_definitions() -> Vec<NativeToolDefinition> {
    vec![
        tool(
            "read_execution_history",
            "Read sanitized execution evidence from this session only. Follow the returned next cursor; starts at after=0, offset=0. This never replays tools.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "after": {"type": "integer", "minimum": 0},
                "offset": {"type": "integer", "minimum": 0}
            }}),
        ),
        tool(
            "exec_command",
            "Start a workspace command and wait briefly. A running result is not completion: use wait_command with its session_id until it exits, never rerun it to fetch output. No default execution deadline. Sessions belong to this turn and are cancelled on turn failure/reset. Use an argument array for simple commands; pipelines may use shell syntax.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "cmd": {"type": "string", "maxLength": 32768, "description": "Executable name or complete shell command, for example npm or git log -n 5 | head -n 2."},
                "args": {"type": "array", "items": {"type": "string"}, "maxItems": 128},
                "cwd": {"type": "string", "description": "Optional workspace-relative working directory."},
                "yield_time_ms": {"type": "integer", "minimum": 1, "maximum": MAX_COMMAND_YIELD_MS, "description": "How long to wait before returning a live session (default 10000). Never kills the command."},
                "max_runtime_ms": {"type": "integer", "minimum": 1, "maximum": MAX_TIMER_MS, "description": "Optional hard execution deadline. Set only when explicitly requested by the user or execution policy; omit for normal builds/tests. Expiry terminates the process group."},
                "max_output_bytes": {"type": "integer", "minimum": 1024, "maximum": 262144}
            }, "required": ["cmd"]}),
        ),
        tool(
            "wait_command",
            "Wait for an existing command session without rerunning it. Returns new complete output lines and terminal status, or running=true. Quiet running commands are not failures. Collect every command's exit status before finishing the turn.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "session_id": {"type": "string"},
                "yield_time_ms": {"type": "integer", "minimum": 1, "maximum": MAX_COMMAND_YIELD_MS}
            }, "required": ["session_id"]}),
        ),
        tool(
            "cancel_command",
            "Explicitly cancel a command session and its process group, collecting its remaining output. Do not cancel solely because a build/test is quiet or still running.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "session_id": {"type": "string"}
            }, "required": ["session_id"]}),
        ),
        tool(
            "read_file",
            "Read a bounded, line-numbered slice of a workspace file.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "file": {"type": "string"},
                "start_line": {"type": "integer", "minimum": 1},
                "line_count": {"type": "integer", "minimum": 1, "maximum": MAX_READ_LINES}
            }, "required": ["file"]}),
        ),
        tool(
            "search",
            "Search workspace text with ripgrep and return bounded results.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
                "max_results": {"type": "integer", "minimum": 1, "maximum": MAX_SEARCH_RESULTS}
            }, "required": ["pattern"]}),
        ),
        tool(
            "apply_patch",
            "Apply an atomic context-anchored patch to workspace files.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "patch": {"type": "string", "maxLength": 512 * 1024}
            }, "required": ["patch"]}),
        ),
        tool(
            "review_action",
            "Enqueue a read-only Reviewer job for the current Issue-backed pull request and return immediately. After a REJECT, provide a complete rework declaration tied to the rejected job; omit rework for the initial review or operational retries.",
            json!({"type": "object", "additionalProperties": false, "properties": {
                "rework": {"type": "object", "additionalProperties": false, "properties": {
                    "prior_job_id": {"type": "string"},
                    "issue_id": {"type": "integer", "minimum": 1},
                    "pr_number": {"type": "integer", "minimum": 1},
                    "base_sha": {"type": "string"},
                    "rejected_head_sha": {"type": "string"},
                    "new_head_sha": {"type": "string"},
                    "root_cause": {"type": "string"},
                    "invariant": {"type": "string"},
                    "audited_scope": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "changed_behavior": {"type": "string"},
                    "regression_cases": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "verification_evidence": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "residual_risks": {"type": "array", "items": {"type": "string"}}
                }, "required": ["prior_job_id", "issue_id", "pr_number", "base_sha", "rejected_head_sha", "new_head_sha", "root_cause", "invariant", "audited_scope", "changed_behavior", "regression_cases", "verification_evidence", "residual_risks"]}
            }}),
        ),
    ]
}

fn tool(name: &str, description: &str, parameters: Value) -> NativeToolDefinition {
    NativeToolDefinition {
        tool_type: "function".to_string(),
        function: NativeToolFunctionDefinition {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
    }
}

fn format_builtin_tool_result(tool: &str, result: &Value) -> String {
    let completed = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut lines = vec![format!(
        "{tool} {}.",
        if completed { "completed" } else { "failed" }
    )];
    if let Some(job_id) = trimmed_string_field(result, "jobId") {
        lines.push(format!("Actions job: {job_id}."));
    }
    if tool == "review_action" {
        if let Some(status) = trimmed_string_field(result, "status") {
            lines.push(format!("Status: {status}."));
        }
        if let Some(issue_id) = number_field(result, "issueId") {
            lines.push(format!("Issue: #{issue_id}."));
        }
        if let Some(note) = trimmed_string_field(result, "note") {
            lines.push(note);
        }
    }
    if let Some(error) = trimmed_string_field(result, "error") {
        lines.push(format!("Reason: {error}"));
    }
    lines.join("\n")
}

fn trimmed_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<String> {
    let value = value.get(key)?;
    if let Some(value) = value.as_i64() {
        return Some(value.to_string());
    }
    let value = value.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 {
        Some((value as i64).to_string())
    } else {
        Some(value.to_string())
    }
}

fn parse_arguments(call: &NativeToolCall) -> NativeResult<Map<String, Value>> {
    let value = if call.function.arguments.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&call.function.arguments)
            .map_err(|_| NativeError::Tool("Invalid JSON arguments for tool".to_string()))?
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| NativeError::Tool("Tool arguments must be a JSON object".to_string()))
}

fn string_argument(args: &Map<String, Value>, key: &str, required: bool) -> NativeResult<String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if required && value.is_empty() {
        return Err(NativeError::Tool(format!(
            "Tool argument {key} is required"
        )));
    }
    Ok(value)
}

fn integer_argument(
    args: &Map<String, Value>,
    key: &str,
    fallback: i64,
    min: i64,
    max: i64,
) -> NativeResult<i64> {
    let value = match args.get(key) {
        None => fallback,
        Some(value) => value.as_i64().ok_or_else(|| {
            NativeError::Tool(format!(
                "Tool argument {key} must be an integer between {min} and {max}"
            ))
        })?,
    };
    if value < min || value > max {
        return Err(NativeError::Tool(format!(
            "Tool argument {key} must be an integer between {min} and {max}"
        )));
    }
    Ok(value)
}

fn command_yield_ms(args: &Map<String, Value>) -> NativeResult<u64> {
    if !args.contains_key("yield_time_ms") && args.contains_key("timeout_ms") {
        return Ok(integer_argument(
            args,
            "timeout_ms",
            DEFAULT_COMMAND_YIELD_MS as i64,
            1,
            MAX_TIMER_MS,
        )?
        .min(MAX_COMMAND_YIELD_MS as i64) as u64);
    }
    Ok(integer_argument(
        args,
        "yield_time_ms",
        DEFAULT_COMMAND_YIELD_MS as i64,
        1,
        MAX_COMMAND_YIELD_MS as i64,
    )? as u64)
}

fn argument_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn deduplicate_redactions(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values.into_iter().filter(|value| !value.is_empty()) {
        for variant in [value.clone(), value.replace("\r\n", "\n")] {
            if !variant.is_empty() && !result.contains(&variant) {
                result.push(variant);
            }
        }
        for line in value.lines().filter(|line| !line.is_empty()) {
            if !result.iter().any(|existing| existing == line) {
                result.push(line.to_string());
            }
        }
    }
    result.sort_by_key(|value| std::cmp::Reverse(value.encode_utf16().count()));
    result
}

fn resolve_path(workspace_root: &Path, value: &str, allow_missing: bool) -> NativeResult<PathBuf> {
    let raw = if value.trim().is_empty() {
        Path::new(".")
    } else {
        Path::new(value.trim())
    };
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace_root.join(raw)
    };
    if !candidate.starts_with(workspace_root) {
        return Err(NativeError::Tool(
            "Path escapes the workspace root".to_string(),
        ));
    }
    match fs::canonicalize(&candidate) {
        Ok(existing) => {
            if !existing.starts_with(workspace_root) {
                return Err(NativeError::Tool(
                    "Symlink target escapes the workspace root".to_string(),
                ));
            }
            Ok(candidate)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !allow_missing {
                return Err(NativeError::Tool(format!("Path does not exist: {value}")));
            }
            let mut parent = candidate.parent().unwrap_or(workspace_root);
            while parent != workspace_root && !parent.exists() {
                parent = parent.parent().unwrap_or(workspace_root);
            }
            let real_parent = fs::canonicalize(parent).map_err(|_| {
                NativeError::Tool("Path parent escapes the workspace root".to_string())
            })?;
            if !real_parent.starts_with(workspace_root) {
                return Err(NativeError::Tool(
                    "Path parent escapes the workspace root".to_string(),
                ));
            }
            Ok(candidate)
        }
        Err(error) => Err(NativeError::Tool(format!(
            "failed to resolve {value}: {error}"
        ))),
    }
}

fn trim_output(text: &str) -> String {
    let lines = text.replace("\r\n", "\n");
    let lines = lines.split('\n').collect::<Vec<_>>();
    if lines.len() <= 200 {
        return lines.join("\n");
    }
    let mut result = lines[..50].to_vec();
    result.push("... output truncated ...");
    result.extend_from_slice(&lines[lines.len() - 150..]);
    result.join("\n")
}

fn shrink_payload(payload: &mut Map<String, Value>) {
    while serde_json::to_string(payload)
        .map(|value| value.encode_utf16().count())
        .unwrap_or(0)
        > MAX_TOOL_OUTPUT_CHARS
    {
        let stdout_len = payload
            .get("stdout")
            .and_then(Value::as_str)
            .map(|value| value.encode_utf16().count())
            .unwrap_or(0);
        let stderr_len = payload
            .get("stderr")
            .and_then(Value::as_str)
            .map(|value| value.encode_utf16().count())
            .unwrap_or(0);
        if stdout_len == 0 && stderr_len == 0 {
            break;
        }
        if stdout_len >= stderr_len {
            let value = payload
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default();
            payload.insert(
                "stdout".to_string(),
                Value::String(slice_utf16(value, stdout_len / 2)),
            );
            payload.insert("truncated_stdout".to_string(), Value::Bool(true));
        } else {
            let value = payload
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default();
            payload.insert(
                "stderr".to_string(),
                Value::String(slice_utf16(value, stderr_len / 2)),
            );
            payload.insert("truncated_stderr".to_string(), Value::Bool(true));
        }
    }
}

fn slice_utf16(value: &str, max_units: usize) -> String {
    let mut result = String::new();
    let mut units = 0usize;
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width > max_units {
            break;
        }
        result.push(character);
        units += width;
    }
    result
}

fn slice_tail_utf16(value: &str, max_units: usize) -> String {
    let total = value.encode_utf16().count();
    if total <= max_units {
        return value.to_string();
    }
    let skip = total - max_units;
    let mut units = 0usize;
    let mut result = String::new();
    for character in value.chars() {
        let width = character.len_utf16();
        if units + width <= skip {
            units += width;
            continue;
        }
        result.push(character);
        units += width;
    }
    result
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    if value.encode_utf16().count() <= max_units {
        return value.to_string();
    }
    format!("{}…", slice_utf16(value, max_units.saturating_sub(1)))
}

fn spawn_failure(call_id: String, command: String, message: &str) -> NativeToolExecutionResult {
    let payload = json!({
        "command": command,
        "session_id": null,
        "running": false,
        "exit_code": -1,
        "signal": null,
        "elapsed_ms": 0,
        "timed_out": false,
        "cancelled": false,
        "stdout": "",
        "stderr": message,
        "truncated_stdout": false,
        "truncated_stderr": false,
    });
    NativeToolExecutionResult {
        output: payload.to_string(),
        failed: true,
        state_version: None,
        poll: false,
        loop_result: Some(
            json!({"exit_code": -1, "timed_out": false, "stdout": "", "stderr": message})
                .to_string(),
        ),
        changed_files: Vec::new(),
        command: Some(CommandArtifact {
            id: call_id,
            command,
            frame_allowed: false,
            status: "failed".to_string(),
            exit_code: Some(-1),
            aggregated_output: Some(message.to_string()),
        }),
    }
}

struct CapturedCommand {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated_stdout: bool,
}

async fn run_capture(
    command: &str,
    args: &[String],
    cwd: &Path,
    max_bytes: usize,
    timeout: Duration,
    cancellation: &Cancellation,
) -> NativeResult<CapturedCommand> {
    let mut child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| NativeError::Tool(format!("failed to start {command}: {error}")))?;
    let stdout_task = child
        .stdout
        .take()
        .map(|stdout| tokio::spawn(read_limited(stdout, max_bytes)));
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(read_limited(stderr, max_bytes)));
    let status = tokio::select! {
        status = child.wait() => status,
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            return Err(NativeError::Tool(format!("{command} timed out")));
        }
        _ = cancellation.cancelled() => {
            let _ = child.kill().await;
            return Err(NativeError::Cancelled);
        }
    }
    .map_err(|error| NativeError::Tool(format!("failed to wait for {command}: {error}")))?;
    let (stdout, truncated_stdout) = match stdout_task {
        Some(task) => task.await.unwrap_or_default(),
        None => (String::new(), false),
    };
    let (stderr, _) = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => (String::new(), false),
    };
    Ok(CapturedCommand {
        exit_code: status.code(),
        stdout,
        stderr,
        truncated_stdout,
    })
}

async fn read_limited<R: AsyncRead + Unpin>(mut reader: R, max_bytes: usize) -> (String, bool) {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => {
                if bytes.len() < max_bytes {
                    let remaining = max_bytes - bytes.len();
                    if read > remaining {
                        bytes.extend_from_slice(&chunk[..remaining]);
                        truncated = true;
                    } else {
                        bytes.extend_from_slice(&chunk[..read]);
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (String::from_utf8_lossy(&bytes).to_string(), truncated)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::NativeToolCall;

    fn call(name: &str, args: Value) -> NativeToolCall {
        NativeToolCall::new(format!("call-{name}"), name, args.to_string())
    }

    #[tokio::test]
    async fn reads_bounded_line_numbered_files() {
        let directory = tempdir().expect("temp dir");
        fs::write(directory.path().join("notes.txt"), "alpha\nbeta\ngamma\n").expect("write");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let result = executor
            .execute(&call(
                "read_file",
                json!({"file": "notes.txt", "start_line": 2, "line_count": 1}),
            ))
            .await
            .expect("read");
        let payload: Value = serde_json::from_str(&result.output).expect("json output");
        assert_eq!(payload["content"], "2: beta");
        assert_eq!(payload["line_count"], 1);
        assert!(result.state_version.is_some());
    }

    #[tokio::test]
    async fn rejects_symlink_escapes_and_blocked_commands() {
        let workspace = tempdir().expect("workspace");
        let outside = tempdir().expect("outside");
        fs::write(outside.path().join("secret.txt"), "secret").expect("secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("secret.txt"),
        )
        .expect("symlink");
        let executor = NativeToolExecutor::new(
            workspace.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let error = executor
            .execute(&call("read_file", json!({"file": "secret.txt"})))
            .await
            .expect_err("escape");
        assert!(error.to_string().contains("Symlink target escapes"));
        let error = executor
            .execute(&call(
                "exec_command",
                json!({"cmd": "rm", "args": ["-f", "state.db"]}),
            ))
            .await
            .expect_err("blocked");
        assert!(error.to_string().contains("blocked by security rule"));
    }

    #[tokio::test]
    async fn applies_patches_atomically() {
        let directory = tempdir().expect("temp dir");
        fs::create_dir_all(directory.path().join("src")).expect("mkdir");
        fs::write(directory.path().join("src/file.txt"), "before\nkeep\n").expect("write");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let patch = [
            "*** Begin Patch",
            "*** Update File: src/file.txt",
            "@@",
            " before",
            "-keep",
            "+after",
            "*** End Patch",
        ]
        .join("\n");
        let result = executor
            .execute(&call("apply_patch", json!({"patch": patch})))
            .await
            .expect("patch");
        assert_eq!(result.changed_files.len(), 1);
        assert_eq!(
            fs::read_to_string(directory.path().join("src/file.txt")).expect("read"),
            "before\nafter\n"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runs_waits_and_cancels_turn_local_commands() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            vec!["secret-value".to_string()],
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let immediate = executor
            .execute(&call(
                "exec_command",
                json!({"cmd": "printf", "args": ["hello"], "yield_time_ms": 5000}),
            ))
            .await
            .expect("exec");
        assert!(!immediate.failed);
        assert_eq!(
            immediate
                .command
                .as_ref()
                .map(|command| command.status.as_str()),
            Some("completed")
        );
        assert_eq!(
            immediate
                .command
                .as_ref()
                .and_then(|command| command.aggregated_output.as_deref()),
            Some("hello")
        );

        let running = executor
            .execute(&call(
                "exec_command",
                json!({
                    "cmd": "/bin/sh",
                    "args": ["-c", "printf 'secret-value\\n'; sleep 5"],
                    "yield_time_ms": 1,
                }),
            ))
            .await
            .expect("start");
        assert!(
            running
                .command
                .as_ref()
                .is_some_and(|command| command.status == "in_progress")
        );
        let session_id: String = serde_json::from_str::<Value>(&running.output)
            .expect("payload")
            .get("session_id")
            .and_then(Value::as_str)
            .expect("session id")
            .to_string();
        assert_eq!(executor.pending_command_ids(), vec![session_id.clone()]);
        let cancelled = executor
            .execute(&call("cancel_command", json!({"session_id": session_id})))
            .await
            .expect("cancel");
        assert!(cancelled.failed);
        assert!(executor.pending_command_ids().is_empty());
        assert!(!cancelled.output.contains("secret-value"));
        executor.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reaps_background_descendants_before_finishing_pumps() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            executor.execute(&call(
                "exec_command",
                json!({
                    "cmd": "/bin/sh",
                    "args": ["-c", "sleep 30 & exit 0"],
                    "yield_time_ms": 5000,
                }),
            )),
        )
        .await
        .expect("command should not wait for the background pipe holder")
        .expect("exec");
        let payload: Value = serde_json::from_str(&result.output).expect("payload");
        assert_eq!(payload["running"], false);
        assert_eq!(payload["exit_code"], 0);
        assert!(executor.pending_command_ids().is_empty());
        executor.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn polls_until_a_command_finishes() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let running = executor
            .execute(&call(
                "exec_command",
                json!({
                    "cmd": "/bin/sh",
                    "args": ["-c", "sleep 0.2; printf ready"],
                    "yield_time_ms": 1,
                }),
            ))
            .await
            .expect("start");
        let running_payload: Value = serde_json::from_str(&running.output).expect("payload");
        assert_eq!(running_payload["running"], true);
        let session_id = running_payload["session_id"]
            .as_str()
            .expect("session id")
            .to_string();
        let completed = executor
            .execute(&call(
                "wait_command",
                json!({"session_id": session_id, "yield_time_ms": 5000}),
            ))
            .await
            .expect("wait");
        let payload: Value = serde_json::from_str(&completed.output).expect("payload");
        assert_eq!(payload["running"], false);
        assert_eq!(payload["exit_code"], 0);
        assert_eq!(payload["stdout"], "ready");
        assert!(!completed.failed);
        executor.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enforces_an_explicit_hard_deadline() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let result = executor
            .execute(&call(
                "exec_command",
                json!({
                    "cmd": "/bin/sh",
                    "args": ["-c", "sleep 30"],
                    "max_runtime_ms": 50,
                    "yield_time_ms": 5000,
                }),
            ))
            .await
            .expect("exec");
        let payload: Value = serde_json::from_str(&result.output).expect("payload");
        assert_eq!(payload["running"], false);
        assert_eq!(payload["timed_out"], true);
        assert!(result.failed);
        executor.dispose().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redacts_spawn_failures() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            vec!["secret-arg".to_string()],
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let result = executor
            .execute(&call(
                "exec_command",
                json!({"cmd": "ads-missing-secret-arg", "yield_time_ms": 100}),
            ))
            .await
            .expect("spawn failure");
        assert!(result.failed);
        assert!(!result.output.contains("secret-arg"));
        assert!(
            result
                .command
                .as_ref()
                .is_some_and(|command| !command.command.contains("secret-arg"))
        );
        executor.dispose().await;
    }

    struct RewriteOutputMiddleware;

    impl crate::AdsMiddleware for RewriteOutputMiddleware {
        fn name(&self) -> &str {
            "rewriteOutput"
        }

        fn on_item_end<'a>(
            &'a self,
            _ctx: &'a TurnContext,
            _item: &'a MiddlewareItem,
            output: &'a str,
        ) -> crate::MiddlewareFuture<'a, Option<String>> {
            Box::pin(async move { Some(format!("rewritten: {output}")) })
        }
    }

    struct BlockCommandMiddleware;

    impl crate::AdsMiddleware for BlockCommandMiddleware {
        fn name(&self) -> &str {
            "blockCommand"
        }

        fn on_item_start<'a>(
            &'a self,
            _ctx: &'a TurnContext,
            _item: &'a MiddlewareItem,
        ) -> crate::MiddlewareFuture<'a, Option<String>> {
            Box::pin(async { Some("blocked by test middleware".to_string()) })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn applies_middleware_hooks_around_command_execution() {
        let directory = tempdir().expect("temp dir");
        let context = TurnContext {
            turn_id: "turn-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: directory.path().to_path_buf(),
            channel: crate::MiddlewareChannel::Web,
            prompt: "run".to_string(),
            original_prompt: Some("run".to_string()),
            metadata: None,
        };
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor")
        .with_middleware(
            MiddlewarePipeline::new().with(Arc::new(RewriteOutputMiddleware)),
            context.clone(),
        );
        let result = executor
            .execute(&call(
                "exec_command",
                json!({"cmd": "/bin/sh", "args": ["-c", "printf hello"], "yield_time_ms": 5000}),
            ))
            .await
            .expect("exec");
        assert!(result.output.starts_with("rewritten:"));
        assert!(result.output.contains("hello"));
        executor.dispose().await;

        let blocked = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor")
        .with_middleware(
            MiddlewarePipeline::new().with(Arc::new(BlockCommandMiddleware)),
            context,
        );
        let error = blocked
            .execute(&call(
                "exec_command",
                json!({"cmd": "/bin/sh", "args": ["-c", "printf hello"]}),
            ))
            .await
            .expect_err("blocked command");
        assert!(error.to_string().contains("blocked by test middleware"));
        blocked.dispose().await;
    }

    #[tokio::test]
    async fn executes_review_action_and_formats_the_result() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor")
        .with_action_tools(ActionTools::new(|| async {
            Ok(json!({
                "ok": true,
                "jobId": "job-1",
                "status": "queued",
                "issueId": 42,
                "note": "Verdict is pending."
            }))
        }));
        let result = executor
            .execute(&call("review_action", json!({})))
            .await
            .expect("review action");
        assert!(!result.failed);
        assert_eq!(
            result.output,
            [
                "review_action completed.",
                "Actions job: job-1.",
                "Status: queued.",
                "Issue: #42.",
                "Verdict is pending.",
            ]
            .join("\n")
        );
        executor.dispose().await;
    }

    #[tokio::test]
    async fn formats_review_action_failures() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor")
        .with_action_tools(ActionTools::new(|| async {
            Ok(json!({"ok": false, "error": "no pull request"}))
        }));
        let result = executor
            .execute(&call("review_action", json!({})))
            .await
            .expect("review action");
        assert_eq!(
            result.output,
            "review_action failed.\nReason: no pull request"
        );
        executor.dispose().await;
    }

    #[tokio::test]
    async fn caches_builtin_results_by_call_id_and_rejects_conflicts() {
        let directory = tempdir().expect("temp dir");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor")
        .with_action_tools(ActionTools::new(move || {
            let counter = Arc::clone(&counter);
            async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(json!({"ok": true, "jobId": "job-1"}))
            }
        }));
        let first = executor
            .execute(&call("review_action", json!({})))
            .await
            .expect("first review action");
        let second = executor
            .execute(&call("review_action", json!({})))
            .await
            .expect("cached review action");
        assert_eq!(first.output, second.output);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let conflict = executor
            .execute(&NativeToolCall::new(
                "call-review_action",
                "review_action",
                json!({"unexpected": true}).to_string(),
            ))
            .await
            .expect_err("conflicting arguments");
        assert!(conflict.to_string().contains("Conflicting arguments"));
        executor.dispose().await;
    }

    #[tokio::test]
    async fn rejects_non_empty_reviewer_arguments() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let error = executor
            .execute(&call("review_action", json!({"extra": true})))
            .await
            .expect_err("non-empty arguments");
        assert!(
            error
                .to_string()
                .contains("review_action accepts only the optional rework declaration.")
        );
        executor.dispose().await;
    }

    #[tokio::test]
    async fn rejects_unknown_tools_and_reports_review_action_unavailable() {
        let directory = tempdir().expect("temp dir");
        let executor = NativeToolExecutor::new(
            directory.path().to_path_buf(),
            Vec::new(),
            Cancellation::new(),
            None,
        )
        .expect("executor");
        let unknown = executor
            .execute(&call("not_a_tool", json!({})))
            .await
            .expect_err("unknown tool");
        assert!(unknown.to_string().contains("Unknown native tool"));
        let review = executor
            .execute(&call("review_action", json!({})))
            .await
            .expect_err("review action");
        assert!(review.to_string().contains("review_action is unavailable"));
    }
}
