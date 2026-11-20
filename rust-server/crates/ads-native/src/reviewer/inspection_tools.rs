use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use globset::Glob;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;
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

const SNAPSHOT_UNAVAILABLE: &str = "Inspection snapshot unavailable: Git could not read the reviewed commit within its size/time limits. Do not assume omitted evidence is safe; return INCOMPLETE.";

#[derive(Debug, Clone)]
struct SnapshotEntry {
    file: String,
    object: String,
    size: usize,
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
        })
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
            _ => {
                return Ok(
                    "Tool denied: only read_diff, read_file_range, search_code and list_dir are allowed."
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
