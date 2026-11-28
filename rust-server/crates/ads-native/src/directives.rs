use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use ads_state::{
    StateError, WorkspaceDb, derive_workspace_state_id, resolve_ads_state_dir,
    workspace_state_path_in,
};
use regex::Regex;

use crate::{NativeError, NativeResult};

const MEMORY_TEMPLATE: &str = "# Memory\n\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDirective {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub body: String,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpannedToolDirective {
    start_byte: usize,
    end_byte: usize,
    directive: ToolDirective,
}

pub fn extract_tool_directives(text: &str) -> Vec<ToolDirective> {
    extract_spanned_tool_directives(text)
        .into_iter()
        .map(|item| item.directive)
        .collect()
}

pub fn strip_tool_directives(text: &str) -> String {
    let matches = extract_spanned_tool_directives(text);
    if matches.is_empty() {
        return text.trim().to_string();
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for item in matches {
        if item.start_byte >= cursor && item.end_byte <= text.len() {
            output.push_str(&text[cursor..item.start_byte]);
            cursor = item.end_byte;
        }
    }
    if cursor < text.len() {
        output.push_str(&text[cursor..]);
    }
    output.trim().to_string()
}

fn extract_spanned_tool_directives(text: &str) -> Vec<SpannedToolDirective> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"(?is)<<<tool\.([a-z0-9_.-]+)([^>]*)>>>\s*(.*?)\s*>>>")
            .expect("tool directive regex")
    });
    let mut out = Vec::new();
    for (seg_start, seg_end) in non_fenced_byte_ranges(text) {
        let slice = &text[seg_start..seg_end];
        for captures in pattern.captures_iter(slice) {
            let Some(full) = captures.get(0) else {
                continue;
            };
            let Some(name_match) = captures.get(1) else {
                continue;
            };
            out.push(SpannedToolDirective {
                start_byte: seg_start + full.start(),
                end_byte: seg_start + full.end(),
                directive: ToolDirective {
                    name: name_match.as_str().trim().to_ascii_lowercase(),
                    attrs: parse_attrs(captures.get(2).map_or("", |value| value.as_str())),
                    body: captures
                        .get(3)
                        .map_or("", |value| value.as_str())
                        .trim()
                        .to_string(),
                    raw: full.as_str().to_string(),
                },
            });
        }
    }
    out
}

fn non_fenced_byte_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut outer_fence: Option<(u8, usize)> = None;
    let mut plain_start: Option<usize> = None;
    let mut offset = 0usize;

    for chunk in text.split_inclusive('\n') {
        let len = chunk.len();
        let line = chunk.trim_end_matches(['\r', '\n']);
        let trimmed_start = line.trim_start();
        if let Some((fence_char, min_len)) = outer_fence {
            if is_closing_code_fence(trimmed_start, fence_char, min_len) {
                outer_fence = None;
            }
        } else if let Some((fence_char, fence_len)) = parse_opening_code_fence(trimmed_start) {
            if let Some(start) = plain_start.take()
                && start < offset
            {
                ranges.push((start, offset));
            }
            outer_fence = Some((fence_char, fence_len));
        } else if plain_start.is_none() {
            plain_start = Some(offset);
        }
        offset += len;
    }
    if offset < text.len() {
        let line = &text[offset..];
        let trimmed_start = line.trim_start();
        if outer_fence.is_none()
            && parse_opening_code_fence(trimmed_start).is_none()
            && plain_start.is_none()
        {
            plain_start = Some(offset);
        }
    }
    if let Some(start) = plain_start
        && start < text.len()
    {
        ranges.push((start, text.len()));
    }
    ranges
}

fn parse_opening_code_fence(trimmed_start: &str) -> Option<(u8, usize)> {
    let first = *trimmed_start.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let count = trimmed_start
        .bytes()
        .take_while(|byte| *byte == first)
        .count();
    if count < 3 {
        return None;
    }
    let info = trimmed_start[count..].trim();
    if first == b'`' && info.contains('`') {
        return None;
    }
    Some((first, count))
}

fn is_closing_code_fence(trimmed_start: &str, fence_char: u8, min_len: usize) -> bool {
    let count = trimmed_start
        .bytes()
        .take_while(|byte| *byte == fence_char)
        .count();
    count >= min_len && trimmed_start[count..].trim().is_empty()
}

pub fn execute_tool_directives(text: &str, workspace_root: &str) -> Vec<String> {
    execute_tool_directives_in(&resolve_ads_state_dir(), workspace_root, text)
}

pub fn execute_tool_directives_in(
    state_dir: &Path,
    workspace_root: &str,
    text: &str,
) -> Vec<String> {
    let mut results = Vec::new();
    for directive in extract_tool_directives(text) {
        let result = match directive.name.as_str() {
            "memory.update" => update_memory_directive(state_dir, workspace_root, &directive),
            "session_search" => search_session_directive(state_dir, workspace_root, &directive),
            _ => Ok("tool.unknown: rejected (unknown tool)".to_string()),
        };
        results.push(
            result.unwrap_or_else(|error| format!("tool.{}: failed: {}", directive.name, error)),
        );
    }
    results
}

fn update_memory_directive(
    state_dir: &Path,
    workspace_root: &str,
    directive: &ToolDirective,
) -> NativeResult<String> {
    let op = match directive.attrs.get("op").map(String::as_str) {
        Some("remove") => "remove",
        Some("replace") => "replace",
        _ => "add",
    };
    let path = workspace_state_path_in(state_dir, workspace_root, "memory.md");
    update_memory_file(&path, op, &directive.body, directive.attrs.get("key"))?;
    Ok(format!("tool.memory.update: ok ({op})"))
}

fn update_memory_file(
    path: &Path,
    op: &str,
    content: &str,
    key: Option<&String>,
) -> NativeResult<()> {
    let current = fs::read_to_string(path).unwrap_or_default();
    let current = if current.is_empty() {
        MEMORY_TEMPLATE.to_string()
    } else {
        current
    };
    let content = content.trim();
    if content.is_empty() {
        return write_memory(path, &current);
    }
    let next = match op {
        "remove" => current
            .lines()
            .filter(|line| line.trim() != content)
            .collect::<Vec<_>>()
            .join("\n"),
        "replace" => replace_memory_key(&current, content, key.map(String::as_str)),
        _ => format!("{}\n{}\n", current.trim_end(), content),
    };
    write_memory(path, &next)
}

fn replace_memory_key(current: &str, content: &str, key: Option<&str>) -> String {
    let key = key.unwrap_or("").trim();
    if key.is_empty() {
        return format!("{}\n{}\n", current.trim_end(), content);
    }
    let marker = format!("<!-- key:{key} -->");
    let Some(start) = current.find(&marker) else {
        return format!("{}\n{}\n{}\n", current.trim_end(), marker, content);
    };
    let after_marker = start + marker.len();
    let end = current[after_marker..]
        .find("\n<!-- key:")
        .map_or(current.len(), |offset| after_marker + offset + 1);
    format!(
        "{}{}\n{}\n{}",
        &current[..start],
        marker,
        content,
        &current[end..]
    )
    .trim_end()
    .to_string()
        + "\n"
}

fn write_memory(path: &Path, content: &str) -> NativeResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(StateError::from)?;
    }
    let max_tokens = std::env::var("ADS_MEMORY_MAX_TOKENS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1024);
    fs::write(path, trim_markdown_to_token_limit(content, max_tokens)).map_err(StateError::from)?;
    Ok(())
}

fn trim_markdown_to_token_limit(content: &str, max_tokens: usize) -> String {
    let sanitized = content
        .replace('\0', "")
        .lines()
        .map(|line| line.chars().take(4000).collect::<String>())
        .collect::<Vec<_>>();
    let mut total = 0;
    let mut kept = Vec::new();
    for line in sanitized.iter().rev() {
        total += line.chars().count().div_ceil(4);
        if total > max_tokens && !kept.is_empty() {
            break;
        }
        kept.push(line.clone());
    }
    kept.reverse();
    format!("{}\n", kept.join("\n").trim_end())
}

fn search_session_directive(
    state_dir: &Path,
    workspace_root: &str,
    directive: &ToolDirective,
) -> NativeResult<String> {
    let query = directive
        .attrs
        .get("query")
        .filter(|value| !value.trim().is_empty())
        .map_or(directive.body.as_str(), String::as_str)
        .trim();
    let limit = directive
        .attrs
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(5)
        .clamp(1, 20);
    let database_path = state_dir
        .join("workspaces")
        .join(derive_workspace_state_id(workspace_root))
        .join("ads.db");
    let database = WorkspaceDb::open(database_path)?;
    let matches = search_session_messages(&database, workspace_root, query, limit)?;
    Ok(format_session_search_result(&matches))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearchMatch {
    pub session_id: String,
    pub role: String,
    pub created_at: i64,
    pub snippet: String,
}

fn search_session_messages(
    database: &WorkspaceDb,
    workspace_root: &str,
    query: &str,
    limit: i64,
) -> NativeResult<Vec<SessionSearchMatch>> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let connection = database.connect()?;
    let workspace_id = derive_workspace_state_id(workspace_root);
    let mut statement = connection
        .prepare(
            "SELECT conversation_messages.conversation_id,
                conversation_messages.role,
                conversation_messages.created_at,
                snippet(conversation_messages_fts, 0, '[', ']', '…', 12)
           FROM conversation_messages_fts
           JOIN conversation_messages ON conversation_messages.id = conversation_messages_fts.rowid
          WHERE conversation_messages_fts MATCH ?1
            AND conversation_messages.workspace_id = ?2
          ORDER BY bm25(conversation_messages_fts)
          LIMIT ?3",
        )
        .map_err(StateError::from)?;
    statement
        .query_map(rusqlite::params![query, workspace_id, limit], |row| {
            Ok(SessionSearchMatch {
                session_id: row.get(0)?,
                role: row.get(1)?,
                created_at: row.get(2)?,
                snippet: row.get(3)?,
            })
        })
        .map_err(StateError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| NativeError::from(StateError::from(error)))
}

fn format_session_search_result(matches: &[SessionSearchMatch]) -> String {
    if matches.is_empty() {
        return "tool.session_search: no matches".to_string();
    }
    let mut lines = vec!["tool.session_search:".to_string()];
    lines.extend(matches.iter().map(|item| {
        format!(
            "- {} {} {}: {}",
            item.session_id, item.role, item.created_at, item.snippet
        )
    }));
    lines.join("\n")
}

fn parse_attrs(raw: &str) -> HashMap<String, String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r#"([a-zA-Z_][\w.-]*)="([^"]*)""#).expect("tool directive attribute regex")
    });
    pattern
        .captures_iter(raw)
        .filter_map(|capture| {
            Some((
                capture.get(1)?.as_str().to_string(),
                capture.get(2)?.as_str().to_string(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn extracts_and_strips_directives() {
        let text = "before\n<<<tool.memory.update op=\"add\">>>\nremember this\n>>>\nafter";
        let directives = extract_tool_directives(text);
        assert_eq!(directives.len(), 1);
        assert_eq!(directives[0].name, "memory.update");
        assert_eq!(
            directives[0].attrs.get("op").map(String::as_str),
            Some("add")
        );
        assert_eq!(directives[0].body, "remember this");
        assert_eq!(strip_tool_directives(text), "before\n\nafter");
    }

    #[test]
    fn ignores_directives_quoted_inside_markdown_code_fences() {
        let text = concat!(
            "Example:\n",
            "```rust\n",
            "let s = \"<<<tool.review_action>>>{}>>>\";\n",
            "```\n\n",
            "~~~text\n",
            "<<<tool.memory.update op=\"add\">>>quoted>>>\n",
            "~~~\n\n",
            "Live:\n",
            "<<<tool.memory.update op=\"add\">>>real>>>\n"
        );
        let directives = extract_tool_directives(text);
        assert_eq!(directives.len(), 1);
        assert_eq!(directives[0].name, "memory.update");
        assert_eq!(directives[0].body, "real");
        let stripped = strip_tool_directives(text);
        assert!(stripped.contains("<<<tool.review_action>>>{}>>>"));
        assert!(stripped.contains("<<<tool.memory.update op=\"add\">>>quoted>>>"));
        assert!(!stripped.contains(">>>real>>>"));
    }

    #[test]
    fn updates_marked_memory_and_searches_sessions() {
        let directory = tempdir().expect("temp dir");
        let state_dir = directory.path().join("state");
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let memory_path = workspace_state_path_in(&state_dir, &workspace, "memory.md");

        update_memory_file(&memory_path, "add", "alpha memory", None).expect("add memory");
        update_memory_file(
            &memory_path,
            "replace",
            "beta memory",
            Some(&"topic".to_string()),
        )
        .expect("replace memory");
        let memory = fs::read_to_string(memory_path).expect("memory");
        assert!(memory.contains("alpha memory"));
        assert!(memory.contains("<!-- key:topic -->\nbeta memory"));

        let database_path = state_dir
            .join("workspaces")
            .join(derive_workspace_state_id(&workspace))
            .join("ads.db");
        let database = WorkspaceDb::open(database_path).expect("workspace db");
        let connection = database.connect().expect("connection");
        let workspace_id = derive_workspace_state_id(&workspace);
        connection
            .execute(
                "INSERT INTO conversations (id, created_at, updated_at, workspace_id)
             VALUES ('conversation-1', 1, 1, ?1)",
                [&workspace_id],
            )
            .expect("conversation");
        connection
            .execute(
                "INSERT INTO conversation_messages
               (conversation_id, role, content, created_at, workspace_id)
             VALUES ('conversation-1', 'user', 'alpha beta searchable', 2, ?1)",
                [&workspace_id],
            )
            .expect("message");
        let matches =
            search_session_messages(&database, workspace.to_string_lossy().as_ref(), "alpha", 5)
                .expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].session_id, "conversation-1");
        assert!(matches[0].snippet.contains("[alpha]"));
    }
}
