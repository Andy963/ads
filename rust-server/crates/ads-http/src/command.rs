use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::skills::{
    SkillPaths, discover_skills, init_skill, load_skill_body, normalize_skill_name,
    parse_resource_list, render_skill_list, validate_skill_directory,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    pub command: String,
    pub body: String,
}

pub fn parse_slash_command(message: &str) -> Option<SlashCommand> {
    let without_slash = message.strip_prefix('/')?.trim();
    if without_slash.is_empty() {
        return None;
    }
    match without_slash.find(' ') {
        None => Some(SlashCommand {
            command: without_slash.to_string(),
            body: String::new(),
        }),
        Some(index) => Some(SlashCommand {
            command: without_slash[..index].to_string(),
            body: without_slash[index + 1..].trim().to_string(),
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCommandRequest {
    pub command: String,
    pub slash: Option<SlashCommand>,
    pub normalized_slash: Option<String>,
    pub silent: bool,
    pub should_broadcast: bool,
}

pub const EMPTY_COMMAND_PAYLOAD: &str = "Payload must be a command string";

pub fn parse_command_request(
    payload: Option<&Value>,
) -> Result<ParsedCommandRequest, &'static str> {
    let raw = sanitize_command_payload(payload).ok_or(EMPTY_COMMAND_PAYLOAD)?;
    if raw.is_empty() {
        return Err(EMPTY_COMMAND_PAYLOAD);
    }
    let command = raw.trim().to_string();
    let silent = payload
        .and_then(Value::as_object)
        .and_then(|record| record.get("silent"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let slash = parse_slash_command(&command);
    let normalized_slash = slash.as_ref().map(|slash| slash.command.to_lowercase());
    let is_cd = normalized_slash.as_deref() == Some("cd");
    Ok(ParsedCommandRequest {
        command,
        slash,
        normalized_slash,
        silent,
        should_broadcast: !silent && !is_cd,
    })
}

fn sanitize_command_payload(payload: Option<&Value>) -> Option<String> {
    match payload {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Object(record)) => record
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

pub fn is_blocked_user_slash_command(normalized_slash: Option<&str>) -> bool {
    matches!(
        normalized_slash,
        Some("search" | "bootstrap" | "vsearch" | "review" | "ads")
    ) || normalized_slash.is_some_and(|value| value.starts_with("ads."))
}

#[derive(Debug, Clone, Default)]
pub struct AdsCommandOptions {
    pub workspace_root: Option<PathBuf>,
    pub skill_paths: Option<SkillPaths>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLineResult {
    pub ok: bool,
    pub output: String,
}

impl CommandLineResult {
    fn ok(output: impl Into<String>) -> Self {
        Self {
            ok: true,
            output: output.into(),
        }
    }

    fn error(output: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: output.into(),
        }
    }
}

const ADS_HELP: &str = "User-facing slash commands are disabled. Use the Web UI and skills to drive GitHub Issues and Pull Requests.";

pub fn run_ads_command_line(input: &str, cwd: &Path) -> CommandLineResult {
    run_ads_command_line_with_options(input, cwd, &AdsCommandOptions::default())
}

pub fn run_ads_command_line_with_options(
    input: &str,
    cwd: &Path,
    options: &AdsCommandOptions,
) -> CommandLineResult {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return CommandLineResult::ok("");
    }
    let Some(slash) = parse_slash_command(trimmed) else {
        return CommandLineResult::error("❓ Unsupported command");
    };
    if !slash.command.starts_with("ads.") {
        return CommandLineResult::error("❓ Unsupported command");
    }

    let args = parse_command_args(trimmed);
    let skill_paths = options
        .skill_paths
        .clone()
        .unwrap_or_else(SkillPaths::from_env);
    match slash.command.as_str() {
        "ads.help" => CommandLineResult::ok(ADS_HELP),
        "ads.init" => {
            let name = args
                .params
                .get("name")
                .cloned()
                .or_else(|| (!args.positional.is_empty()).then(|| args.positional.join(" ")));
            CommandLineResult::ok(format_response(&init_workspace(cwd, name.as_deref())))
        }
        "ads.workspace" => CommandLineResult::ok(format_response(&workspace_info(cwd))),
        "ads.skill.init" => {
            let name = args
                .params
                .get("name")
                .cloned()
                .unwrap_or_else(|| args.positional.join(" "));
            let name = name.trim();
            if name.is_empty() {
                return CommandLineResult::error("❌ Missing skill name");
            }
            let include_examples = args
                .params
                .get("examples")
                .is_some_and(|value| matches!(value.as_str(), "true" | "1" | "yes" | "on"));
            let resources =
                match parse_resource_list(args.params.get("resources").map(String::as_str)) {
                    Ok(resources) => resources,
                    Err(error) => return CommandLineResult::error(error),
                };
            let created = init_skill(
                crate::skills::InitSkillParams {
                    raw_name: name.to_string(),
                    resources,
                    include_examples,
                },
                &skill_paths,
            );
            match created {
                Ok(created) => {
                    let relative_dir =
                        relative_path(&created.skill_dir, &skill_paths.global_skills_dir);
                    let relative_files = created
                        .created_files
                        .iter()
                        .map(|path| relative_path(path, &skill_paths.global_skills_dir))
                        .collect::<Vec<_>>();
                    let mut lines = vec![
                        format!("✅ Skill 已创建: {}", created.skill_name),
                        format!("目录: {relative_dir}"),
                    ];
                    if !relative_files.is_empty() {
                        lines.push(format!(
                            "文件:\n{}",
                            relative_files
                                .iter()
                                .map(|path| format!("- {path}"))
                                .collect::<Vec<_>>()
                                .join("\n")
                        ));
                    }
                    lines.push(
                        "提示：编辑 SKILL.md 完成 TODO，然后在对话中使用该 skill。".to_string(),
                    );
                    CommandLineResult::ok(lines.join("\n"))
                }
                Err(error) => CommandLineResult::error(format!("❌ 创建 skill 失败: {error}")),
            }
        }
        "ads.skill.list" => {
            let skills = discover_skills(&skill_paths);
            CommandLineResult::ok(render_skill_list(&skills))
        }
        "ads.skill.load" => {
            let name = args
                .params
                .get("name")
                .cloned()
                .unwrap_or_else(|| args.positional.join(" "));
            let name = name.trim();
            if name.is_empty() {
                return CommandLineResult::error(
                    "❌ Missing skill name. Usage: /ads.skill.load <name>",
                );
            }
            match load_skill_body(name, &skill_paths) {
                Some(body) => CommandLineResult::ok(body.trim()),
                None => {
                    let skills = discover_skills(&skill_paths);
                    let available = if skills.is_empty() {
                        "当前没有可用的 skill".to_string()
                    } else {
                        format!(
                            "可用 skill: {}",
                            skills
                                .iter()
                                .map(|skill| skill.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    };
                    CommandLineResult::error(format!("❌ Skill \"{name}\" 未找到。{available}"))
                }
            }
        }
        "ads.skill.validate" => {
            let argument = args
                .params
                .get("path")
                .cloned()
                .unwrap_or_else(|| args.positional.join(" "));
            let argument = argument.trim();
            if argument.is_empty() {
                return CommandLineResult::error("❌ Missing skill name/path");
            }
            let looks_like_path = argument.contains('/')
                || argument.contains('\\')
                || argument.starts_with('.')
                || argument.starts_with('~');
            let skill_dir = if looks_like_path {
                PathBuf::from(argument)
            } else {
                skill_paths
                    .global_skills_dir
                    .join(normalize_skill_name(argument))
            };
            let result = validate_skill_directory(&skill_dir);
            let relative_dir = relative_path(&result.skill_dir, &skill_paths.global_skills_dir);
            CommandLineResult {
                ok: result.valid,
                output: format!(
                    "{} {}
目录: {relative_dir}",
                    if result.valid { "✅" } else { "❌" },
                    result.message
                ),
            }
        }
        other => CommandLineResult::error(format!("❓ Unknown command: {other}")),
    }
}

fn relative_path(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

struct ParsedArgs {
    positional: Vec<String>,
    params: HashMap<String, String>,
}

fn parse_command_args(input: &str) -> ParsedArgs {
    let mut positional = Vec::new();
    let mut params = HashMap::new();
    for token in input.split_whitespace().skip(1) {
        if let Some(flag) = token.strip_prefix("--") {
            if let Some(index) = flag.find('=') {
                params.insert(flag[..index].to_string(), flag[index + 1..].to_string());
            } else {
                params.insert(flag.to_string(), "true".to_string());
            }
            continue;
        }
        positional.push(
            token
                .trim_matches(|value| value == '\'' || value == '"')
                .to_string(),
        );
    }
    ParsedArgs { positional, params }
}

fn format_response(text: &str) -> String {
    if text.trim().is_empty() {
        return "(无输出)".to_string();
    }
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(text) else {
        return text.to_string();
    };
    if let Some(error) = record.get("error").and_then(Value::as_str)
        && !error.is_empty()
    {
        return format!("❌ {error}");
    }
    if let Some(message) = record.get("message").and_then(Value::as_str)
        && !message.is_empty()
    {
        return message.to_string();
    }
    serde_json::to_string_pretty(&Value::Object(record)).unwrap_or_else(|_| text.to_string())
}

fn init_workspace(cwd: &Path, name: Option<&str>) -> String {
    // The TypeScript initializer ignores the lane cwd and uses process.cwd().
    let root = std::env::current_dir().unwrap_or_else(|_| cwd.to_path_buf());
    let workspace_name = name.map(str::to_string).unwrap_or_else(|| {
        root.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string()
    });
    let config_path = ads_state::workspace_state_path(&root, "workspace.json");
    let db_path = ads_state::workspace_state_path(&root, "ads.db");
    let config = json!({
        "name": workspace_name,
        "created_at": iso_utc_now(),
        "version": "1.0",
    });
    let write = config_path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid state path"))
        .and_then(std::fs::create_dir_all)
        .and_then(|_| {
            std::fs::write(
                &config_path,
                serde_json::to_string_pretty(&config).unwrap_or_default(),
            )
        });
    match write {
        Ok(()) => serde_json::to_string(&json!({
            "success": true,
            "workspace": { "path": root.to_string_lossy(), "name": workspace_name },
            "created": { "config": config_path, "db": db_path },
            "message": format!("工作空间已初始化: {}", root.to_string_lossy()),
        }))
        .unwrap_or_default(),
        Err(error) => serde_json::to_string(&json!({
            "success": false,
            "error": error.to_string(),
        }))
        .unwrap_or_default(),
    }
}

fn workspace_info(cwd: &Path) -> String {
    let root = crate::paths::detect_workspace_root(cwd);
    let config_path = ads_state::workspace_state_path(&root, "workspace.json");
    let legacy_config_path = root.join(".ads").join("workspace.json");
    let is_initialized = config_path.exists() || legacy_config_path.exists();
    let mut info = Map::new();
    info.insert("path".to_string(), json!(root.to_string_lossy()));
    info.insert("is_initialized".to_string(), json!(is_initialized));
    info.insert(
        "db_path".to_string(),
        json!(resolve_workspace_db_path(&root).to_string_lossy()),
    );
    let resolved_config = if config_path.exists() {
        Some(config_path)
    } else if legacy_config_path.exists() {
        Some(legacy_config_path)
    } else {
        None
    };
    if let Some(path) = resolved_config
        && let Ok(content) = std::fs::read_to_string(path)
        && let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&content)
    {
        for (key, value) in record {
            info.insert(key, value);
        }
    }
    serde_json::to_string(&Value::Object(info)).unwrap_or_else(|_| "{}".to_string())
}

fn resolve_workspace_db_path(root: &Path) -> PathBuf {
    let configured = std::env::var("ADS_DATABASE_PATH")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()
        .map(|value| {
            value
                .trim()
                .strip_prefix("sqlite://")
                .unwrap_or_else(|| value.trim())
                .to_string()
        })
        .filter(|value| !value.is_empty());
    if let Some(configured) = configured {
        let resolved = resolve_path(
            Path::new(&configured),
            &std::env::current_dir().unwrap_or_default(),
        );
        if let Some(parent) = resolved.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if !resolved.exists() {
            let _ = std::fs::write(&resolved, "");
        }
        return resolved;
    }
    let path = ads_state::workspace_db_path(root);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !path.exists() {
        let _ = std::fs::write(&path, "");
    }
    path
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CwdError {
    pub message: String,
}

pub fn default_user_cwd(allowed_dirs: &[PathBuf]) -> PathBuf {
    allowed_dirs
        .first()
        .cloned()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

pub fn set_user_cwd(input: &str, allowed_dirs: &[PathBuf]) -> Result<PathBuf, CwdError> {
    let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let absolute = resolve_path(Path::new(input), &base);
    if !validate_path(&absolute, allowed_dirs) {
        return Err(CwdError {
            message: format!(
                "目录不在白名单内。允许的目录：\n{}",
                allowed_dirs
                    .iter()
                    .map(|dir| dir.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        });
    }
    if !absolute.exists() {
        return Err(CwdError {
            message: format!("目录不存在: {}", absolute.to_string_lossy()),
        });
    }
    Ok(absolute)
}

fn validate_path(path: &Path, allowed_dirs: &[PathBuf]) -> bool {
    let real = realpath_or_original(path);
    allowed_dirs.iter().any(|allowed| {
        let allowed = realpath_or_original(&resolve_path(allowed, Path::new("/")));
        real.strip_prefix(&allowed).is_ok()
    })
}

fn realpath_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn resolve_path(path: &Path, base: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexical(path)
    } else {
        normalize_lexical(&base.join(path))
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                result.push(component.as_os_str());
            }
        }
    }
    result
}

fn iso_utc_now() -> String {
    let millis = ads_contract::time::now_unix_millis().max(0);
    let seconds = millis / 1000;
    let millis_part = millis % 1000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis_part:03}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slash_commands_like_the_typescript_parser() {
        assert_eq!(
            parse_slash_command("/cd some dir"),
            Some(SlashCommand {
                command: "cd".to_string(),
                body: "some dir".to_string(),
            })
        );
        assert_eq!(parse_slash_command("/"), None);
        assert_eq!(parse_slash_command("plain"), None);
    }

    #[test]
    fn parses_silent_command_payloads() {
        let payload = json!({ "command": " /cd next ", "silent": true });
        let parsed = parse_command_request(Some(&payload)).expect("command");
        assert_eq!(parsed.command, "/cd next");
        assert_eq!(parsed.normalized_slash.as_deref(), Some("cd"));
        assert!(parsed.silent);
        assert!(!parsed.should_broadcast);
    }

    #[test]
    fn rejects_empty_command_payloads() {
        assert_eq!(
            parse_command_request(None).unwrap_err(),
            EMPTY_COMMAND_PAYLOAD
        );
        assert_eq!(
            parse_command_request(Some(&json!(""))).unwrap_err(),
            EMPTY_COMMAND_PAYLOAD
        );
        assert_eq!(
            parse_command_request(Some(&json!({ "command": 1 }))).unwrap_err(),
            EMPTY_COMMAND_PAYLOAD
        );
    }

    #[test]
    fn blocks_reserved_slash_commands() {
        for command in [
            "search",
            "bootstrap",
            "vsearch",
            "review",
            "ads",
            "ads.help",
        ] {
            assert!(is_blocked_user_slash_command(Some(command)), "{command}");
        }
        assert!(!is_blocked_user_slash_command(Some("pwd")));
        assert!(!is_blocked_user_slash_command(None));
    }

    #[test]
    fn validates_cwd_against_allowed_dirs_and_symlinks() {
        let directory = tempfile::tempdir().expect("tempdir");
        let allowed = directory.path().join("allowed");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&allowed).expect("allowed");
        std::fs::create_dir_all(&outside).expect("outside");
        let allowed_dirs = vec![allowed.clone()];

        let inside = allowed.join("child");
        std::fs::create_dir_all(&inside).expect("child");
        assert_eq!(
            set_user_cwd(&inside.to_string_lossy(), &allowed_dirs).expect("inside"),
            inside
        );
        let error = set_user_cwd(&outside.to_string_lossy(), &allowed_dirs).unwrap_err();
        assert!(error.message.starts_with("目录不在白名单内"));
        let error =
            set_user_cwd(&allowed.join("missing").to_string_lossy(), &allowed_dirs).unwrap_err();
        assert!(error.message.starts_with("目录不存在"));
    }

    #[test]
    fn formats_unknown_commands() {
        assert_eq!(
            run_ads_command_line("/foo", Path::new("/tmp")),
            CommandLineResult::error("❓ Unsupported command")
        );
        assert_eq!(
            run_ads_command_line("/ads.nope", Path::new("/tmp")),
            CommandLineResult::error("❓ Unknown command: ads.nope")
        );
    }
}
