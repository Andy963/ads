use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathValidationFailure {
    MissingPath,
    NotAllowed,
    NotExists,
    NotDirectory,
}

impl PathValidationFailure {
    pub fn message(self) -> &'static str {
        match self {
            Self::MissingPath => "path is required",
            Self::NotAllowed => "path is not allowed",
            Self::NotExists => "path does not exist",
            Self::NotDirectory => "path is not a directory",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWorkspacePath {
    pub absolute_path: PathBuf,
    pub resolved_path: PathBuf,
    pub workspace_root: PathBuf,
}

pub fn resolve_allowed_dirs(raw: Option<&str>, fallback: &Path) -> Vec<PathBuf> {
    let source = raw.map(str::trim).unwrap_or_default();
    let mut dirs: Vec<PathBuf> = source
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| resolve_path(Path::new(value)))
        .collect();
    if dirs.is_empty() {
        dirs.push(resolve_path(fallback));
    }
    dirs
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePathError {
    pub failure: PathValidationFailure,
    pub absolute_path: Option<PathBuf>,
    pub resolved_path: Option<PathBuf>,
}

pub fn validate_workspace_path(
    candidate: &str,
    allowed_dirs: &[PathBuf],
    allow_workspace_root_fallback: bool,
) -> Result<ValidatedWorkspacePath, PathValidationFailure> {
    validate_workspace_path_detailed(candidate, allowed_dirs, allow_workspace_root_fallback)
        .map_err(|error| error.failure)
}

pub fn validate_workspace_path_detailed(
    candidate: &str,
    allowed_dirs: &[PathBuf],
    allow_workspace_root_fallback: bool,
) -> Result<ValidatedWorkspacePath, WorkspacePathError> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return Err(WorkspacePathError {
            failure: PathValidationFailure::MissingPath,
            absolute_path: None,
            resolved_path: None,
        });
    }

    let mut resolved_candidate = PathBuf::from(candidate);
    if !resolved_candidate.is_absolute() {
        for dir in allowed_dirs {
            let joined = dir.join(candidate);
            if joined.exists() && joined.is_dir() {
                resolved_candidate = joined;
                break;
            }
        }
    }

    let absolute_path = resolve_path(&resolved_candidate);
    if !validate_allowed(&absolute_path, allowed_dirs) {
        return Err(WorkspacePathError {
            failure: PathValidationFailure::NotAllowed,
            absolute_path: Some(absolute_path),
            resolved_path: None,
        });
    }
    if !absolute_path.exists() {
        return Err(WorkspacePathError {
            failure: PathValidationFailure::NotExists,
            absolute_path: Some(absolute_path),
            resolved_path: None,
        });
    }

    let resolved_path = realpath_or_original(&absolute_path);
    if !resolved_path.is_dir() {
        return Err(WorkspacePathError {
            failure: PathValidationFailure::NotDirectory,
            absolute_path: Some(absolute_path),
            resolved_path: Some(resolved_path),
        });
    }

    let mut workspace_root = resolve_workspace_root_from_directory(&resolved_path);
    if !validate_allowed(&workspace_root, allowed_dirs) {
        if !allow_workspace_root_fallback {
            return Err(WorkspacePathError {
                failure: PathValidationFailure::NotAllowed,
                absolute_path: Some(absolute_path),
                resolved_path: Some(resolved_path),
            });
        }
        workspace_root = resolved_path.clone();
    }

    Ok(ValidatedWorkspacePath {
        absolute_path,
        resolved_path,
        workspace_root,
    })
}

pub fn detect_workspace_root(start_dir: &Path) -> PathBuf {
    realpath_or_original(&detect_workspace_from(start_dir))
}

fn resolve_workspace_root_from_directory(start_dir: &Path) -> PathBuf {
    let detected = detect_workspace_from(start_dir);
    realpath_or_original(&detected)
}

fn detect_workspace_from(start_dir: &Path) -> PathBuf {
    match find_marker(".git", start_dir, 10) {
        Some(root) => root,
        None => resolve_path(start_dir),
    }
}

fn find_marker(marker: &str, start_dir: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut current = resolve_path(start_dir);
    for _ in 0..max_depth {
        if current.join(marker).exists() {
            if marker == ".git" && is_system_temp_root(&current) {
                return None;
            }
            return Some(current);
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            break;
        }
        current = parent;
    }
    None
}

fn is_system_temp_root(dir: &Path) -> bool {
    let temp_root = std::env::temp_dir();
    realpath_or_original(dir) == realpath_or_original(&temp_root)
}

fn validate_allowed(path: &Path, allowed_dirs: &[PathBuf]) -> bool {
    let absolute = resolve_path(path);
    let real = if absolute.exists() {
        realpath_or_original(&absolute)
    } else {
        absolute
    };

    for allowed_dir in allowed_dirs {
        let allowed_absolute = resolve_path(allowed_dir);
        let allowed_real = if allowed_absolute.exists() {
            realpath_or_original(&allowed_absolute)
        } else {
            allowed_absolute
        };
        if real == allowed_real || real.starts_with(&allowed_real) {
            return true;
        }
    }
    false
}

fn resolve_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn realpath_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
