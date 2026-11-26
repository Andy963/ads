use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{Cancellation, NativeError, NativeResult};

const MAX_PATCH_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ChangedFile {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PatchAction {
    Update,
    Add,
    Delete,
}

#[derive(Debug, Clone)]
struct PatchOperation {
    action: PatchAction,
    file_path: String,
    lines: Vec<String>,
}

pub(crate) fn apply_patch(
    workspace_root: &Path,
    patch: &str,
    cancellation: &Cancellation,
) -> NativeResult<Vec<ChangedFile>> {
    cancellation.check()?;
    let operations = parse_patch_operations(patch)?;
    let mut staged: Vec<(PathBuf, Option<String>)> = Vec::new();
    let mut originals: Vec<(PathBuf, Option<String>, Option<u32>)> = Vec::new();
    let mut changed_files = Vec::with_capacity(operations.len());

    for operation in operations {
        cancellation.check()?;
        let target = super::resolve_path(
            workspace_root,
            &operation.file_path,
            operation.action == PatchAction::Add,
        )?;
        let existing = if let Some((_, content)) = staged.iter().find(|(path, _)| path == &target) {
            content.clone()
        } else if target.exists() {
            Some(read_utf8(&target)?)
        } else {
            None
        };
        if !originals.iter().any(|(path, _, _)| path == &target) {
            let mode = file_mode(&target);
            originals.push((target.clone(), existing.clone(), mode));
        }
        let updated = apply_operation(existing, &operation)?;
        if let Some((_, content)) = staged.iter_mut().find(|(path, _)| path == &target) {
            *content = updated;
        } else {
            staged.push((target, updated));
        }
        changed_files.push(ChangedFile {
            kind: match operation.action {
                PatchAction::Add => "add",
                PatchAction::Delete => "delete",
                PatchAction::Update => "modify",
            }
            .to_string(),
            path: operation.file_path,
        });
    }

    let mut written = Vec::new();
    for (target, content) in &staged {
        cancellation.check()?;
        let result = write_file(target, content.as_deref());
        if let Err(error) = result {
            rollback(&written, &originals);
            return Err(error);
        }
        written.push(target.clone());
    }
    Ok(changed_files)
}

fn read_utf8(path: &Path) -> NativeResult<String> {
    fs::read_to_string(path)
        .map_err(|error| NativeError::Tool(format!("failed to read {}: {error}", path.display())))
}

fn write_file(path: &Path, content: Option<&str>) -> NativeResult<()> {
    match content {
        None => fs::remove_file(path).map_err(|error| {
            NativeError::Tool(format!("failed to delete {}: {error}", path.display()))
        }),
        Some(content) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    NativeError::Tool(format!("failed to create {}: {error}", parent.display()))
                })?;
            }
            fs::write(path, content).map_err(|error| {
                NativeError::Tool(format!("failed to write {}: {error}", path.display()))
            })
        }
    }
}

fn rollback(written: &[PathBuf], originals: &[(PathBuf, Option<String>, Option<u32>)]) {
    let originals = originals
        .iter()
        .map(|(path, content, mode)| (path.clone(), (content.clone(), *mode)))
        .collect::<HashMap<_, _>>();
    for path in written.iter().rev() {
        let Some((content, mode)) = originals.get(path) else {
            continue;
        };
        match content {
            None => {
                let _ = fs::remove_file(path);
            }
            Some(content) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(path, content);
                set_file_mode(path, *mode);
            }
        }
    }
}

fn file_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn set_file_mode(path: &Path, mode: Option<u32>) {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

fn parse_patch_operations(patch: &str) -> NativeResult<Vec<PatchOperation>> {
    if patch.len() > MAX_PATCH_BYTES {
        return Err(NativeError::Tool("Patch is too large".to_string()));
    }
    let normalized = patch.replace("\r\n", "\n");
    let lines = normalized
        .split('\n')
        .filter(|line| *line != "*** Begin Patch" && *line != "*** End Patch")
        .collect::<Vec<_>>();
    let mut operations = Vec::new();
    let mut current: Option<PatchOperation> = None;
    let mut unified_header: Option<(String, String)> = None;
    for line in lines {
        if let Some(path) = line.strip_prefix("*** Update File: ") {
            flush_operation(&mut operations, &mut current)?;
            current = Some(PatchOperation {
                action: PatchAction::Update,
                file_path: normalize_patch_path(path),
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            flush_operation(&mut operations, &mut current)?;
            current = Some(PatchOperation {
                action: PatchAction::Add,
                file_path: normalize_patch_path(path),
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            flush_operation(&mut operations, &mut current)?;
            current = Some(PatchOperation {
                action: PatchAction::Delete,
                file_path: normalize_patch_path(path),
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(path) = line.strip_prefix("--- ") {
            flush_operation(&mut operations, &mut current)?;
            unified_header = Some((normalize_patch_path(path), String::new()));
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            if let Some((old_path, _)) = unified_header.as_mut() {
                let new_path = normalize_patch_path(path);
                let action = if old_path.is_empty() {
                    PatchAction::Add
                } else if new_path.is_empty() {
                    PatchAction::Delete
                } else {
                    PatchAction::Update
                };
                let file_path = if new_path.is_empty() {
                    old_path.clone()
                } else {
                    new_path
                };
                current = Some(PatchOperation {
                    action,
                    file_path,
                    lines: Vec::new(),
                });
                unified_header = None;
            }
            continue;
        }
        if let Some(operation) = current.as_mut() {
            operation.lines.push(line.to_string());
        }
    }
    flush_operation(&mut operations, &mut current)?;
    if operations.is_empty() {
        return Err(NativeError::Tool(
            "Patch contains no file operations".to_string(),
        ));
    }
    if operations.len() > 32 {
        return Err(NativeError::Tool(
            "Patch touches too many files".to_string(),
        ));
    }
    if operations
        .iter()
        .any(|operation| operation.file_path.is_empty())
    {
        return Err(NativeError::Tool(
            "Patch contains an invalid file path".to_string(),
        ));
    }
    Ok(operations)
}

fn flush_operation(
    operations: &mut Vec<PatchOperation>,
    current: &mut Option<PatchOperation>,
) -> NativeResult<()> {
    let Some(operation) = current.take() else {
        return Ok(());
    };
    if operation.action == PatchAction::Update
        && !operation.lines.iter().any(|line| line.starts_with("@@"))
    {
        return Err(NativeError::Tool(format!(
            "Patch for {} has no hunks",
            operation.file_path
        )));
    }
    operations.push(operation);
    Ok(())
}

fn normalize_patch_path(value: &str) -> String {
    let normalized = value.trim();
    let normalized = normalized.strip_prefix("a/").unwrap_or(normalized);
    let normalized = normalized.strip_prefix("b/").unwrap_or(normalized);
    if normalized.is_empty() || normalized == "/dev/null" {
        String::new()
    } else {
        normalized.to_string()
    }
}

fn apply_operation(
    original: Option<String>,
    operation: &PatchOperation,
) -> NativeResult<Option<String>> {
    match operation.action {
        PatchAction::Delete => {
            if original.is_none() {
                return Err(NativeError::Tool(format!(
                    "Cannot delete missing file {}",
                    operation.file_path
                )));
            }
            Ok(None)
        }
        PatchAction::Add => {
            if original.is_some() {
                return Err(NativeError::Tool(format!(
                    "Cannot add existing file {}",
                    operation.file_path
                )));
            }
            let lines = operation
                .lines
                .iter()
                .filter(|line| line.starts_with('+') || line.is_empty())
                .map(|line| line.strip_prefix('+').unwrap_or(line))
                .collect::<Vec<_>>();
            Ok(Some(format!("{}\n", lines.join("\n"))))
        }
        PatchAction::Update => {
            let Some(original) = original else {
                return Err(NativeError::Tool(format!(
                    "Cannot update missing file {}",
                    operation.file_path
                )));
            };
            apply_update_hunks(&original, &operation.lines, &operation.file_path).map(Some)
        }
    }
}

fn split_file(text: &str) -> (Vec<String>, bool) {
    let normalized = text.replace("\r\n", "\n");
    let trailing_newline = normalized.ends_with('\n');
    let body = if trailing_newline {
        &normalized[..normalized.len() - 1]
    } else {
        normalized.as_str()
    };
    (
        body.split('\n').map(str::to_string).collect(),
        trailing_newline,
    )
}

fn apply_update_hunks(
    original: &str,
    patch_lines: &[String],
    file_path: &str,
) -> NativeResult<String> {
    let (mut lines, trailing_newline) = split_file(original);
    let mut hunks = Vec::new();
    let mut current: Option<Vec<String>> = None;
    for line in patch_lines {
        if line.starts_with("@@") {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            current = Some(Vec::new());
            continue;
        }
        if let Some(hunk) = current.as_mut()
            && line != "\\ No newline at end of file"
        {
            hunk.push(line.clone());
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    if hunks.is_empty() {
        return Err(NativeError::Tool(format!(
            "Patch for {file_path} has no hunks"
        )));
    }

    let mut search_from = 0usize;
    for hunk_lines in hunks {
        let old_lines = hunk_lines
            .iter()
            .filter(|line| line.starts_with(' ') || line.starts_with('-'))
            .map(|line| line[1..].to_string())
            .collect::<Vec<_>>();
        let new_lines = hunk_lines
            .iter()
            .filter(|line| line.starts_with(' ') || line.starts_with('+'))
            .map(|line| line[1..].to_string())
            .collect::<Vec<_>>();
        if old_lines.is_empty() && new_lines.is_empty() {
            continue;
        }
        let mut match_at = None;
        if old_lines.len() <= lines.len() {
            for index in search_from..=lines.len() - old_lines.len() {
                if old_lines.iter().enumerate().all(|(offset, expected)| {
                    lines[index + offset].trim_end() == expected.trim_end()
                }) {
                    match_at = Some(index);
                    break;
                }
            }
        }
        let Some(match_at) = match_at else {
            return Err(NativeError::Tool(format!(
                "Patch context did not match {file_path}"
            )));
        };
        let mut replacement = Vec::new();
        let mut old_offset = 0usize;
        for line in &hunk_lines {
            if line.starts_with(' ') {
                replacement.push(
                    lines
                        .get(match_at + old_offset)
                        .cloned()
                        .unwrap_or_else(|| line[1..].to_string()),
                );
                old_offset += 1;
            } else if line.starts_with('-') {
                old_offset += 1;
            } else if let Some(value) = line.strip_prefix('+') {
                replacement.push(value.to_string());
            }
        }
        let suffix = lines.split_off(match_at + old_lines.len());
        lines.truncate(match_at);
        search_from = lines.len() + replacement.len();
        lines.extend(replacement);
        lines.extend(suffix);
    }
    let output = lines.join("\n");
    Ok(if trailing_newline {
        format!("{output}\n")
    } else {
        output
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_context_hunks_and_preserves_matched_whitespace() {
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
        let operations = parse_patch_operations(&patch).expect("operations");
        let result =
            apply_operation(Some("before  \nkeep\n".to_string()), &operations[0]).expect("patched");
        assert_eq!(result.as_deref(), Some("before  \nafter\n"));
    }

    #[test]
    fn fails_before_returning_any_staged_content_when_a_hunk_does_not_match() {
        let operations = parse_patch_operations(
            "*** Begin Patch\n*** Update File: two.txt\n@@\n-missing\n+changed\n*** End Patch",
        )
        .expect("operations");
        assert!(apply_operation(Some("two\n".to_string()), &operations[0]).is_err());
    }
}
