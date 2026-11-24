use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ads_reviewer::{ReviewTestReport, ReviewVerificationReport};
use globset::Glob;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::{
    Cancellation, NativeError, NativeResult, NativeToolCall, NativeToolDefinition,
    NativeToolFunctionDefinition,
};

const MAX_OUTPUT: usize = 8_000;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_FILE_LINES: usize = 200;
const SEARCH_PAGE_CHARS: usize = 1_000;
const DIFF_PAGE_CHARS: usize = 7_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ARGUMENT_UNITS: usize = 4_096;
const MAX_VERIFICATION_COMMANDS: usize = 8;
const MAX_VERIFICATION_OUTPUT: usize = 6_000;
const MAX_VERIFICATION_TOOL_OUTPUT: usize = 512;
const MAX_VERIFICATION_COMMAND_UNITS: usize = 1_024;
const MAX_VERIFICATION_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_VERIFICATION_TREE_BYTES: usize = 32 * 1024 * 1024;
const MAX_VERIFICATION_TMPFS_BYTES: u64 = 512 * 1024 * 1024;
const MAX_VERIFICATION_WORKSPACE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_VERIFICATION_CPU_SECONDS: u64 = 30 * 60;
const MAX_VERIFICATION_ADDRESS_SPACE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_VERIFICATION_PROCESS_COUNT: u64 = 512;
const MAX_VERIFICATION_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const SANDBOX_STARTED_MARKER: &str = "ADS_SANDBOX_STARTED";
const VERIFICATION_STARTED_MARKER: &str = "ADS_VERIFICATION_STARTED";
const SANDBOX_BOOTSTRAP: &str = "set -eu; source_root=${ADS_VERIFICATION_SOURCE:?}; workspace_root=${ADS_VERIFICATION_WORKSPACE:?}; cp -a --no-preserve=ownership \"$source_root\"/. \"$workspace_root\"/; cd -- \"$workspace_root/$1\"; shift; printf '%s\\n' 'ADS_SANDBOX_STARTED'; executable_path=$(command -v \"$1\" 2>/dev/null) || exit 127; case \"$executable_path\" in /*) ;; *) exit 127 ;; esac; printf '%s\\n' 'ADS_VERIFICATION_STARTED'; exec \"$@\"";

#[derive(Debug, Clone)]
struct SandboxPrograms {
    resource_limiter: PathBuf,
    bubblewrap: PathBuf,
}

impl Default for SandboxPrograms {
    fn default() -> Self {
        Self {
            resource_limiter: PathBuf::from("prlimit"),
            bubblewrap: PathBuf::from("bwrap"),
        }
    }
}

const SNAPSHOT_UNAVAILABLE: &str = "Inspection snapshot unavailable: Git could not read the reviewed commit within its size/time limits. Do not assume omitted evidence is safe; return INCOMPLETE.";

#[derive(Debug, Clone)]
struct SnapshotEntry {
    file: String,
    object: String,
    size: usize,
}

#[derive(Debug)]
struct VerificationFile {
    path: PathBuf,
    object: String,
    size: u64,
    mode: String,
}

#[derive(Debug)]
pub struct ReviewerInspectionTools {
    workspace: PathBuf,
    commit: String,
    cancellation: Cancellation,
    diff: Option<String>,
    entries: Option<Vec<SnapshotEntry>>,
    diff_read_through: usize,
    snapshot_unavailable: bool,
    verification_workspace: Option<(tempfile::TempDir, PathBuf)>,
    verification_report: Arc<Mutex<ReviewVerificationReport>>,
    verification_unavailable: bool,
    sandbox_programs: SandboxPrograms,
}

impl ReviewerInspectionTools {
    pub fn new(
        workspace: impl Into<PathBuf>,
        commit: impl Into<String>,
        cancellation: Cancellation,
        diff: Option<String>,
    ) -> NativeResult<Self> {
        let commit = commit.into();
        if !commit_hash_regex().is_match(&commit) {
            return Err(NativeError::Configuration(
                "Reviewer inspection requires an exact commit hash.".to_string(),
            ));
        }
        Ok(Self {
            workspace: workspace.into(),
            commit,
            cancellation,
            diff,
            entries: None,
            diff_read_through: 0,
            snapshot_unavailable: false,
            verification_workspace: None,
            verification_report: Arc::new(Mutex::new(ReviewVerificationReport::default())),
            verification_unavailable: false,
            sandbox_programs: SandboxPrograms::default(),
        })
    }

    pub fn with_verification_report(
        mut self,
        report: Arc<Mutex<ReviewVerificationReport>>,
    ) -> Self {
        self.verification_report = report;
        self
    }

    #[cfg(test)]
    fn with_sandbox_programs(mut self, programs: SandboxPrograms) -> Self {
        self.sandbox_programs = programs;
        self
    }

    pub fn verification_report(&self) -> ReviewVerificationReport {
        self.verification_report
            .lock()
            .expect("verification report lock")
            .clone()
    }

    pub fn has_unavailable_verification(&self) -> bool {
        self.verification_unavailable
    }

    pub async fn execute(&mut self, call: &NativeToolCall) -> NativeResult<String> {
        self.cancellation.check()?;
        if utf16_len(&call.function.arguments) > MAX_ARGUMENT_UNITS {
            return Ok(rejection("Tool arguments exceed the 4096-character limit."));
        }
        let arguments = match parse_arguments(&call.function.arguments) {
            Ok(arguments) => arguments,
            Err(message) => return Ok(rejection(&message)),
        };
        let result = match call.function.name.as_str() {
            "read_diff" => self.read_diff(&arguments),
            "read_file_range" => self.read_file_range(&arguments).await,
            "search_code" => self.search_code(&arguments).await,
            "list_dir" => self.list_dir(&arguments).await,
            "run_verification" => self.run_verification(&arguments).await,
            _ => {
                return Ok(
                    "Tool denied: only read_diff, read_file_range, search_code, list_dir and run_verification are allowed."
                        .to_string(),
                );
            }
        };
        self.cancellation.check()?;
        match result {
            Ok(output) => Ok(truncate_output(output)),
            Err(NativeError::Tool(message)) => Ok(rejection(&message)),
            Err(NativeError::Cancelled) => Err(NativeError::Cancelled),
            Err(_) => {
                self.snapshot_unavailable = true;
                Ok(SNAPSHOT_UNAVAILABLE.to_string())
            }
        }
    }

    pub fn has_unavailable_snapshot(&self) -> bool {
        self.snapshot_unavailable
    }

    pub fn has_read_full_diff(&self) -> bool {
        self.diff
            .as_ref()
            .is_some_and(|diff| self.diff_read_through >= utf16_len(diff))
    }

    pub fn diff_progress(&self) -> Option<(usize, usize)> {
        self.diff
            .as_ref()
            .map(|diff| (self.diff_read_through, utf16_len(diff)))
    }

    pub fn dispose(&mut self) {
        self.entries = None;
        self.verification_workspace = None;
    }

    fn read_diff(&mut self, arguments: &Map<String, Value>) -> NativeResult<String> {
        ensure_allowed(arguments, &["offset"])?;
        let offset = optional_integer(arguments, "offset", 0)?;
        let Some(diff) = self.diff.as_deref() else {
            return Err(NativeError::Io(
                "No captured diff is available.".to_string(),
            ));
        };
        let total = utf16_len(diff);
        if offset > total {
            return Err(NativeError::Tool(
                "Diff offset is outside the captured evidence. Restart at offset=0.".to_string(),
            ));
        }
        let (output, end) = diff_page(offset, diff, total)?;
        if offset <= self.diff_read_through {
            self.diff_read_through = self.diff_read_through.max(end);
        }
        Ok(output)
    }

    async fn read_file_range(&mut self, arguments: &Map<String, Value>) -> NativeResult<String> {
        ensure_allowed(arguments, &["path", "start_line", "end_line"])?;
        let path = required_string(arguments, "path", 512)?;
        validate_path(&path)?;
        let start_line = required_integer(arguments, "start_line", 1)? as usize;
        let end_line = required_integer(arguments, "end_line", 1)? as usize;
        if end_line < start_line {
            return Err(NativeError::Tool(
                "end_line must be greater than or equal to start_line.".to_string(),
            ));
        }
        if !permitted(&path) {
            return Err(NativeError::Tool(
                "Path is excluded by inspection policy; secret and generated files cannot be read."
                    .to_string(),
            ));
        }
        let normalized = path.strip_prefix("./").unwrap_or(&path);
        let file = self
            .files()
            .await?
            .into_iter()
            .find(|entry| entry.file == normalized)
            .ok_or_else(|| {
                NativeError::Tool(
                    "File not found among permitted regular snapshot files. Check the path with list_dir; symlinks and submodules cannot be read."
                        .to_string(),
                )
            })?;
        if file.size > MAX_FILE_BYTES {
            return Err(NativeError::Tool(
                "File exceeds the 1 MiB inspection limit. Return INCOMPLETE if this evidence is required."
                    .to_string(),
            ));
        }
        let content = self
            .git(
                &["cat-file".to_string(), "blob".to_string(), file.object],
                MAX_FILE_BYTES,
            )
            .await?;
        if content.contains('\0') {
            return Err(NativeError::Tool(
                "Binary files cannot be inspected.".to_string(),
            ));
        }
        let mut lines = content.split('\n').collect::<Vec<_>>();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        if start_line > lines.len() {
            return Err(NativeError::Tool(format!(
                "start_line is past EOF; the file has {} lines.",
                lines.len()
            )));
        }
        let end = end_line.min(lines.len());
        if end - start_line + 1 > MAX_FILE_LINES {
            return Err(NativeError::Tool(format!(
                "Read at most {MAX_FILE_LINES} lines per call. Reduce end_line or advance start_line."
            )));
        }
        Ok(lines[start_line - 1..end]
            .iter()
            .enumerate()
            .map(|(index, line)| format!("{}: {line}", start_line + index))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    async fn search_code(&mut self, arguments: &Map<String, Value>) -> NativeResult<String> {
        ensure_allowed(arguments, &["query", "path_pattern", "offset"])?;
        let query = required_string(arguments, "query", 256)?;
        if query.is_empty() {
            return Err(NativeError::Tool(
                "String must contain at least 1 character(s)".to_string(),
            ));
        }
        if query.contains('\0') {
            return Err(NativeError::Tool(
                "Search query must not contain NUL characters.".to_string(),
            ));
        }
        let path_pattern = arguments
            .get("path_pattern")
            .map(|_| required_string(arguments, "path_pattern", 256))
            .transpose()?
            .unwrap_or_else(|| "**/*".to_string());
        validate_path(&path_pattern)?;
        let offset = optional_integer(arguments, "offset", 0)?;
        let pattern = Glob::new(&path_pattern).map_err(|_| {
            NativeError::Tool("path_pattern is not a valid workspace glob.".to_string())
        })?;
        let matcher = pattern.compile_matcher();
        let files = self
            .files()
            .await?
            .into_iter()
            .filter(|entry| entry.size <= MAX_FILE_BYTES && matcher.is_match(&entry.file))
            .collect::<Vec<_>>();
        self.search_page(&files, &query, offset).await
    }

    async fn list_dir(&mut self, arguments: &Map<String, Value>) -> NativeResult<String> {
        ensure_allowed(arguments, &["path"])?;
        let path = required_string(arguments, "path", 512)?;
        validate_path(&path)?;
        let directory = path
            .strip_prefix("./")
            .unwrap_or(&path)
            .trim_end_matches('/');
        let prefix = if directory == "." {
            String::new()
        } else {
            format!("{directory}/")
        };
        let mut names = BTreeSet::new();
        for entry in self.files().await? {
            let Some(relative) = entry.file.strip_prefix(&prefix) else {
                continue;
            };
            let name = match relative.find('/') {
                Some(index) => &relative[..=index],
                None => relative,
            };
            names.insert(name.to_string());
        }
        let total = names.len();
        let entries = names.into_iter().take(100).collect::<Vec<_>>();
        Ok(serde_json::to_string(&json!({
            "entries": entries,
            "truncated": total > 100,
        }))
        .unwrap_or_else(|_| "{\"entries\":[],\"truncated\":false}".to_string()))
    }

    async fn run_verification(&mut self, arguments: &Map<String, Value>) -> NativeResult<String> {
        ensure_allowed(arguments, &["executable", "args", "working_directory"])?;
        let executable = required_string(arguments, "executable", 256)?;
        if executable.contains('/') || executable.contains('\\') || executable.starts_with('-') {
            return Err(NativeError::Tool(
                "executable must be a command name without a path.".to_string(),
            ));
        }
        let args = arguments
            .get("args")
            .and_then(Value::as_array)
            .ok_or_else(|| NativeError::Tool("args must be an array of strings.".to_string()))?;
        if args.len() > 128 {
            return Err(NativeError::Tool(
                "args must contain at most 128 strings.".to_string(),
            ));
        }
        let args = args
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.contains('\0') && utf16_len(value) <= 1024)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        NativeError::Tool(
                            "args must contain strings of at most 1024 characters.".to_string(),
                        )
                    })
            })
            .collect::<NativeResult<Vec<_>>>()?;
        let working_directory = arguments
            .get("working_directory")
            .map(|_| required_string(arguments, "working_directory", 512))
            .transpose()?
            .unwrap_or_else(|| ".".to_string());
        if working_directory != "." {
            validate_path(&working_directory)?;
        }
        let display = serde_json::to_string(&json!({
            "executable": executable,
            "args": args,
            "workingDirectory": working_directory,
        }))
        .unwrap_or_else(|_| "<invalid command>".to_string());
        if utf16_len(&display) > MAX_VERIFICATION_COMMAND_UNITS {
            return Err(NativeError::Tool(format!(
                "Verification command must not exceed {MAX_VERIFICATION_COMMAND_UNITS} characters."
            )));
        }
        {
            let mut report = self
                .verification_report
                .lock()
                .expect("verification report lock");
            if report.commands.len() >= MAX_VERIFICATION_COMMANDS {
                return Err(NativeError::Tool(format!(
                    "At most {MAX_VERIFICATION_COMMANDS} verification commands may run per review."
                )));
            }
            report.commands.push(ReviewTestReport {
                command: display.clone(),
                exit_code: 125,
                summary: "Command has not completed.".to_string(),
                output: None,
                sandboxed: false,
                started: false,
            });
        }
        let report_index = self
            .verification_report
            .lock()
            .expect("verification report lock")
            .commands
            .len()
            - 1;

        let result = self
            .execute_verification_command(&executable, &args, &working_directory)
            .await;
        let (exit_code, summary, output, sandboxed, started) = match result {
            Ok(report) => report,
            Err(NativeError::Cancelled) => return Err(NativeError::Cancelled),
            Err(error) => {
                self.verification_unavailable = true;
                (
                    125,
                    "The isolated verification sandbox could not be prepared.".to_string(),
                    Some(error.to_string()),
                    false,
                    false,
                )
            }
        };
        {
            let mut report = self
                .verification_report
                .lock()
                .expect("verification report lock");
            if let Some(command) = report.commands.get_mut(report_index) {
                command.exit_code = exit_code;
                command.summary = summary.clone();
                command.output = output.clone();
                command.sandboxed = sandboxed;
                command.started = started;
            }
        }
        Ok(serde_json::to_string(&json!({
            "command": display,
            "exitCode": exit_code,
            "summary": summary,
            "sandboxed": sandboxed,
            "started": started,
            "output": output
                .as_deref()
                .map(|value| truncate_utf16(value, MAX_VERIFICATION_TOOL_OUTPUT)),
        }))
        .unwrap_or_else(|_| "{\"sandboxed\":false}".to_string()))
    }

    async fn execute_verification_command(
        &mut self,
        executable: &str,
        args: &[String],
        working_directory: &str,
    ) -> NativeResult<(i64, String, Option<String>, bool, bool)> {
        let snapshot = self.materialize_verification_snapshot().await?;
        let cwd = if working_directory == "." {
            snapshot.clone()
        } else {
            snapshot.join(working_directory)
        };

        let mut command =
            sandbox_command(&snapshot, &cwd, executable, args, &self.sandbox_programs)?;
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                NativeError::Io(format!("Verification sandbox unavailable: {error}"))
            })?;
        #[cfg(unix)]
        let pid = child.id();
        let stdout = child
            .stdout
            .take()
            .map(|pipe| tokio::spawn(read_output_tail(pipe, MAX_VERIFICATION_OUTPUT, true)));
        let stderr = child
            .stderr
            .take()
            .map(|pipe| tokio::spawn(read_output_tail(pipe, MAX_VERIFICATION_OUTPUT, false)));
        let status = tokio::select! {
            _ = self.cancellation.cancelled() => {
                terminate_verification(&mut child).await;
                return Err(NativeError::Cancelled);
            }
            result = tokio::time::timeout(VERIFICATION_TIMEOUT, child.wait()) => match result {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => return Err(NativeError::Io(error.to_string())),
                Err(_) => {
                    #[cfg(unix)]
                    if let Some(pid) = pid {
                        terminate_process_group(pid, &mut child).await;
                    } else {
                        terminate_verification(&mut child).await;
                    }
                    #[cfg(not(unix))]
                    terminate_verification(&mut child).await;
                    let (stdout, sandboxed, started) = await_output(stdout).await;
                    let (stderr, _, _) = await_output(stderr).await;
                    let stdout = strip_verification_markers(&stdout);
                    let output = join_output(stdout, &stderr);
                    if !sandboxed {
                        self.verification_unavailable = true;
                        return Ok((
                            125,
                            "The isolated sandbox did not start the verification command.".to_string(),
                            (!output.is_empty()).then_some(truncate_utf16(&output, MAX_VERIFICATION_OUTPUT).to_string()),
                            false,
                            false,
                        ));
                    }
                    return Ok((
                        124,
                        if started {
                            "Verification command timed out after 30 minutes.".to_string()
                        } else {
                            "Verification executable was unavailable in the isolated sandbox.".to_string()
                        },
                        (!output.is_empty()).then_some(truncate_utf16(&output, MAX_VERIFICATION_OUTPUT).to_string()),
                        true,
                        started,
                    ));
                }
            }
        };
        let (stdout, sandboxed, started) = await_output(stdout).await;
        let (stderr, _, _) = await_output(stderr).await;
        let stdout = strip_verification_markers(&stdout);
        let output = join_output(stdout, &stderr);
        if !sandboxed {
            self.verification_unavailable = true;
            return Ok((
                125,
                "The isolated sandbox did not start the verification command.".to_string(),
                Some(truncate_utf16(&output, MAX_VERIFICATION_OUTPUT).to_string()),
                false,
                false,
            ));
        }
        let exit_code = status.code().map(i64::from).unwrap_or(1);
        let summary = if !started {
            "Verification executable was unavailable in the isolated sandbox.".to_string()
        } else if exit_code == 0 {
            "Verification command completed successfully.".to_string()
        } else {
            output
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| truncate_utf16(line, 256).to_string())
                .unwrap_or_else(|| format!("Verification command exited with code {exit_code}."))
        };
        Ok((
            exit_code,
            summary,
            (!output.is_empty())
                .then_some(truncate_utf16(&output, MAX_VERIFICATION_OUTPUT).to_string()),
            true,
            started,
        ))
    }

    async fn materialize_verification_snapshot(&mut self) -> NativeResult<PathBuf> {
        if let Some((_, root)) = self.verification_workspace.as_ref() {
            return Ok(root.clone());
        }
        let temporary = tempfile::Builder::new()
            .prefix("ads-review-snapshot-")
            .tempdir()
            .map_err(|error| NativeError::Io(error.to_string()))?;
        let root = temporary.path().join("workspace");
        fs::create_dir(&root).map_err(|error| NativeError::Io(error.to_string()))?;
        let files = self.verification_files().await?;
        self.materialize_verification_files(&root, &files).await?;
        let result = root.clone();
        self.verification_workspace = Some((temporary, root));
        Ok(result)
    }

    async fn verification_files(&self) -> NativeResult<Vec<VerificationFile>> {
        self.cancellation.check()?;
        let mut command = git_command(&self.workspace);
        command
            .args(["ls-tree", "-r", "-l", "-z", "--full-tree", &self.commit])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| NativeError::Io(error.to_string()))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| NativeError::Io("Git tree output is unavailable.".to_string()))?;
        let tree = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(NativeError::Cancelled),
            result = tokio::time::timeout(
                SNAPSHOT_TIMEOUT,
                read_limited(&mut stdout, MAX_VERIFICATION_TREE_BYTES),
            ) => match result {
                Ok(Ok(tree)) => tree,
                Ok(Err(error)) => return Err(NativeError::Io(error.to_string())),
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(NativeError::Io("Snapshot tree listing timed out.".to_string()));
                }
            }
        };
        let status = tokio::select! {
            _ = self.cancellation.cancelled() => {
                let _ = child.kill().await;
                return Err(NativeError::Cancelled);
            }
            result = tokio::time::timeout(SNAPSHOT_TIMEOUT, child.wait()) => match result {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => return Err(NativeError::Io(error.to_string())),
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(NativeError::Io("Snapshot tree listing timed out.".to_string()));
                }
            }
        };
        if !status.success() {
            return Err(NativeError::Io(
                "The exact reviewed commit tree is unavailable or exceeds its metadata limit."
                    .to_string(),
            ));
        }
        let mut total_size = 0u64;
        let mut files = Vec::new();
        for record in tree
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let separator = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| {
                    NativeError::Io(
                        "The reviewed commit tree contains an invalid entry.".to_string(),
                    )
                })?;
            let metadata = &record[..separator];
            let raw_path = &record[separator + 1..];
            let metadata = std::str::from_utf8(metadata).map_err(|_| {
                NativeError::Io("The reviewed commit tree metadata is invalid.".to_string())
            })?;
            let fields = metadata.split_ascii_whitespace().collect::<Vec<_>>();
            if fields.len() != 4 || fields[1] != "blob" {
                return Err(NativeError::Io(
                    "Verification snapshots containing submodules or unsupported Git entries are unavailable."
                        .to_string(),
                ));
            }
            if !matches!(fields[0], "100644" | "100755" | "120000")
                || !commit_hash_regex().is_match(fields[2])
            {
                return Err(NativeError::Io(
                    "The reviewed commit contains an unsupported file entry.".to_string(),
                ));
            }
            let path = std::str::from_utf8(raw_path).map_err(|_| {
                NativeError::Io("Verification requires UTF-8 repository paths.".to_string())
            })?;
            if !safe_snapshot_path(path) {
                return Err(NativeError::Io(
                    "The reviewed commit contains an unsafe repository path.".to_string(),
                ));
            }
            let size = fields[3].parse::<u64>().map_err(|_| {
                NativeError::Io("The reviewed commit contains an invalid blob size.".to_string())
            })?;
            total_size = total_size
                .checked_add(size)
                .ok_or_else(|| NativeError::Io("Reviewed source size overflowed.".to_string()))?;
            if total_size > MAX_VERIFICATION_SOURCE_BYTES {
                return Err(NativeError::Io(format!(
                    "Reviewed source exceeds the {} MiB verification limit.",
                    MAX_VERIFICATION_SOURCE_BYTES / (1024 * 1024)
                )));
            }
            files.push(VerificationFile {
                path: PathBuf::from(path),
                object: fields[2].to_string(),
                size,
                mode: fields[0].to_string(),
            });
        }
        Ok(files)
    }

    async fn materialize_verification_files(
        &self,
        root: &Path,
        files: &[VerificationFile],
    ) -> NativeResult<()> {
        if files.is_empty() {
            return Ok(());
        }
        let mut command = git_command(&self.workspace);
        command
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| NativeError::Io(error.to_string()))?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| NativeError::Io("Git object input is unavailable.".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| NativeError::Io("Git object output is unavailable.".to_string()))?;
        let mut output = BufReader::new(stdout);
        let materialize = async {
            for file in files {
                self.cancellation.check()?;
                input
                    .write_all(format!("{}\n", file.object).as_bytes())
                    .await
                    .map_err(|error| NativeError::Io(error.to_string()))?;
                input
                    .flush()
                    .await
                    .map_err(|error| NativeError::Io(error.to_string()))?;
                let mut header = String::new();
                output
                    .read_line(&mut header)
                    .await
                    .map_err(|error| NativeError::Io(error.to_string()))?;
                let fields = header.split_ascii_whitespace().collect::<Vec<_>>();
                if fields.len() != 3
                    || fields[0] != file.object
                    || fields[1] != "blob"
                    || fields[2].parse::<u64>().ok() != Some(file.size)
                {
                    return Err(NativeError::Io(
                        "Git could not read an exact reviewed source blob.".to_string(),
                    ));
                }
                let target = root.join(&file.path);
                let parent = target.parent().ok_or_else(|| {
                    NativeError::Io("Reviewed source path has no parent.".to_string())
                })?;
                fs::create_dir_all(parent).map_err(|error| NativeError::Io(error.to_string()))?;
                if file.mode == "120000" {
                    if file.size > 4096 {
                        return Err(NativeError::Io(
                            "Reviewed source contains an oversized symbolic link.".to_string(),
                        ));
                    }
                    let mut link_target = vec![0; file.size as usize];
                    output
                        .read_exact(&mut link_target)
                        .await
                        .map_err(|error| NativeError::Io(error.to_string()))?;
                    create_snapshot_symlink(&link_target, &target)?;
                } else {
                    let mut destination = tokio::fs::File::create(&target)
                        .await
                        .map_err(|error| NativeError::Io(error.to_string()))?;
                    let copied =
                        tokio::io::copy(&mut (&mut output).take(file.size), &mut destination)
                            .await
                            .map_err(|error| NativeError::Io(error.to_string()))?;
                    if copied != file.size {
                        return Err(NativeError::Io(
                            "Git returned a truncated reviewed source blob.".to_string(),
                        ));
                    }
                    destination
                        .flush()
                        .await
                        .map_err(|error| NativeError::Io(error.to_string()))?;
                    #[cfg(unix)]
                    if file.mode == "100755" {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&target, fs::Permissions::from_mode(0o755))
                            .map_err(|error| NativeError::Io(error.to_string()))?;
                    }
                }
                let mut separator = [0u8; 1];
                output
                    .read_exact(&mut separator)
                    .await
                    .map_err(|error| NativeError::Io(error.to_string()))?;
                if separator[0] != b'\n' {
                    return Err(NativeError::Io(
                        "Git returned a malformed reviewed source blob.".to_string(),
                    ));
                }
            }
            Ok(())
        };
        let result = tokio::select! {
            _ = self.cancellation.cancelled() => Err(NativeError::Cancelled),
            result = tokio::time::timeout(SNAPSHOT_TIMEOUT, materialize) => match result {
                Ok(result) => result,
                Err(_) => Err(NativeError::Io("Snapshot materialization timed out.".to_string())),
            }
        };
        drop(input);
        if let Err(error) = result {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
        let status = tokio::select! {
            _ = self.cancellation.cancelled() => {
                let _ = child.kill().await;
                return Err(NativeError::Cancelled);
            }
            result = tokio::time::timeout(SNAPSHOT_TIMEOUT, child.wait()) => match result {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => return Err(NativeError::Io(error.to_string())),
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(NativeError::Io("Snapshot materialization timed out.".to_string()));
                }
            }
        };
        if !status.success() {
            return Err(NativeError::Io(
                "Git could not read the reviewed commit objects.".to_string(),
            ));
        }
        Ok(())
    }

    async fn files(&mut self) -> NativeResult<Vec<SnapshotEntry>> {
        if self.entries.is_none() {
            let output = self
                .git(
                    &[
                        "ls-tree".to_string(),
                        "-r".to_string(),
                        "-l".to_string(),
                        "-z".to_string(),
                        self.commit.clone(),
                    ],
                    2 * 1024 * 1024,
                )
                .await?;
            let entries = output
                .split('\0')
                .filter_map(|entry| {
                    let captures = snapshot_entry_regex().captures(entry)?;
                    let file = captures.get(4)?.as_str().to_string();
                    if !permitted(&file) {
                        return None;
                    }
                    Some(SnapshotEntry {
                        object: captures.get(2)?.as_str().to_string(),
                        size: captures.get(3)?.as_str().parse().ok()?,
                        file,
                    })
                })
                .collect::<Vec<_>>();
            self.entries = Some(entries);
        }
        Ok(self.entries.clone().unwrap_or_default())
    }

    async fn search_page(
        &self,
        files: &[SnapshotEntry],
        query: &str,
        offset: usize,
    ) -> NativeResult<String> {
        if files.is_empty() {
            return encode_page(offset, "", 0);
        }
        self.cancellation.check()?;
        let mut command = git_command(&self.workspace);
        command.args([
            "grep",
            "-I",
            "-n",
            "-F",
            "--no-textconv",
            "--no-recurse-submodules",
            "-e",
            query,
            &self.commit,
            "--",
        ]);
        for file in files {
            command.arg(format!(":(literal){}", file.file));
        }
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().map_err(|error| {
            if error.raw_os_error() == Some(libc::E2BIG) {
                NativeError::Tool(
                    "Search exceeds the process argument limit. Narrow path_pattern.".to_string(),
                )
            } else {
                NativeError::Io("Snapshot search failed or exceeded its time limit.".to_string())
            }
        })?;
        let Some(mut stdout) = child.stdout.take() else {
            return Err(NativeError::Io(
                "Snapshot search failed or exceeded its time limit.".to_string(),
            ));
        };
        let search = async {
            let end_offset = offset.saturating_add(SEARCH_PAGE_CHARS);
            let mut pending = Vec::new();
            let mut content = String::new();
            let mut total = 0usize;
            let mut buffer = [0u8; 8_192];
            loop {
                let read = stdout
                    .read(&mut buffer)
                    .await
                    .map_err(|error| NativeError::Io(error.to_string()))?;
                if read == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..read]);
                let valid_len = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(error) => error.valid_up_to(),
                };
                if valid_len == 0 {
                    continue;
                }
                let chunk = String::from_utf8_lossy(&pending[..valid_len]).into_owned();
                for character in chunk.chars() {
                    let width = character.len_utf16();
                    if total >= offset && total < end_offset {
                        content.push(character);
                    }
                    total += width;
                }
                pending.drain(..valid_len);
            }
            if !pending.is_empty() {
                for character in String::from_utf8_lossy(&pending).chars() {
                    let width = character.len_utf16();
                    if total >= offset && total < end_offset {
                        content.push(character);
                    }
                    total += width;
                }
            }
            let status = child
                .wait()
                .await
                .map_err(|error| NativeError::Io(error.to_string()))?;
            if !matches!(status.code(), Some(0 | 1)) {
                return Err(NativeError::Io(
                    "Snapshot search failed or exceeded its time limit.".to_string(),
                ));
            }
            Ok((content, total))
        };
        let (content, total) = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(NativeError::Cancelled),
            result = tokio::time::timeout(GIT_TIMEOUT, search) => match result {
                Ok(result) => result?,
                Err(_) => return Err(NativeError::Io("Snapshot search failed or exceeded its time limit.".to_string())),
            },
        };
        encode_page(offset, &content, total)
    }

    async fn git(&self, args: &[String], max_buffer: usize) -> NativeResult<String> {
        self.cancellation.check()?;
        let mut command = git_command(&self.workspace);
        command.args(args).stdin(Stdio::null()).kill_on_drop(true);
        let output = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(NativeError::Cancelled),
            result = tokio::time::timeout(GIT_TIMEOUT, command.output()) => match result {
                Ok(Ok(output)) => output,
                _ => return Err(NativeError::Io("Snapshot inspection failed or exceeded its output/time limit.".to_string())),
            },
        };
        if output.stdout.len() > max_buffer || !output.status.success() {
            return Err(NativeError::Io(
                "Snapshot inspection failed or exceeded its output/time limit.".to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

pub fn reviewer_tools() -> Vec<NativeToolDefinition> {
    vec![
        tool(
            "read_diff",
            "Read the captured exact review diff in pages of up to 7000 characters. Start offset=0 and follow next_offset until done. Required for a diff too large for the initial prompt.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {"offset": {"type": "integer", "minimum": 0}}
            }),
        ),
        tool(
            "read_file_range",
            "Read up to 200 numbered lines from a regular file of at most 1 MiB in the reviewed Git commit, not the mutable working tree. end_line is clamped to EOF before the line budget is checked. Output is capped at 8000 characters; request a smaller range if truncated. Correct rejected paths/ranges and retry.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "path": {"type": "string"},
                    "start_line": {"type": "integer", "minimum": 1},
                    "end_line": {"type": "integer", "minimum": 1}
                },
                "required": ["path", "start_line", "end_line"]
            }),
        ),
        tool(
            "search_code",
            "Search literal text (1-256 characters) in permitted regular files of at most 1 MiB in the reviewed commit. path_pattern is a workspace-relative glob. Returns 1000-character pages with offset, content, next_offset, done and total_chars. Start offset=0 and follow next_offset with the same query/glob until done. Narrow path_pattern for large result sets.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "query": {"type": "string", "minLength": 1, "maxLength": 256},
                    "path_pattern": {"type": "string", "maxLength": 256},
                    "offset": {"type": "integer", "minimum": 0}
                },
                "required": ["query"]
            }),
        ),
        tool(
            "list_dir",
            "List direct children in the reviewed commit. Use path '.' for the root. Symlinks, submodules, secrets and generated directories are excluded.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }),
        ),
        tool(
            "run_verification",
            "Run one bounded verification command against the exact reviewed commit in a disposable, network-isolated sandbox. The selected executable and arguments are passed literally (not interpolated into the fixed sandbox bootstrap). Inspect the diff/manifests first and choose checks that cover changed code. Results record separately whether the sandbox and executable started. A sandbox setup failure or unavailable executable is not a test failure and cannot support PASS.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "executable": {"type": "string", "minLength": 1, "maxLength": 256},
                    "args": {"type": "array", "maxItems": 128, "items": {"type": "string", "maxLength": 1024}},
                    "working_directory": {"type": "string", "maxLength": 512}
                },
                "required": ["executable", "args"]
            }),
        ),
    ]
}

fn sandbox_command(
    snapshot: &Path,
    working_directory: &Path,
    executable: &str,
    args: &[String],
    programs: &SandboxPrograms,
) -> NativeResult<Command> {
    let mut command = Command::new(&programs.resource_limiter);
    command.env_clear();
    command.env("PATH", "/usr/bin:/bin");
    command.args([
        format!("--cpu={MAX_VERIFICATION_CPU_SECONDS}:{MAX_VERIFICATION_CPU_SECONDS}"),
        format!(
            "--as={MAX_VERIFICATION_ADDRESS_SPACE_BYTES}:{MAX_VERIFICATION_ADDRESS_SPACE_BYTES}"
        ),
        format!("--nproc={MAX_VERIFICATION_PROCESS_COUNT}:{MAX_VERIFICATION_PROCESS_COUNT}"),
        format!("--fsize={MAX_VERIFICATION_FILE_BYTES}:{MAX_VERIFICATION_FILE_BYTES}"),
    ]);
    command.arg("--").arg(&programs.bubblewrap);
    command.args([
        "--die-with-parent",
        "--unshare-all",
        "--unshare-user",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
    ]);
    for system_path in ["/lib64", "/etc/ssl/certs"] {
        if Path::new(system_path).exists() {
            command.args(["--ro-bind", system_path, system_path]);
        }
    }
    let temporary_size = MAX_VERIFICATION_TMPFS_BYTES.to_string();
    let workspace_size = MAX_VERIFICATION_WORKSPACE_BYTES.to_string();
    command.args([
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--size",
        temporary_size.as_str(),
        "--tmpfs",
        "/tmp",
        "--chmod",
        "1777",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--dir",
        "/tmp/cargo",
        "--dir",
        "/tmp/go",
        "--dir",
        "/tmp/go/pkg",
        "--dir",
        "/tmp/go/pkg/mod",
        "--dir",
        "/tmp/go-build",
        "--dir",
        "/tmp/pip-cache",
        "--dir",
        "/tmp/npm-cache",
        "--dir",
        "/tmp/npm-cache/_cacache",
        "--dir",
        "/toolchain",
        "--dir",
        "/source",
        "--ro-bind",
    ]);
    command.arg(snapshot).args([
        "/source",
        "--size",
        workspace_size.as_str(),
        "--tmpfs",
        "/workspace",
        "--chmod",
        "1777",
        "/workspace",
        "--chdir",
        "/workspace",
    ]);
    let cwd = working_directory.strip_prefix(snapshot).map_err(|_| {
        NativeError::Configuration("Verification directory escaped its snapshot.".to_string())
    })?;
    let mut path_entries = vec![
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cargo"));
        let cargo_bin = cargo_home.join("bin");
        if cargo_bin.is_dir() {
            command.args(["--dir", "/toolchain/cargo-bin"]);
            command
                .args(["--ro-bind"])
                .arg(&cargo_bin)
                .args(["/toolchain/cargo-bin"]);
            path_entries.insert(0, "/toolchain/cargo-bin".to_string());
        }
        for (source, target) in [
            (home.join(".rustup"), PathBuf::from("/toolchain/rustup")),
            (
                cargo_home.join("registry"),
                PathBuf::from("/tmp/cargo/registry"),
            ),
            (cargo_home.join("git"), PathBuf::from("/tmp/cargo/git")),
        ] {
            if source.is_dir() {
                command.args(["--dir"]).arg(&target);
                command.args(["--ro-bind"]).arg(source).arg(target);
            }
        }
        for (source, target) in [
            (home.join("go/pkg/mod"), PathBuf::from("/tmp/go/pkg/mod")),
            (home.join(".cache/pip"), PathBuf::from("/tmp/pip-cache")),
        ] {
            if source.is_dir() {
                command.args(["--dir"]).arg(&target);
                command.args(["--ro-bind"]).arg(source).arg(target);
            }
        }
        let npm_cache = home.join(".npm/_cacache");
        if npm_cache.is_dir() {
            command
                .args(["--ro-bind"])
                .arg(npm_cache)
                .args(["/tmp/npm-cache/_cacache"]);
        }
        if let Some(path) = std::env::var_os("PATH") {
            for entry in std::env::split_paths(&path) {
                let Some(node_root) = entry.parent() else {
                    continue;
                };
                if entry
                    .join("../lib/node_modules/npm/bin/npm-cli.js")
                    .is_file()
                {
                    command.args(["--dir", "/toolchain/node"]);
                    command
                        .args(["--ro-bind"])
                        .arg(node_root)
                        .args(["/toolchain/node"]);
                    path_entries.insert(0, "/toolchain/node/bin".to_string());
                    break;
                }
            }
        }
    }
    command.args([
        "--setenv",
        "PATH",
        &path_entries.join(":"),
        "--setenv",
        "HOME",
        "/tmp/home",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "CARGO_HOME",
        "/tmp/cargo",
        "--setenv",
        "RUSTUP_HOME",
        "/toolchain/rustup",
        "--setenv",
        "GOPATH",
        "/tmp/go",
        "--setenv",
        "GOMODCACHE",
        "/tmp/go/pkg/mod",
        "--setenv",
        "GOCACHE",
        "/tmp/go-build",
        "--setenv",
        "GOPROXY",
        "off",
        "--setenv",
        "GOSUMDB",
        "off",
        "--setenv",
        "PIP_CACHE_DIR",
        "/tmp/pip-cache",
        "--setenv",
        "PIP_NO_INDEX",
        "1",
        "--setenv",
        "CARGO_NET_OFFLINE",
        "true",
        "--setenv",
        "NPM_CONFIG_OFFLINE",
        "true",
        "--setenv",
        "NPM_CONFIG_CACHE",
        "/tmp/npm-cache",
        "--setenv",
        "ADS_VERIFICATION_SOURCE",
        "/source",
        "--setenv",
        "ADS_VERIFICATION_WORKSPACE",
        "/workspace",
        "--",
    ]);
    command
        .args([
            "/bin/sh",
            "-c",
            SANDBOX_BOOTSTRAP,
            "ads-verification",
            cwd.to_string_lossy().as_ref(),
            executable,
        ])
        .args(args);
    #[cfg(unix)]
    command.process_group(0);
    Ok(command)
}

async fn read_output_tail<R>(
    mut reader: R,
    limit: usize,
    capture_markers: bool,
) -> (String, bool, bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let sandbox_marker = format!("{SANDBOX_STARTED_MARKER}\n");
    let verification_marker = format!("{VERIFICATION_STARTED_MARKER}\n");
    let marker_prefix = format!("{sandbox_marker}{verification_marker}");
    let mut prefix = Vec::new();
    let mut buffer = [0u8; 8_192];
    while let Ok(read) = reader.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        if capture_markers && prefix.len() < marker_prefix.len() {
            let remaining = marker_prefix.len().saturating_sub(prefix.len());
            prefix.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() > limit.saturating_mul(4) {
            let remove = bytes.len() - limit.saturating_mul(2);
            bytes.drain(..remove);
        }
    }
    let output = String::from_utf8_lossy(&bytes).into_owned();
    let sandboxed = capture_markers && prefix.starts_with(sandbox_marker.as_bytes());
    let started = capture_markers && prefix.starts_with(marker_prefix.as_bytes());
    (
        truncate_utf16(&output, limit).to_string(),
        sandboxed,
        started,
    )
}

async fn await_output(
    output: Option<tokio::task::JoinHandle<(String, bool, bool)>>,
) -> (String, bool, bool) {
    match output {
        Some(output) => output.await.unwrap_or_default(),
        None => (String::new(), false, false),
    }
}

fn strip_verification_markers(output: &str) -> &str {
    output
        .strip_prefix(&format!(
            "{SANDBOX_STARTED_MARKER}\n{VERIFICATION_STARTED_MARKER}\n"
        ))
        .or_else(|| output.strip_prefix(&format!("{SANDBOX_STARTED_MARKER}\n")))
        .unwrap_or(output)
}

async fn read_limited<R>(reader: &mut R, limit: usize) -> NativeResult<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0u8; 8_192];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| NativeError::Io(error.to_string()))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(NativeError::Io(
                "Snapshot tree metadata exceeds its size limit.".to_string(),
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

fn join_output(stdout: &str, stderr: &str) -> String {
    [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

async fn terminate_verification(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        terminate_process_group(pid, child).await;
        return;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
async fn terminate_process_group(pid: u32, child: &mut tokio::process::Child) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    let _ = child.wait().await;
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

fn git_command(workspace: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .args(["--no-pager", "-c", "core.fsmonitor=false"])
        .current_dir(workspace)
        .kill_on_drop(true);
    for (key, _) in std::env::vars() {
        if key.starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

fn parse_arguments(arguments: &str) -> Result<Map<String, Value>, String> {
    let value: Value = serde_json::from_str(arguments)
        .map_err(|_| "Tool arguments must be valid JSON.".to_string())?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Tool arguments must be a JSON object.".to_string())
}

fn ensure_allowed(arguments: &Map<String, Value>, allowed: &[&str]) -> NativeResult<()> {
    if let Some(key) = arguments
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(NativeError::Tool(format!("Unrecognized key: {key}")));
    }
    Ok(())
}

fn required_string(
    arguments: &Map<String, Value>,
    key: &str,
    max_units: usize,
) -> NativeResult<String> {
    let value = arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| NativeError::Tool(format!("{key}: Required string")))?;
    if value.is_empty() {
        return Err(NativeError::Tool(format!(
            "{key}: String must contain at least 1 character(s)"
        )));
    }
    if utf16_len(value) > max_units {
        return Err(NativeError::Tool(format!(
            "{key}: String must contain at most {max_units} character(s)"
        )));
    }
    Ok(value.to_string())
}

fn required_integer(arguments: &Map<String, Value>, key: &str, minimum: u64) -> NativeResult<u64> {
    arguments
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value >= minimum)
        .ok_or_else(|| NativeError::Tool(format!("{key}: Expected integer >= {minimum}")))
}

fn optional_integer(
    arguments: &Map<String, Value>,
    key: &str,
    default: u64,
) -> NativeResult<usize> {
    match arguments.get(key) {
        None => Ok(default as usize),
        Some(value) => value
            .as_u64()
            .map(|value| value as usize)
            .ok_or_else(|| NativeError::Tool(format!("{key}: Expected integer >= 0"))),
    }
}

fn validate_path(value: &str) -> NativeResult<()> {
    if value.is_empty()
        || utf16_len(value) > 512
        || Path::new(value).is_absolute()
        || value.contains('\\')
        || value.split('/').any(|part| part == "..")
    {
        return Err(NativeError::Tool(
            "Use a workspace-relative path without traversal, absolute paths or backslashes."
                .to_string(),
        ));
    }
    Ok(())
}

fn permitted(file: &str) -> bool {
    !file.split('/').any(|part| {
        matches!(part, ".git" | ".ads" | "node_modules" | "dist")
            || (part.starts_with(".env") && !part.ends_with(".example"))
            || part.to_ascii_lowercase().ends_with(".pem")
            || part.to_ascii_lowercase().ends_with(".key")
    })
}

fn diff_page(offset: usize, diff: &str, total: usize) -> NativeResult<(String, usize)> {
    if offset > total {
        return Err(NativeError::Tool(
            "Page offset is outside the evidence. Restart at offset=0 with the same query and path_pattern."
                .to_string(),
        ));
    }
    let start_byte = byte_index_for_utf16(diff, offset);
    let mut content_units = 0usize;
    let mut end_byte = start_byte;
    for (relative, character) in diff[start_byte..].char_indices() {
        let width = character.len_utf16();
        if content_units + width > DIFF_PAGE_CHARS {
            break;
        }
        content_units += width;
        end_byte = start_byte + relative + character.len_utf8();
    }
    let mut content = &diff[start_byte..end_byte];
    loop {
        let output = encode_page(offset, content, total)?;
        if utf16_len(&output) <= MAX_OUTPUT {
            return Ok((output, offset + utf16_len(content)));
        }
        match content.char_indices().next_back() {
            Some((index, _)) => content = &content[..index],
            None => return Ok((output, offset)),
        }
    }
}

fn encode_page(offset: usize, content: &str, total: usize) -> NativeResult<String> {
    if offset > total {
        return Err(NativeError::Tool(
            "Page offset is outside the evidence. Restart at offset=0 with the same query and path_pattern."
                .to_string(),
        ));
    }
    let next = offset + utf16_len(content);
    serde_json::to_string(&json!({
        "offset": offset,
        "content": content,
        "next_offset": next,
        "done": next == total,
        "total_chars": total,
    }))
    .map_err(|error| NativeError::Io(error.to_string()))
}

fn rejection(message: &str) -> String {
    format!("Inspection request rejected: {message}")
}

fn truncate_output(output: String) -> String {
    if utf16_len(&output) > MAX_OUTPUT {
        format!(
            "{}\n[Output truncated.]",
            truncate_utf16(&output, MAX_OUTPUT)
        )
    } else {
        output
    }
}

fn byte_index_for_utf16(value: &str, target: usize) -> usize {
    let mut units = 0usize;
    for (index, character) in value.char_indices() {
        if units >= target {
            return index;
        }
        let width = character.len_utf16();
        if units + width > target {
            return index;
        }
        units += width;
    }
    value.len()
}

fn truncate_utf16(value: &str, max_units: usize) -> &str {
    if utf16_len(value) <= max_units {
        return value;
    }
    let index = byte_index_for_utf16(value, max_units).min(value.len());
    &value[..index]
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn commit_hash_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$").expect("commit regex"))
}

fn snapshot_entry_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?s)^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$")
            .expect("snapshot entry regex")
    })
}

fn safe_snapshot_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

#[cfg(unix)]
fn create_snapshot_symlink(target: &[u8], path: &Path) -> NativeResult<()> {
    use std::os::unix::ffi::OsStrExt;

    std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(target), path)
        .map_err(|error| NativeError::Io(error.to_string()))
}

#[cfg(not(unix))]
fn create_snapshot_symlink(_target: &[u8], _path: &Path) -> NativeResult<()> {
    Err(NativeError::Io(
        "This platform cannot materialize reviewed symbolic links safely.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repository: &Path, arguments: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(repository)
            .output()
            .expect("git command");
        assert!(
            output.status.success(),
            "git {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn verification_sandbox_uses_a_bounded_tmpfs_and_never_binds_node_modules() {
        let snapshot = Path::new("/tmp/ads-review-test/workspace");
        let command = sandbox_command(
            snapshot,
            snapshot,
            "cargo",
            &[],
            &SandboxPrograms::default(),
        )
        .expect("sandbox command");
        let arguments = command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(command.as_std().get_program(), "prlimit");
        assert!(arguments.windows(5).any(|window| {
            window
                == [
                    "--cpu=1800:1800",
                    "--as=4294967296:4294967296",
                    "--nproc=512:512",
                    "--fsize=1073741824:1073741824",
                    "--",
                ]
        }));
        assert!(
            arguments
                .windows(3)
                .any(|window| { window == ["bwrap", "--die-with-parent", "--unshare-all"] })
        );
        assert!(arguments.windows(3).any(|window| {
            window == ["--ro-bind", "/tmp/ads-review-test/workspace", "/source"]
        }));
        assert!(
            arguments
                .windows(3)
                .any(|window| { window == ["--size", "4294967296", "--tmpfs"] })
        );
        assert!(
            arguments
                .windows(2)
                .any(|window| { window == ["--tmpfs", "/workspace"] })
        );
        assert!(
            arguments.windows(3).any(|window| {
                window == ["--unshare-all", "--unshare-user", "--disable-userns"]
            })
        );
        assert!(
            arguments
                .windows(2)
                .any(|window| window == ["--cap-drop", "ALL"])
        );
        assert!(
            !arguments
                .iter()
                .any(|argument| argument.contains("node_modules"))
        );
    }

    #[tokio::test]
    async fn verification_success_path_executes_the_exact_snapshot_under_hard_limits() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("test directory");
        let repository = directory.path().join("repository");
        fs::create_dir(&repository).expect("repository directory");
        fs::write(repository.join("source.txt"), "line one\nline two\n").expect("source");
        git(&repository, &["init", "-q"]);
        git(&repository, &["add", "-A"]);
        git(
            &repository,
            &[
                "-c",
                "user.name=Reviewer Test",
                "-c",
                "user.email=reviewer@example.com",
                "commit",
                "-q",
                "-m",
                "test snapshot",
            ],
        );
        let commit = git(&repository, &["rev-parse", "HEAD"]);

        let sandbox_workspace = directory.path().join("sandbox-workspace");
        fs::create_dir(&sandbox_workspace).expect("sandbox workspace");
        let launcher = directory.path().join("bwrap-test-launcher");
        // Emulate Bubblewrap's argument handoff so the success path is deterministic on hosts
        // that prohibit user namespaces; the production isolation flags are asserted above.
        let launcher_script = format!(
            "#!/bin/sh\nset -eu\nwhile [ \"$#\" -gt 0 ]; do\n  case \"$1\" in\n    --ro-bind) if [ \"$3\" = /source ]; then export ADS_VERIFICATION_SOURCE=\"$2\"; fi; shift 3 ;;\n    --tmpfs) if [ \"$2\" = /workspace ]; then export ADS_VERIFICATION_WORKSPACE='{}'; fi; shift 2 ;;\n    --size) shift 2 ;;\n    --chmod) shift 3 ;;\n    --setenv) if [ \"$2\" = ADS_VERIFICATION_SOURCE ]; then :; elif [ \"$2\" = ADS_VERIFICATION_WORKSPACE ]; then :; else export \"$2=$3\"; fi; shift 3 ;;\n    --dir|--proc|--dev|--chdir|--cap-drop) shift 2 ;;\n    --die-with-parent|--unshare-all|--unshare-user|--disable-userns) shift ;;\n    --) shift; exec \"$@\" ;;\n    *) exit 125 ;;\n  esac\ndone\nexit 125\n",
            sandbox_workspace.display()
        );
        fs::write(&launcher, launcher_script).expect("test launcher");
        let mut permissions = fs::metadata(&launcher)
            .expect("launcher metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&launcher, permissions).expect("launcher permissions");

        let programs = SandboxPrograms {
            resource_limiter: PathBuf::from("prlimit"),
            bubblewrap: launcher,
        };
        let mut inspection =
            ReviewerInspectionTools::new(&repository, commit, Cancellation::new(), None)
                .expect("inspection tools")
                .with_sandbox_programs(programs);
        let report = Arc::new(Mutex::new(ReviewVerificationReport::default()));
        inspection = inspection.with_verification_report(report.clone());

        let output = inspection
            .execute(&NativeToolCall::new(
                "verification",
                "run_verification",
                json!({
                    "executable": "sh",
                    "args": [
                        "-c",
                        "prlimit --pid $$ --cpu --as --nproc --fsize; grep -F -q 'line one' source.txt"
                    ]
                })
                .to_string(),
            ))
            .await
            .expect("verification call");
        let output: Value = serde_json::from_str(&output).expect("tool response");
        let report = report.lock().expect("verification report");
        let command = report.commands.first().expect("verification command");
        assert!(
            command.sandboxed,
            "launcher reached the sandbox bootstrap: {output}"
        );
        assert!(command.started, "selected executable started: {output}");
        assert_eq!(command.exit_code, 0, "command output: {:?}", command.output);
        assert!(
            command
                .output
                .as_deref()
                .unwrap_or_default()
                .contains("1800")
        );
        assert!(
            command
                .output
                .as_deref()
                .unwrap_or_default()
                .contains("4294967296")
        );
        assert!(
            command
                .output
                .as_deref()
                .unwrap_or_default()
                .contains("512")
        );
        assert!(
            command
                .output
                .as_deref()
                .unwrap_or_default()
                .contains("1073741824")
        );
        assert!(!inspection.has_unavailable_verification());
        assert_eq!(output["exitCode"].as_i64(), Some(0));
    }

    #[test]
    fn snapshot_paths_cannot_escape_the_workspace() {
        assert!(safe_snapshot_path("rust-server/src/lib.rs"));
        assert!(!safe_snapshot_path("../outside"));
        assert!(!safe_snapshot_path("/etc/passwd"));
        assert!(!safe_snapshot_path("src//file.rs"));
        assert!(!safe_snapshot_path("src\\file.rs"));
    }

    #[tokio::test]
    async fn materializes_exact_blobs_without_archive_attributes_or_worktree_changes() {
        let temporary = tempfile::tempdir().expect("temporary repository");
        let repository = temporary.path();
        git(repository, &["init", "-q"]);
        git(repository, &["config", "user.name", "Reviewer Test"]);
        git(
            repository,
            &["config", "user.email", "reviewer@example.com"],
        );
        fs::write(
            repository.join(".gitattributes"),
            "ignored.txt export-ignore\nsubstituted.txt export-subst\n",
        )
        .expect("attributes");
        fs::write(repository.join("ignored.txt"), "tracked but not archived\n")
            .expect("export-ignore file");
        fs::write(repository.join("substituted.txt"), "$Format:%H$\n").expect("export-subst file");
        fs::write(repository.join("target.txt"), "pinned source\n").expect("target file");
        #[cfg(unix)]
        std::os::unix::fs::symlink("target.txt", repository.join("link.txt"))
            .expect("symbolic link");
        git(repository, &["add", "-A"]);
        git(repository, &["commit", "-q", "-m", "snapshot"]);
        let commit = git(repository, &["rev-parse", "HEAD"]);

        fs::write(repository.join("substituted.txt"), "mutable checkout\n")
            .expect("dirty working tree");
        let mut inspection =
            ReviewerInspectionTools::new(repository, commit, Cancellation::new(), None)
                .expect("inspection tools");
        let snapshot = inspection
            .materialize_verification_snapshot()
            .await
            .expect("exact snapshot");

        assert_eq!(
            fs::read_to_string(snapshot.join("ignored.txt")).expect("export-ignore file"),
            "tracked but not archived\n"
        );
        assert_eq!(
            fs::read_to_string(snapshot.join("substituted.txt")).expect("export-subst file"),
            "$Format:%H$\n"
        );
        assert_eq!(
            fs::read_to_string(snapshot.join("target.txt")).expect("target file"),
            "pinned source\n"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::read_to_string(snapshot.join("link.txt")).expect("symbolic link"),
            "pinned source\n"
        );
    }
}
