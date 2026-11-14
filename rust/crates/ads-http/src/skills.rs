use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_yaml::{Mapping, Value as Yaml};

const SKILL_FILE_NAME: &str = "SKILL.md";
const SKILLS_METADATA_FILE: &str = "metadata.yaml";
const MAX_SKILL_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;
const ALLOWED_RESOURCE_DIRS: [&str; 3] = ["scripts", "references", "assets"];
const BUILTIN_SKILL_CREATOR: &str =
    include_str!("../../../../server/skills/builtin/skill-creator/SKILL.md");

const SKILL_TEMPLATE: &str = r#"---
name: {skill_name}
description: "[TODO: Describe what this skill does and when to use it]"
version: 1
provides: []
priority: 100
platforms: [linux, macos, win32]
required_env: []
triggers:
  keywords: []
  intents: []
entrypoints: []
---

# {skill_title}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## [TODO: Main section]

[TODO: Add content]
"#;

const EXAMPLE_SCRIPT: &str = r#"#!/usr/bin/env python3
"""
Example helper script for {skill_name}

This is a placeholder script that can be executed directly.
Replace with actual implementation or delete if not needed.
"""

def main():
    print("This is an example script for {skill_name}")

if __name__ == "__main__":
    main()
"#;

const EXAMPLE_REFERENCE: &str = r#"# Reference Documentation for {skill_title}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

## Structure Suggestions

- Overview
- Authentication
- Endpoints with examples
- Error codes
"#;

const EXAMPLE_ASSET: &str = r#"# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output the agent produces.
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPaths {
    pub global_skills_dir: PathBuf,
    pub legacy_state_dir: Option<PathBuf>,
    pub metadata_path: Option<PathBuf>,
    pub builtin_skills_root: Option<PathBuf>,
    pub migrate_legacy: bool,
}

impl SkillPaths {
    pub fn from_env() -> Self {
        let codex_home = resolve_codex_home_dir();
        let metadata_path = env_path("ADS_SKILLS_METADATA_PATH");
        let builtin_skills_root = env_path("ADS_BUILTIN_SKILLS_DIR").or_else(|| {
            let candidate = repo_root().join("server").join("skills").join("builtin");
            candidate.is_dir().then_some(candidate)
        });
        Self {
            global_skills_dir: codex_home.join("skills"),
            legacy_state_dir: Some(ads_state::resolve_ads_state_dir()),
            metadata_path,
            builtin_skills_root,
            migrate_legacy: std::env::var("ADS_MIGRATE_LEGACY_SKILLS")
                .map(|value| value != "0")
                .unwrap_or(true),
        }
    }

    pub fn global_skills_dir(&self) -> &Path {
        &self.global_skills_dir
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSource {
    Global,
    Builtin,
}

impl SkillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Builtin => "builtin",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRequiredEnv {
    pub name: String,
    pub prompt: Option<String>,
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SkillTriggers {
    pub keywords: Vec<String>,
    pub intents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillEntrypoint {
    pub cmd: String,
    pub script: Option<String>,
    pub args_template: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub location: PathBuf,
    pub source: SkillSource,
    pub version: i64,
    pub provides: Vec<String>,
    pub priority: i64,
    pub platforms: Vec<String>,
    pub required_env: Vec<SkillRequiredEnv>,
    pub triggers: SkillTriggers,
    pub entrypoints: Vec<SkillEntrypoint>,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    pub version: i64,
    pub provides: Vec<String>,
    pub priority: i64,
    pub platforms: Vec<String>,
    pub required_env: Vec<SkillRequiredEnv>,
    pub triggers: SkillTriggers,
    pub entrypoints: Vec<SkillEntrypoint>,
    pub deprecated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMigrationResult {
    pub migrated: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitSkillParams {
    pub raw_name: String,
    pub resources: Vec<String>,
    pub include_examples: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitSkillResult {
    pub skill_name: String,
    pub skill_dir: PathBuf,
    pub created_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidateSkillResult {
    pub valid: bool,
    pub message: String,
    pub skill_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegistryEntry {
    provides: Vec<String>,
    priority: i64,
    enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillRegistry {
    whitelist: bool,
    skills: BTreeMap<String, RegistryEntry>,
}

pub fn migrate_legacy_state_skills(
    state_dir: &Path,
    global_skills_dir: &Path,
) -> SkillMigrationResult {
    let legacy_skills_dir = state_dir.join(".agent").join("skills");
    let mut result = SkillMigrationResult {
        migrated: Vec::new(),
        skipped: Vec::new(),
    };
    let Ok(entries) = fs::read_dir(&legacy_skills_dir) else {
        return result;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }
        let skill_name = entry.file_name().to_string_lossy().to_string();
        let source_dir = entry.path();
        if !source_dir.join(SKILL_FILE_NAME).is_file() {
            continue;
        }
        let target_dir = global_skills_dir.join(&skill_name);
        if target_dir.exists() {
            result.skipped.push(skill_name);
            continue;
        }
        let staging_dir = global_skills_dir.join(format!(
            ".staging-{skill_name}-{}-{}",
            ads_contract::time::now_unix_millis(),
            uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        ));
        let migrated = fs::create_dir_all(global_skills_dir)
            .and_then(|_| copy_directory(&source_dir, &staging_dir))
            .and_then(|_| {
                if target_dir.exists() {
                    Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "destination skill appeared during migration",
                    ))
                } else {
                    fs::rename(&staging_dir, &target_dir)
                }
            });
        match migrated {
            Ok(()) => result.migrated.push(skill_name),
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_dir);
                if error.kind() == io::ErrorKind::AlreadyExists {
                    result.skipped.push(skill_name);
                }
            }
        }
    }
    result
}

pub fn discover_skills(paths: &SkillPaths) -> Vec<SkillMetadata> {
    if paths.migrate_legacy {
        if let Some(state_dir) = paths.legacy_state_dir.as_deref() {
            let _ = migrate_legacy_state_skills(state_dir, &paths.global_skills_dir);
        }
    }

    let mut by_name: BTreeMap<String, SkillMetadata> = BTreeMap::new();
    collect_directory_skills(&paths.global_skills_dir, SkillSource::Global, &mut by_name);
    match paths.builtin_skills_root.as_deref() {
        Some(root) => collect_directory_skills(root, SkillSource::Builtin, &mut by_name),
        None => collect_embedded_builtin_skills(&mut by_name),
    }

    let mut skills = by_name.into_values().collect::<Vec<_>>();
    apply_registry_overrides(&mut skills, paths);
    skills.sort_by_key(|skill| skill.name.to_lowercase());
    skills
}

pub fn load_skill_body(name: &str, paths: &SkillPaths) -> Option<String> {
    let lowered = name.to_lowercase();
    for skill in discover_skills(paths) {
        if skill.name.to_lowercase() == lowered {
            if skill.source == SkillSource::Builtin
                && paths.builtin_skills_root.is_none()
                && skill.name == "skill-creator"
            {
                return Some(BUILTIN_SKILL_CREATOR.to_string());
            }
            return fs::read_to_string(&skill.location).ok();
        }
    }
    None
}

pub fn render_skill_list(skills: &[SkillMetadata]) -> String {
    if skills.is_empty() {
        return "当前没有可用的 skill。使用 /ads.skill.init <name> 创建。".to_string();
    }
    let mut lines = vec![format!("共 {} 个可用 skill：", skills.len()), String::new()];
    for skill in skills {
        lines.push(format!(
            "- **{}** ({}): {}",
            skill.name,
            skill.source.as_str(),
            skill.description
        ));
    }
    lines.push(String::new());
    lines.push("使用 /ads.skill.load <name> 加载具体 skill。".to_string());
    lines.join("\n")
}

pub fn render_compact_skills(skills: &[SkillMetadata]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut lines = vec!["<available_skills>".to_string()];
    for skill in skills {
        lines.push(format!(
            "  <skill name=\"{}\" source=\"{}\">",
            skill.name,
            skill.source.as_str()
        ));
        lines.push(format!("    {}", skill.description));
        lines.push("  </skill>".to_string());
    }
    lines.push("</available_skills>".to_string());
    lines.join("\n")
}

pub fn render_skill_meta_instruction(skills: &[SkillMetadata]) -> String {
    if skills.is_empty() {
        return [
            "<skill_system>",
            "当前没有可用的 skill。",
            "当你需要扩展能力时，可以使用 /ads.skill.init <name> 创建新的 skill。",
            "skill 存放位置：全局 $CODEX_HOME/skills/<name>/SKILL.md（默认 ~/.codex/skills）。",
            "</skill_system>",
        ]
        .join("\n");
    }
    [
        "<skill_system>",
        &format!("当前有 {} 个可用 skill。", skills.len()),
        "ADS 会按用户请求自动加载匹配 skill 的完整内容。",
        "当上下文中有 <requested_skills> 时，直接按其内容执行；`location` 是该 SKILL.md 的绝对路径，脚本就在同目录下。",
        "不得为了寻找已经注入的 skill 或其脚本再次调用 /ads.skill.list、/ads.skill.load 或搜索整个文件系统。",
        "如果没有匹配 skill，才使用 /ads.skill.list 查看能力，或使用 /ads.skill.init <name> 创建新的 skill。",
        "",
        "不要猜测，优先使用已注入的专业指导。",
        "</skill_system>",
    ]
    .join("\n")
}

pub fn normalize_skill_name(raw: &str) -> String {
    let mut normalized = raw.trim().to_lowercase();
    normalized = normalized
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    normalized = normalized.trim_matches('-').to_string();
    while normalized.contains("--") {
        normalized = normalized.replace("--", "-");
    }
    normalized
}

pub fn parse_resource_list(raw: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let resources = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalize_resources(resources)
}

pub fn normalize_resources(resources: Vec<String>) -> Result<Vec<String>, String> {
    let mut invalid = resources
        .iter()
        .filter(|resource| !ALLOWED_RESOURCE_DIRS.contains(&resource.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !invalid.is_empty() {
        invalid.sort();
        let mut allowed = ALLOWED_RESOURCE_DIRS.to_vec();
        allowed.sort_unstable();
        return Err(format!(
            "Unknown resource type(s): {}. Allowed: {}",
            invalid.join(", "),
            allowed.join(", ")
        ));
    }
    let mut seen = HashSet::new();
    Ok(resources
        .into_iter()
        .filter(|resource| seen.insert(resource.clone()))
        .collect())
}

pub fn init_skill(params: InitSkillParams, paths: &SkillPaths) -> Result<InitSkillResult, String> {
    let raw_name = params.raw_name.trim();
    if raw_name.is_empty() {
        return Err("Skill name is required.".to_string());
    }
    let skill_name = validate_new_skill_name(raw_name)?;
    let skill_dir = paths.global_skills_dir.join(&skill_name);
    if skill_dir.exists() {
        return Err(format!(
            "Skill directory already exists: {}",
            skill_dir.to_string_lossy()
        ));
    }
    fs::create_dir_all(&skill_dir).map_err(|error| error.to_string())?;

    let skill_title = title_case_skill_name(&skill_name);
    let skill_md_path = skill_dir.join(SKILL_FILE_NAME);
    let content = fill_template(
        SKILL_TEMPLATE,
        &[("skill_name", &skill_name), ("skill_title", &skill_title)],
    );
    fs::write(&skill_md_path, content).map_err(|error| error.to_string())?;
    let mut created_files = vec![skill_md_path];

    for resource in normalize_resources(params.resources)? {
        let resource_dir = skill_dir.join(&resource);
        fs::create_dir_all(&resource_dir).map_err(|error| error.to_string())?;
        if !params.include_examples {
            continue;
        }
        let (file_name, content) = match resource.as_str() {
            "scripts" => (
                "example.py",
                fill_template(
                    EXAMPLE_SCRIPT,
                    &[("skill_name", &skill_name), ("skill_title", &skill_title)],
                ),
            ),
            "references" => (
                "api_reference.md",
                fill_template(
                    EXAMPLE_REFERENCE,
                    &[("skill_name", &skill_name), ("skill_title", &skill_title)],
                ),
            ),
            _ => ("example_asset.txt", EXAMPLE_ASSET.to_string()),
        };
        let file_path = resource_dir.join(file_name);
        fs::write(&file_path, content).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if resource == "scripts" {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file_path, fs::Permissions::from_mode(0o755))
                .map_err(|error| error.to_string())?;
        }
        created_files.push(file_path);
    }

    Ok(InitSkillResult {
        skill_name,
        skill_dir,
        created_files,
    })
}

pub fn validate_skill_directory(skill_dir: &Path) -> ValidateSkillResult {
    let resolved_dir = resolve_path(&expand_tilde(&skill_dir.to_string_lossy()));
    let skill_md = resolved_dir.join(SKILL_FILE_NAME);
    if !skill_md.exists() {
        return ValidateSkillResult {
            valid: false,
            message: "SKILL.md not found".to_string(),
            skill_dir: resolved_dir,
        };
    }
    let content = match fs::read_to_string(&skill_md) {
        Ok(content) => content,
        Err(error) => {
            return ValidateSkillResult {
                valid: false,
                message: format!("Failed to read SKILL.md: {error}"),
                skill_dir: resolved_dir,
            };
        }
    };
    let yaml_text = match extract_yaml_frontmatter(&content) {
        Ok(yaml_text) => yaml_text,
        Err(error) => {
            return ValidateSkillResult {
                valid: false,
                message: error,
                skill_dir: resolved_dir,
            };
        }
    };
    let parsed = match serde_yaml::from_str::<Yaml>(&yaml_text) {
        Ok(parsed) => parsed,
        Err(error) => {
            return ValidateSkillResult {
                valid: false,
                message: format!("Invalid YAML frontmatter: {error}"),
                skill_dir: resolved_dir,
            };
        }
    };
    let Some(map) = parsed.as_mapping() else {
        return ValidateSkillResult {
            valid: false,
            message: "Frontmatter must be a YAML dictionary".to_string(),
            skill_dir: resolved_dir,
        };
    };

    let name = yaml_string(map_get(map, "name")).trim().to_string();
    let description = yaml_string(map_get(map, "description")).trim().to_string();
    if name.is_empty() {
        return invalid_skill(resolved_dir, "Missing 'name' in frontmatter");
    }
    if description.is_empty() {
        return invalid_skill(resolved_dir, "Missing 'description' in frontmatter");
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return invalid_skill(
            resolved_dir,
            &format!(
                "Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)"
            ),
        );
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return invalid_skill(
            resolved_dir,
            &format!("Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"),
        );
    }
    if name.chars().count() > MAX_SKILL_NAME_LENGTH {
        return invalid_skill(
            resolved_dir,
            &format!(
                "Name is too long ({} characters). Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
                name.chars().count()
            ),
        );
    }
    if description.contains('<') || description.contains('>') {
        return invalid_skill(
            resolved_dir,
            "Description cannot contain angle brackets (< or >)",
        );
    }
    if description.chars().count() > MAX_DESCRIPTION_LENGTH {
        return invalid_skill(
            resolved_dir,
            &format!(
                "Description is too long ({} characters). Maximum is {MAX_DESCRIPTION_LENGTH} characters.",
                description.chars().count()
            ),
        );
    }
    match parse_frontmatter_schema(map) {
        Ok(_) => ValidateSkillResult {
            valid: true,
            message: "Skill is valid!".to_string(),
            skill_dir: resolved_dir,
        },
        Err(error) => invalid_skill(
            resolved_dir,
            &format!("Invalid SKILL.md frontmatter: {error}"),
        ),
    }
}

pub fn parse_skill_frontmatter(content: &str, fallback_name: &str) -> Option<SkillFrontmatter> {
    let mut map = parse_frontmatter(content);
    let name = yaml_string(map_get(&map, "name"));
    let name_is_nullish = matches!(map_get(&map, "name"), None | Some(Yaml::Null));
    let name = if name.is_empty() && name_is_nullish {
        fallback_name.to_string()
    } else {
        name.trim().to_string()
    };
    let description = yaml_string(map_get(&map, "description"));
    let description = if description.is_empty() && map_get(&map, "description").is_none() {
        "No description provided.".to_string()
    } else {
        description.trim().to_string()
    };
    map.insert(Yaml::String("name".to_string()), Yaml::String(name.clone()));
    map.insert(
        Yaml::String("description".to_string()),
        Yaml::String(description.clone()),
    );
    parse_frontmatter_schema(&map)
        .ok()
        .or_else(|| legacy_frontmatter(name, description))
}

fn parse_frontmatter_schema(map: &Mapping) -> Result<SkillFrontmatter, String> {
    let name = required_string(map_get(map, "name"), "name")?;
    if !is_valid_schema_name(&name) {
        return Err("name must match /^[a-z0-9][a-z0-9-]*$/".to_string());
    }
    let description = required_string(map_get(map, "description"), "description")?;
    if description.is_empty() {
        return Err("description must not be empty".to_string());
    }
    let version = yaml_coerced_i64(map_get(map, "version"), 1, Some(1), "version")?;
    let provides = yaml_string_array(map_get(map, "provides"), "provides")?.unwrap_or_default();
    let priority = yaml_coerced_i64(map_get(map, "priority"), 100, None, "priority")?;
    let platforms = match map_get(map, "platforms") {
        None => vec![
            "linux".to_string(),
            "macos".to_string(),
            "win32".to_string(),
        ],
        Some(value) => {
            let values =
                yaml_array(value).ok_or_else(|| "platforms must be an array".to_string())?;
            let mut platforms = Vec::with_capacity(values.len());
            for value in values {
                let platform = value
                    .as_str()
                    .ok_or_else(|| "platforms entries must be strings".to_string())?;
                if !matches!(platform, "linux" | "macos" | "win32") {
                    return Err("platforms contains an unsupported platform".to_string());
                }
                platforms.push(platform.to_string());
            }
            platforms
        }
    };
    let required_env = match map_get(map, "required_env") {
        None => Vec::new(),
        Some(value) => {
            let values =
                yaml_array(value).ok_or_else(|| "required_env must be an array".to_string())?;
            values
                .iter()
                .map(parse_required_env)
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let triggers = match map_get(map, "triggers") {
        None => SkillTriggers::default(),
        Some(value) => {
            let triggers = value
                .as_mapping()
                .ok_or_else(|| "triggers must be an object".to_string())?;
            SkillTriggers {
                keywords: yaml_string_array(map_get(triggers, "keywords"), "triggers.keywords")?
                    .unwrap_or_default(),
                intents: yaml_string_array(map_get(triggers, "intents"), "triggers.intents")?
                    .unwrap_or_default(),
            }
        }
    };
    let entrypoints = match map_get(map, "entrypoints") {
        None => Vec::new(),
        Some(value) => {
            let values =
                yaml_array(value).ok_or_else(|| "entrypoints must be an array".to_string())?;
            values
                .iter()
                .map(parse_entrypoint)
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let deprecated = match map_get(map, "deprecated") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "deprecated must be a boolean".to_string())?,
    };
    Ok(SkillFrontmatter {
        name,
        description,
        version,
        provides,
        priority,
        platforms,
        required_env,
        triggers,
        entrypoints,
        deprecated,
    })
}

fn parse_required_env(value: &Yaml) -> Result<SkillRequiredEnv, String> {
    let map = value
        .as_mapping()
        .ok_or_else(|| "required_env entries must be objects".to_string())?;
    let name = required_string(map_get(map, "name"), "required_env.name")?;
    let prompt = optional_string(map_get(map, "prompt"), "required_env.prompt")?;
    let secret = match map_get(map, "secret") {
        None => true,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "required_env.secret must be a boolean".to_string())?,
    };
    Ok(SkillRequiredEnv {
        name,
        prompt,
        secret,
    })
}

fn parse_entrypoint(value: &Yaml) -> Result<SkillEntrypoint, String> {
    let map = value
        .as_mapping()
        .ok_or_else(|| "entrypoints entries must be objects".to_string())?;
    let cmd = required_string(map_get(map, "cmd"), "entrypoints.cmd")?;
    let script = optional_string(map_get(map, "script"), "entrypoints.script")?;
    let args_template =
        yaml_string_array(map_get(map, "args_template"), "entrypoints.args_template")?
            .unwrap_or_default();
    let description = optional_string(map_get(map, "description"), "entrypoints.description")?;
    Ok(SkillEntrypoint {
        cmd,
        script,
        args_template,
        description,
    })
}

fn legacy_frontmatter(name: String, description: String) -> Option<SkillFrontmatter> {
    let is_valid = name
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');
    if !is_valid {
        return None;
    }
    let description = if description.is_empty() {
        "No description provided.".to_string()
    } else {
        description
    };
    Some(SkillFrontmatter {
        name,
        description,
        version: 1,
        provides: Vec::new(),
        priority: 100,
        platforms: vec![
            "linux".to_string(),
            "macos".to_string(),
            "win32".to_string(),
        ],
        required_env: Vec::new(),
        triggers: SkillTriggers::default(),
        entrypoints: Vec::new(),
        deprecated: false,
    })
}

fn collect_directory_skills(
    root: &Path,
    source: SkillSource,
    by_name: &mut BTreeMap<String, SkillMetadata>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }
        let directory_name = entry.file_name().to_string_lossy().to_string();
        let location = entry.path().join(SKILL_FILE_NAME);
        let Ok(content) = fs::read_to_string(&location) else {
            continue;
        };
        let Some(frontmatter) = parse_skill_frontmatter(&content, &directory_name) else {
            continue;
        };
        let metadata = to_metadata(frontmatter, location, source);
        by_name
            .entry(metadata.name.to_lowercase())
            .or_insert(metadata);
    }
}

fn collect_embedded_builtin_skills(by_name: &mut BTreeMap<String, SkillMetadata>) {
    let Some(frontmatter) = parse_skill_frontmatter(BUILTIN_SKILL_CREATOR, "skill-creator") else {
        return;
    };
    let location = PathBuf::from("builtin")
        .join("skill-creator")
        .join(SKILL_FILE_NAME);
    let metadata = to_metadata(frontmatter, location, SkillSource::Builtin);
    by_name
        .entry(metadata.name.to_lowercase())
        .or_insert(metadata);
}

fn to_metadata(
    frontmatter: SkillFrontmatter,
    location: PathBuf,
    source: SkillSource,
) -> SkillMetadata {
    SkillMetadata {
        name: frontmatter.name,
        description: frontmatter.description,
        location,
        source,
        version: frontmatter.version,
        provides: frontmatter.provides,
        priority: frontmatter.priority,
        platforms: frontmatter.platforms,
        required_env: frontmatter.required_env,
        triggers: frontmatter.triggers,
        entrypoints: frontmatter.entrypoints,
        deprecated: frontmatter.deprecated,
    }
}

fn apply_registry_overrides(skills: &mut Vec<SkillMetadata>, paths: &SkillPaths) {
    let Some(registry) = load_skill_registry(paths) else {
        return;
    };
    skills.retain_mut(|skill| {
        let Some(entry) = registry.skills.get(&skill.name.to_lowercase()) else {
            return !registry.whitelist;
        };
        if !entry.enabled {
            return false;
        }
        if !entry.provides.is_empty() {
            skill.provides = entry.provides.clone();
        }
        skill.priority = entry.priority;
        skill.deprecated = true;
        true
    });
}

fn load_skill_registry(paths: &SkillPaths) -> Option<SkillRegistry> {
    let metadata_path = paths
        .metadata_path
        .clone()
        .unwrap_or_else(|| paths.global_skills_dir.join(SKILLS_METADATA_FILE));
    let content = fs::read_to_string(metadata_path).ok()?;
    let parsed = serde_yaml::from_str::<Yaml>(&content).ok()?;
    let map = parsed.as_mapping()?;
    let whitelist = map_get(map, "mode")
        .and_then(Yaml::as_str)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("whitelist"));
    let mut skills = BTreeMap::new();
    if let Some(entries) = map_get(map, "skills").and_then(Yaml::as_mapping) {
        for (key, value) in entries {
            let name = yaml_string(Some(key)).trim().to_string();
            if name.is_empty() {
                continue;
            }
            let entry_map = value.as_mapping();
            let enabled = entry_map
                .and_then(|map| map_get(map, "enabled"))
                .and_then(Yaml::as_bool)
                .unwrap_or(true);
            let priority = entry_map
                .and_then(|map| map_get(map, "priority"))
                .map(yaml_number_like)
                .unwrap_or(0);
            let provides = entry_map
                .and_then(|map| map_get(map, "provides"))
                .and_then(Yaml::as_sequence)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            skills.insert(
                name.to_lowercase(),
                RegistryEntry {
                    provides,
                    priority,
                    enabled,
                },
            );
        }
    }
    Some(SkillRegistry { whitelist, skills })
}

fn parse_frontmatter(content: &str) -> Mapping {
    let lines = content.split('\n').collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return Mapping::new();
    }
    let Some(end) = (1..lines.len()).find(|index| lines[*index].trim() == "---") else {
        return Mapping::new();
    };
    let payload = lines[1..end].join("\n");
    let Ok(parsed) = serde_yaml::from_str::<Yaml>(&payload) else {
        return Mapping::new();
    };
    let Some(map) = parsed.as_mapping() else {
        return Mapping::new();
    };
    let mut normalized = Mapping::new();
    for (key, value) in map {
        let key = yaml_string(Some(key)).to_lowercase();
        normalized.insert(Yaml::String(key), value.clone());
    }
    normalized
}

fn extract_yaml_frontmatter(content: &str) -> Result<String, String> {
    if !content.starts_with("---") {
        return Err("No YAML frontmatter found".to_string());
    }
    let Some(end_index) = content[3..].find("\n---").map(|index| index + 3) else {
        return Err("Invalid frontmatter format".to_string());
    };
    let start = content.find('\n').map(|index| index + 1).unwrap_or(0);
    Ok(content[start..end_index].to_string())
}

fn map_get<'a>(map: &'a Mapping, key: &str) -> Option<&'a Yaml> {
    map.get(Yaml::String(key.to_string()))
}

fn yaml_array(value: &Yaml) -> Option<&Vec<Yaml>> {
    value.as_sequence()
}

fn yaml_string(value: Option<&Yaml>) -> String {
    match value {
        None | Some(Yaml::Null) => String::new(),
        Some(Yaml::String(value)) => value.clone(),
        Some(Yaml::Bool(value)) => value.to_string(),
        Some(Yaml::Number(value)) => value.to_string(),
        Some(Yaml::Sequence(values)) => values
            .iter()
            .map(|value| yaml_string(Some(value)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Yaml::Mapping(_)) => "[object Object]".to_string(),
        Some(Yaml::Tagged(value)) => yaml_string(Some(&value.value)),
    }
}

fn yaml_number_like(value: &Yaml) -> i64 {
    match value {
        Yaml::Number(value) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|value| value as i64))
            .unwrap_or(0),
        Yaml::String(value) => value.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn yaml_coerced_i64(
    value: Option<&Yaml>,
    default: i64,
    minimum: Option<i64>,
    field: &str,
) -> Result<i64, String> {
    let Some(value) = value else {
        return Ok(default);
    };
    let parsed =
        match value {
            Yaml::Number(value) => value.as_i64().or_else(|| {
                value.as_f64().and_then(|value| {
                    (value.is_finite() && value.fract() == 0.0).then_some(value as i64)
                })
            }),
            Yaml::String(value) => value.trim().parse::<f64>().ok().and_then(|value| {
                (value.is_finite() && value.fract() == 0.0).then_some(value as i64)
            }),
            Yaml::Bool(value) => Some(i64::from(*value)),
            _ => None,
        }
        .ok_or_else(|| format!("{field} must be an integer"))?;
    if minimum.is_some_and(|minimum| parsed < minimum) {
        return Err(format!("{field} must be at least {}", minimum.unwrap_or(0)));
    }
    Ok(parsed)
}

fn yaml_string_array(value: Option<&Yaml>, field: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let values = yaml_array(value).ok_or_else(|| format!("{field} must be an array"))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{field} entries must be strings"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn required_string(value: Option<&Yaml>, field: &str) -> Result<String, String> {
    value
        .and_then(Yaml::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{field} must be a string"))
}

fn optional_string(value: Option<&Yaml>, field: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| format!("{field} must be a string")),
    }
}

fn is_valid_schema_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn validate_new_skill_name(raw_name: &str) -> Result<String, String> {
    let skill_name = normalize_skill_name(raw_name);
    if skill_name.is_empty() {
        return Err("Skill name becomes empty after normalization.".to_string());
    }
    if skill_name.chars().count() > MAX_SKILL_NAME_LENGTH {
        return Err(format!(
            "Skill name is too long ({}). Maximum is {MAX_SKILL_NAME_LENGTH}.",
            skill_name.chars().count()
        ));
    }
    Ok(skill_name)
}

fn title_case_skill_name(skill_name: &str) -> String {
    skill_name
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn fill_template(template: &str, vars: &[(&str, &str)]) -> String {
    let mut result = template.to_string();
    for (key, value) in vars {
        result = result.replace(&format!("{{{key}}}"), value);
    }
    result
}

fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let link = fs::read_link(&source_path)?;
                std::os::unix::fs::symlink(link, &target_path)?;
            }
            #[cfg(not(unix))]
            {
                fs::copy(&source_path, &target_path)?;
            }
        } else if metadata.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)?;
            fs::set_permissions(&target_path, metadata.permissions())?;
        }
    }
    Ok(())
}

fn invalid_skill(skill_dir: PathBuf, message: &str) -> ValidateSkillResult {
    ValidateSkillResult {
        valid: false,
        message: message.to_string(),
        skill_dir,
    }
}

fn resolve_codex_home_dir() -> PathBuf {
    let raw = std::env::var("CODEX_HOME").unwrap_or_default();
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        return resolve_path(&expand_tilde(trimmed));
    }
    home_dir().join(".codex")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| resolve_path(&expand_tilde(&value)))
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn expand_tilde(value: &str) -> String {
    if value == "~" {
        return home_dir().to_string_lossy().to_string();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest).to_string_lossy().to_string();
    }
    if let Some(rest) = value.strip_prefix("~\\") {
        return home_dir().join(rest).to_string_lossy().to_string();
    }
    value.to_string()
}

fn resolve_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_paths(directory: &Path) -> SkillPaths {
        SkillPaths {
            global_skills_dir: directory.join("codex").join("skills"),
            legacy_state_dir: None,
            metadata_path: None,
            builtin_skills_root: None,
            migrate_legacy: false,
        }
    }

    #[test]
    fn parses_valid_and_legacy_skill_frontmatter() {
        let valid = parse_skill_frontmatter(
            "---\nname: demo-skill\ndescription: Demo\n---\n# Demo\n",
            "fallback",
        )
        .expect("valid");
        assert_eq!(valid.name, "demo-skill");
        assert_eq!(valid.description, "Demo");
        assert_eq!(valid.priority, 100);

        let legacy = parse_skill_frontmatter(
            "---\nname: legacy-skill\ndescription: Legacy body\n---\n",
            "fallback",
        )
        .expect("legacy frontmatter");
        assert_eq!(legacy.name, "legacy-skill");
        assert_eq!(legacy.version, 1);

        let fallback = parse_skill_frontmatter("---\ndescription: No name\n---\n", "fallback")
            .expect("name fallback");
        assert_eq!(fallback.name, "fallback");

        assert!(
            parse_skill_frontmatter(
                "---\nname: Legacy Skill\ndescription: Legacy body\n---\n",
                "fallback",
            )
            .is_none()
        );
    }

    #[test]
    fn renders_and_loads_global_skills_with_registry_overrides() {
        let directory = tempdir().expect("tempdir");
        let paths = test_paths(directory.path());
        let skill_dir = paths.global_skills_dir.join("demo-skill");
        fs::create_dir_all(&skill_dir).expect("skill dir");
        fs::write(
            skill_dir.join(SKILL_FILE_NAME),
            "---\nname: demo-skill\ndescription: Demo skill\npriority: 10\n---\n\nBody\n",
        )
        .expect("skill");
        fs::create_dir_all(&paths.global_skills_dir).expect("global");
        fs::write(
            paths.global_skills_dir.join(SKILLS_METADATA_FILE),
            "mode: overlay\nskills:\n  demo-skill:\n    priority: 5\n",
        )
        .expect("metadata");

        let skills = discover_skills(&paths);
        let demo = skills
            .iter()
            .find(|skill| skill.name == "demo-skill")
            .expect("demo");
        assert_eq!(demo.priority, 5);
        assert!(demo.deprecated);
        assert!(render_skill_list(&skills).contains("demo-skill"));
        assert_eq!(
            load_skill_body("DEMO-SKILL", &paths).unwrap(),
            "---\nname: demo-skill\ndescription: Demo skill\npriority: 10\n---\n\nBody\n"
        );
    }

    #[test]
    fn renders_prompt_skill_blocks() {
        assert_eq!(render_compact_skills(&[]), "");
        assert_eq!(
            render_skill_meta_instruction(&[]),
            [
                "<skill_system>",
                "当前没有可用的 skill。",
                "当你需要扩展能力时，可以使用 /ads.skill.init <name> 创建新的 skill。",
                "skill 存放位置：全局 $CODEX_HOME/skills/<name>/SKILL.md（默认 ~/.codex/skills）。",
                "</skill_system>",
            ]
            .join("\n")
        );

        let skill = SkillMetadata {
            name: "demo-skill".to_string(),
            description: "Demo description".to_string(),
            location: PathBuf::from("/tmp/demo-skill/SKILL.md"),
            source: SkillSource::Global,
            version: 1,
            provides: Vec::new(),
            priority: 100,
            platforms: vec!["linux".to_string()],
            required_env: Vec::new(),
            triggers: SkillTriggers::default(),
            entrypoints: Vec::new(),
            deprecated: false,
        };
        assert_eq!(
            render_compact_skills(std::slice::from_ref(&skill)),
            [
                "<available_skills>",
                "  <skill name=\"demo-skill\" source=\"global\">",
                "    Demo description",
                "  </skill>",
                "</available_skills>",
            ]
            .join("\n")
        );
        let instruction = render_skill_meta_instruction(std::slice::from_ref(&skill));
        assert!(instruction.contains("当前有 1 个可用 skill。"));
        assert!(instruction.contains("ADS 会按用户请求自动加载匹配 skill 的完整内容。"));
    }

    #[test]
    fn init_and_validate_skill_round_trip() {
        let directory = tempdir().expect("tempdir");
        let paths = test_paths(directory.path());
        let created = init_skill(
            InitSkillParams {
                raw_name: "My Skill".to_string(),
                resources: parse_resource_list(Some("scripts,references")).expect("resources"),
                include_examples: true,
            },
            &paths,
        )
        .expect("create");
        assert_eq!(created.skill_name, "my-skill");
        assert!(
            created
                .skill_dir
                .join("scripts")
                .join("example.py")
                .is_file()
        );
        let validated = validate_skill_directory(&created.skill_dir);
        assert!(validated.valid, "{}", validated.message);
    }

    #[test]
    fn validates_missing_and_invalid_frontmatter() {
        let directory = tempdir().expect("tempdir");
        let missing = validate_skill_directory(&directory.path().join("missing"));
        assert_eq!(missing.message, "SKILL.md not found");

        let skill_dir = directory.path().join("invalid");
        fs::create_dir_all(&skill_dir).expect("skill");
        fs::write(skill_dir.join(SKILL_FILE_NAME), "# no frontmatter\n").expect("skill");
        let invalid = validate_skill_directory(&skill_dir);
        assert_eq!(invalid.message, "No YAML frontmatter found");
    }

    #[test]
    fn migrates_legacy_skills_without_overwriting() {
        let directory = tempdir().expect("tempdir");
        let state = directory.path().join("state");
        let global = directory.path().join("global");
        let legacy = state.join(".agent").join("skills").join("old-skill");
        fs::create_dir_all(legacy.join("scripts")).expect("legacy");
        fs::write(
            legacy.join(SKILL_FILE_NAME),
            "---\nname: old-skill\ndescription: Old\n---\n",
        )
        .expect("skill");
        fs::write(legacy.join("scripts").join("run.sh"), "echo old").expect("script");

        let result = migrate_legacy_state_skills(&state, &global);
        assert_eq!(result.migrated, vec!["old-skill"]);
        assert!(
            global
                .join("old-skill")
                .join("scripts")
                .join("run.sh")
                .is_file()
        );
        assert!(legacy.join(SKILL_FILE_NAME).is_file());

        let second = migrate_legacy_state_skills(&state, &global);
        assert_eq!(second.skipped, vec!["old-skill"]);
    }
}
