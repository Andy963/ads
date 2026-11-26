use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPatternKind, Declaration, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    Statement, TSTypeName, TSTypeQueryExprName,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use regex::Regex;
use serde::Serialize;
use tokio::process::Command;

use crate::context_budget::bound_related_contexts;
use crate::diff_filter::should_exclude_file_from_diff;
use crate::types::{ReviewContextOmission, ReviewRelatedContext};

const MAX_BLOB_BYTES: usize = 256 * 1024;
const MAX_GIT_READS: usize = 512;
const EXTRACTION_BUDGET: Duration = Duration::from_secs(10);
const READ_ERROR: &str = "Committed context could not be read within the source-size/time budget.";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedContextExtraction {
    pub related_contexts: Vec<ReviewRelatedContext>,
    pub related_context_omissions: Vec<ReviewContextOmission>,
}

#[derive(Debug, Clone)]
struct SourceFile {
    content: Option<String>,
}

struct GitReader<'a> {
    repo_path: &'a Path,
    deadline: tokio::time::Instant,
    reads: usize,
}

impl<'a> GitReader<'a> {
    fn new(repo_path: &'a Path) -> Self {
        Self {
            repo_path,
            deadline: tokio::time::Instant::now() + EXTRACTION_BUDGET,
            reads: 0,
        }
    }

    fn budget_exceeded(&mut self) -> bool {
        self.reads += 1;
        self.reads > MAX_GIT_READS || tokio::time::Instant::now() >= self.deadline
    }

    async fn git(&mut self, args: &[String]) -> Result<Vec<u8>, String> {
        if self.budget_exceeded() {
            return Err("Context extraction read/time budget exceeded.".to_string());
        }
        let remaining = self
            .deadline
            .saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Context extraction read/time budget exceeded.".to_string());
        }
        let mut command = Command::new("git");
        command.arg("--literal-pathspecs");
        command.args(args);
        command
            .current_dir(self.repo_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(remaining, command.output())
            .await
            .map_err(|_| READ_ERROR.to_string())?
            .map_err(|_| READ_ERROR.to_string())?;
        if !output.status.success() || output.stdout.len() > MAX_BLOB_BYTES {
            return Err(READ_ERROR.to_string());
        }
        Ok(output.stdout)
    }
}

pub async fn extract_related_contexts(
    repo_path: &Path,
    base_commit: &str,
    head_commit: &str,
) -> RelatedContextExtraction {
    let mut reader = GitReader::new(repo_path);
    let mut contexts = Vec::new();
    let mut omissions = Vec::new();
    let mut cache = HashMap::<String, Option<SourceFile>>::new();
    let mut dependencies = BTreeMap::<String, HashSet<String>>::new();

    let result: Result<(), String> = async {
        if !is_commit_id(base_commit) || !is_commit_id(head_commit) {
            return Err("Context extraction requires immutable commit IDs.".to_string());
        }
        let changed = reader
            .git(&[
                "diff".to_string(),
                "--name-only".to_string(),
                "-z".to_string(),
                "--diff-filter=AMR".to_string(),
                format!("{base_commit}...{head_commit}"),
                "--".to_string(),
            ])
            .await?;
        let mut changed = String::from_utf8_lossy(&changed)
            .split('\0')
            .filter(|file| source_extension().is_match(file))
            .map(str::to_string)
            .collect::<Vec<_>>();
        changed.sort();
        for file in changed {
            let Some(source) =
                read_source(&mut reader, &mut cache, &mut omissions, head_commit, &file).await
            else {
                continue;
            };
            let Some(content) = source.content.as_deref() else {
                continue;
            };
            for (specifier, names) in local_imports(&file, content) {
                let mut resolved = None;
                for candidate in module_candidates(&file, &specifier) {
                    if read_source(
                        &mut reader,
                        &mut cache,
                        &mut omissions,
                        head_commit,
                        &candidate,
                    )
                    .await
                    .is_some()
                    {
                        resolved = Some(candidate);
                        break;
                    }
                }
                let Some(candidate) = resolved else {
                    omissions.push(ReviewContextOmission {
                        file: file.clone(),
                        reason: format!(
                            "Local import {} could not be resolved to a committed source file.",
                            serde_json::to_string(&specifier).unwrap_or_default()
                        ),
                    });
                    continue;
                };
                if cache
                    .get(&candidate)
                    .and_then(Option::as_ref)
                    .and_then(|source| source.content.as_ref())
                    .is_none()
                {
                    continue;
                }
                dependencies.entry(candidate).or_default().extend(names);
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        omissions.push(ReviewContextOmission {
            file: "[context extraction]".to_string(),
            reason: error,
        });
    }

    for (file, names) in dependencies {
        if tokio::time::Instant::now() >= reader.deadline {
            omissions.push(ReviewContextOmission {
                file: "[context extraction]".to_string(),
                reason: "Remaining declarations omitted because the extraction time budget was exceeded."
                    .to_string(),
            });
            break;
        }
        let Some(content) = cache
            .get(&file)
            .and_then(Option::as_ref)
            .and_then(|source| source.content.as_deref())
        else {
            continue;
        };
        match select_declarations(&file, content, &names) {
            Ok(selected) => {
                if !selected.content.is_empty() {
                    contexts.push(ReviewRelatedContext {
                        file: file.clone(),
                        content: selected.content,
                    });
                }
                if !selected.missing.is_empty() {
                    omissions.push(ReviewContextOmission {
                        file,
                        reason: format!(
                            "Declarations not extracted (possibly re-exported): {}. Transitive modules are not expanded.",
                            selected.missing.join(", ")
                        ),
                    });
                }
            }
            Err(_) => omissions.push(ReviewContextOmission {
                file,
                reason: "Committed declarations could not be parsed safely.".to_string(),
            }),
        }
    }

    let (related_contexts, related_context_omissions) =
        bound_related_contexts(&contexts, &omissions);
    RelatedContextExtraction {
        related_contexts,
        related_context_omissions,
    }
}

async fn read_source(
    reader: &mut GitReader<'_>,
    cache: &mut HashMap<String, Option<SourceFile>>,
    omissions: &mut Vec<ReviewContextOmission>,
    head_commit: &str,
    file: &str,
) -> Option<SourceFile> {
    if let Some(cached) = cache.get(file) {
        return cached.clone();
    }
    let entry = reader
        .git(&[
            "ls-tree".to_string(),
            "-l".to_string(),
            "-z".to_string(),
            head_commit.to_string(),
            "--".to_string(),
            file.to_string(),
        ])
        .await
        .ok()?;
    let entry = String::from_utf8_lossy(&entry);
    let Some(capture) = ls_tree_pattern().captures(&entry) else {
        cache.insert(file.to_string(), None);
        return None;
    };
    let mode = capture.get(1).map(|value| value.as_str()).unwrap_or("");
    let object = capture.get(2).map(|value| value.as_str()).unwrap_or("");
    let size = capture
        .get(3)
        .and_then(|value| value.as_str().parse::<usize>().ok())
        .unwrap_or(usize::MAX);
    let reason = if mode != "100644" && mode != "100755" {
        Some("Committed source is not a regular file; symlinks are not followed.")
    } else if should_exclude_file_from_diff(file)
        || file.split('/').any(|part| part == "node_modules")
    {
        Some("Committed source is excluded from review context.")
    } else if size > MAX_BLOB_BYTES {
        Some("Committed source exceeds the 256 KiB extraction limit.")
    } else {
        None
    };
    if let Some(reason) = reason {
        omissions.push(ReviewContextOmission {
            file: file.to_string(),
            reason: reason.to_string(),
        });
    }
    let source = if reason.is_some() {
        SourceFile { content: None }
    } else {
        let content = reader
            .git(&[
                "cat-file".to_string(),
                "blob".to_string(),
                object.to_string(),
            ])
            .await
            .ok()?;
        SourceFile {
            content: Some(String::from_utf8_lossy(&content).to_string()),
        }
    };
    cache.insert(file.to_string(), Some(source.clone()));
    Some(source)
}

fn local_imports(file: &str, content: &str) -> Vec<(String, Vec<String>)> {
    let allocator = Allocator::default();
    let Ok(source_type) = SourceType::from_path(Path::new(file)) else {
        return Vec::new();
    };
    let parsed = Parser::new(&allocator, content, source_type).parse();
    let mut imports = Vec::new();
    for statement in &parsed.program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let specifier = import.source.value.to_string();
        if !specifier.starts_with('.') {
            continue;
        }
        let mut names = Vec::new();
        for specifier in import.specifiers.iter().flatten() {
            match specifier {
                ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                    names.push("default".to_string());
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                    names.push("*".to_string());
                }
                ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                    names.push(specifier.imported.name().to_string());
                }
            }
        }
        if !names.is_empty() {
            imports.push((specifier, names));
        }
    }
    imports
}

#[derive(Debug)]
struct SelectedDeclarations {
    content: String,
    missing: Vec<String>,
}

fn select_declarations(
    file: &str,
    content: &str,
    names: &HashSet<String>,
) -> Result<SelectedDeclarations, ()> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(file)).map_err(|_| ())?;
    let parsed = Parser::new(&allocator, content, source_type).parse();
    if parsed.panicked {
        return Err(());
    }
    let statements = &parsed.program.body;
    let mut declarations = HashMap::<String, Vec<usize>>::new();
    let mut exports = HashMap::<String, String>::new();
    let mut local_exports = HashSet::new();
    let mut imports = HashSet::new();
    let mut reexports = false;

    for (index, statement) in statements.iter().enumerate() {
        match statement {
            Statement::ImportDeclaration(_) => {
                imports.insert(index);
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = export.declaration.as_ref() {
                    for name in declaration_names(declaration) {
                        declarations.entry(name.clone()).or_default().push(index);
                        exports.insert(name.clone(), name);
                    }
                } else if export.source.is_none() {
                    for specifier in &export.specifiers {
                        exports.insert(
                            specifier.exported.name().to_string(),
                            specifier.local.name().to_string(),
                        );
                    }
                    local_exports.insert(index);
                } else {
                    reexports = true;
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    if let Some(id) = function.id.as_ref() {
                        declarations
                            .entry(id.name.to_string())
                            .or_default()
                            .push(index);
                        exports.insert("default".to_string(), id.name.to_string());
                    }
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(id) = class.id.as_ref() {
                        declarations
                            .entry(id.name.to_string())
                            .or_default()
                            .push(index);
                        exports.insert("default".to_string(), id.name.to_string());
                    }
                }
                ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
                    declarations
                        .entry(interface.id.name.to_string())
                        .or_default()
                        .push(index);
                    exports.insert("default".to_string(), interface.id.name.to_string());
                }
                ExportDefaultDeclarationKind::Identifier(identifier) => {
                    exports.insert("default".to_string(), identifier.name.to_string());
                    local_exports.insert(index);
                }
                _ => {}
            },
            Statement::ExportAllDeclaration(_) => reexports = true,
            _ => {
                if let Some(declaration) = statement.as_declaration() {
                    if matches!(declaration, Declaration::TSImportEqualsDeclaration(_)) {
                        imports.insert(index);
                    }
                    for name in declaration_names(declaration) {
                        declarations.entry(name).or_default().push(index);
                    }
                }
            }
        }
    }

    let requested = if names.contains("*") {
        exports.keys().cloned().collect::<Vec<_>>()
    } else {
        let mut requested = names.iter().cloned().collect::<Vec<_>>();
        requested.sort();
        requested
    };
    let mut pending = Vec::new();
    let mut missing = Vec::new();
    for name in requested {
        let target = exports.get(&name).cloned().unwrap_or_default();
        if !declarations.contains_key(&target) {
            missing.push(name.clone());
        }
        pending.push(target);
    }
    let mut selected = HashSet::new();
    let mut seen = HashSet::new();
    while let Some(name) = pending.pop() {
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        for index in declarations.get(&name).cloned().unwrap_or_default() {
            if !selected.insert(index) {
                continue;
            }
            let mut collector = ReferenceCollector::default();
            collector.visit_statement(&statements[index]);
            pending.extend(collector.names);
        }
    }
    if names.contains("*") && (selected.is_empty() || reexports) {
        missing.push("* (namespace may contain re-exports)".to_string());
    }
    missing.sort();
    missing.dedup();
    let mut selected_indexes = selected;
    selected_indexes.extend(imports);
    selected_indexes.extend(local_exports);
    let mut indexes = selected_indexes.into_iter().collect::<Vec<_>>();
    indexes.sort();
    let selected_content = indexes
        .into_iter()
        .map(|index| {
            let span = statements[index].span();
            content[span.start as usize..span.end as usize].to_string()
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(SelectedDeclarations {
        content: selected_content,
        missing,
    })
}

fn declaration_names(declaration: &Declaration<'_>) -> Vec<String> {
    match declaration {
        Declaration::VariableDeclaration(declaration) => declaration
            .declarations
            .iter()
            .filter_map(|declarator| match &declarator.id.kind {
                BindingPatternKind::BindingIdentifier(identifier) => {
                    Some(identifier.name.to_string())
                }
                _ => None,
            })
            .collect(),
        Declaration::FunctionDeclaration(function) => function
            .id
            .as_ref()
            .map(|identifier| vec![identifier.name.to_string()])
            .unwrap_or_default(),
        Declaration::ClassDeclaration(class) => class
            .id
            .as_ref()
            .map(|identifier| vec![identifier.name.to_string()])
            .unwrap_or_default(),
        Declaration::TSTypeAliasDeclaration(declaration) => {
            vec![declaration.id.name.to_string()]
        }
        Declaration::TSInterfaceDeclaration(declaration) => {
            vec![declaration.id.name.to_string()]
        }
        Declaration::TSEnumDeclaration(declaration) => vec![declaration.id.name.to_string()],
        _ => Vec::new(),
    }
}

#[derive(Default)]
struct ReferenceCollector {
    names: Vec<String>,
}

impl<'a> Visit<'a> for ReferenceCollector {
    fn visit_ts_type_reference(&mut self, reference: &oxc_ast::ast::TSTypeReference<'a>) {
        if let TSTypeName::IdentifierReference(identifier) = &reference.type_name {
            self.names.push(identifier.name.to_string());
        }
        walk::walk_ts_type_reference(self, reference);
    }

    fn visit_ts_type_query(&mut self, query: &oxc_ast::ast::TSTypeQuery<'a>) {
        if let TSTypeQueryExprName::IdentifierReference(identifier) = &query.expr_name {
            self.names.push(identifier.name.to_string());
        }
        walk::walk_ts_type_query(self, query);
    }

    fn visit_ts_interface_heritage(&mut self, heritage: &oxc_ast::ast::TSInterfaceHeritage<'a>) {
        if let oxc_ast::ast::Expression::Identifier(identifier) = &heritage.expression {
            self.names.push(identifier.name.to_string());
        }
        walk::walk_ts_interface_heritage(self, heritage);
    }

    fn visit_ts_class_implements(&mut self, implements: &oxc_ast::ast::TSClassImplements<'a>) {
        if let TSTypeName::IdentifierReference(identifier) = &implements.expression {
            self.names.push(identifier.name.to_string());
        }
        walk::walk_ts_class_implements(self, implements);
    }
}

fn module_candidates(file: &str, specifier: &str) -> Vec<String> {
    if !(specifier.starts_with("./") || specifier.starts_with("../")) {
        return Vec::new();
    }
    let directory = file
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let joined = if directory.is_empty() {
        specifier.to_string()
    } else {
        format!("{directory}/{specifier}")
    };
    let Some(resolved) = normalize_posix(&joined) else {
        return Vec::new();
    };
    if resolved.starts_with("../") || resolved.contains('\\') || resolved.contains('\0') {
        return Vec::new();
    }
    if resolved.ends_with(".mjs") {
        return vec![
            resolved.replace(".mjs", ".mts"),
            resolved.replace(".mjs", ".d.mts"),
            resolved,
        ];
    }
    if resolved.ends_with(".cjs") {
        return vec![
            resolved.replace(".cjs", ".cts"),
            resolved.replace(".cjs", ".d.cts"),
            resolved,
        ];
    }
    if resolved.ends_with(".jsx") || resolved.ends_with(".js") {
        let extensions = if resolved.ends_with(".jsx") {
            [".tsx", ".ts", ".d.ts", ".jsx", ".js"]
        } else {
            [".ts", ".tsx", ".d.ts", ".js", ".jsx"]
        };
        let stem = resolved
            .strip_suffix(".jsx")
            .or_else(|| resolved.strip_suffix(".js"))
            .unwrap_or(&resolved);
        return extensions
            .into_iter()
            .map(|extension| format!("{stem}{extension}"))
            .collect();
    }
    if source_extension().is_match(&resolved) {
        return vec![resolved];
    }
    if posix_extension(&resolved).is_some() {
        return Vec::new();
    }
    [
        ".ts",
        ".tsx",
        ".d.ts",
        ".js",
        ".jsx",
        "/index.ts",
        "/index.tsx",
        "/index.d.ts",
        "/index.js",
    ]
    .into_iter()
    .map(|suffix| format!("{resolved}{suffix}"))
    .collect()
}

fn normalize_posix(value: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

fn posix_extension(value: &str) -> Option<&str> {
    let basename = value.rsplit('/').next().unwrap_or(value);
    let (stem, extension) = basename.rsplit_once('.')?;
    (!stem.is_empty()).then_some(extension)
}

fn source_extension() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\.(?:[cm]?[jt]s|[jt]sx)$").expect("source extension regex"))
}

fn ls_tree_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^(\d+) blob ([0-9a-f]+)\s+(\d+)\t").expect("ls-tree regex"))
}

fn is_commit_id(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_module_candidates_like_typescript() {
        assert_eq!(
            module_candidates("src/a.ts", "./b.js"),
            vec![
                "src/b.ts",
                "src/b.tsx",
                "src/b.d.ts",
                "src/b.js",
                "src/b.jsx"
            ]
        );
        assert_eq!(
            module_candidates("src/a.ts", "../types"),
            vec![
                "types.ts",
                "types.tsx",
                "types.d.ts",
                "types.js",
                "types.jsx",
                "types/index.ts",
                "types/index.tsx",
                "types/index.d.ts",
                "types/index.js"
            ]
        );
        assert!(module_candidates("a.ts", "../../outside").is_empty());
        assert!(module_candidates("a.ts", "package").is_empty());
    }

    #[test]
    fn selects_exported_declarations_and_same_file_type_dependencies() {
        let content = r#"
import { External } from "./external";

export interface Public extends Base {
  value: Alias;
}

interface Base {
  id: string;
}

type Alias = External | number;

const unused = 1;
export const value = 2;
"#;
        let selected = select_declarations(
            "src/a.ts",
            content,
            &HashSet::from(["Public".to_string(), "value".to_string()]),
        )
        .expect("selected");
        assert!(selected.content.contains("import { External }"));
        assert!(selected.content.contains("export interface Public"));
        assert!(selected.content.contains("interface Base"));
        assert!(selected.content.contains("type Alias"));
        assert!(selected.content.contains("export const value"));
        assert!(!selected.content.contains("const unused"));
        assert!(selected.missing.is_empty());
    }
}
