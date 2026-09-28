import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

import { boundRelatedContexts } from "./contextBudget.js";
import { shouldExcludeFileFromDiff } from "./diffFilter.js";
import type { ReviewContextOmission, ReviewRelatedContext } from "./types.js";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_GIT_READS = 512;

function moduleCandidates(file: string, specifier: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (resolved.startsWith("../") || resolved.includes("\\") || resolved.includes("\0")) return [];
  if (/\.mjs$/.test(resolved)) return [resolved.replace(/\.mjs$/, ".mts"), resolved.replace(/\.mjs$/, ".d.mts"), resolved];
  if (/\.cjs$/.test(resolved)) return [resolved.replace(/\.cjs$/, ".cts"), resolved.replace(/\.cjs$/, ".d.cts"), resolved];
  if (/\.jsx?$/.test(resolved)) {
    const extensions = resolved.endsWith(".jsx") ? [".tsx", ".ts", ".d.ts", ".jsx", ".js"] : [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
    return extensions.map((extension) => resolved.replace(/\.jsx?$/, extension));
  }
  if (SOURCE_EXTENSION.test(resolved)) return [resolved];
  if (path.posix.extname(resolved)) return [];
  return [".ts", ".tsx", ".d.ts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.d.ts", "/index.js"]
    .map((suffix) => `${resolved}${suffix}`);
}

function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names = clause.name ? ["default"] : [];
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push("*");
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    names.push(...clause.namedBindings.elements.map((element) => (element.propertyName ?? element.name).text));
  }
  return names;
}

function declarationNames(node: ts.Statement): string[] {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
    || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
    const names = node.name ? [node.name.text] : [];
    if (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.push("default");
    return names;
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  return [];
}

function selectDeclarations(file: string, content: string, names: Set<string>): { content: string; missing: string[] } {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Statement[]>();
  const exports = new Map<string, string>();
  const localExports: ts.Statement[] = [];
  for (const statement of source.statements) {
    const declared = declarationNames(statement);
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    for (const name of declared) {
      declarations.set(name, [...(declarations.get(name) ?? []), statement]);
      if (exported && (!isDefault || name === "default")) exports.set(name, name);
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exports.set(element.name.text, (element.propertyName ?? element.name).text);
      }
      localExports.push(statement);
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      exports.set("default", statement.expression.text);
      localExports.push(statement);
    }
  }
  const selected = new Set<ts.Statement>();
  const pending: string[] = [];
  const requested = names.has("*") ? [...exports.keys()] : [...names];
  const missing = requested.filter((name) => !declarations.has(exports.get(name) ?? ""));
  for (const name of requested) pending.push(exports.get(name) ?? "");
  while (pending.length) {
    const name = pending.pop()!;
    for (const declaration of declarations.get(name) ?? []) {
      if (selected.has(declaration)) continue;
      selected.add(declaration);
      // Include same-file supporting types (including cycles), but never read
      // another module while expanding a declaration's contract.
      function visit(node: ts.Node): void {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) pending.push(node.typeName.text);
        if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) pending.push(node.expression.text);
        if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) pending.push(node.exprName.text);
        ts.forEachChild(node, visit);
      }
      ts.forEachChild(declaration, visit);
    }
  }
  if (names.has("*") && (!selected.size || source.statements.some((node) => ts.isExportDeclaration(node) && node.moduleSpecifier))) {
    missing.push("* (namespace may contain re-exports)");
  }
  // Keep imports as provenance for referenced names, without recursively reading
  // their modules or pretending that the resulting excerpt is self-contained.
  return {
    content: selected.size ? source.statements
      .filter((node) => selected.has(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || localExports.includes(node))
      .map((node) => node.getText(source)).join("\n\n") : "",
    missing,
  };
}

/** Read only direct local declarations from the exact reviewed commit. */
export function extractRelatedContexts(repoPath: string, baseCommit: string, headCommit: string): {
  relatedContexts: ReviewRelatedContext[];
  relatedContextOmissions: ReviewContextOmission[];
} {
  const contexts: ReviewRelatedContext[] = [];
  const omissions: ReviewContextOmission[] = [];
  const deadline = Date.now() + 10_000;
  let gitReads = 0;
  function git(args: string[]): string {
    if (++gitReads > MAX_GIT_READS || Date.now() >= deadline) throw new Error("Context extraction read/time budget exceeded.");
    const result = spawnSync("git", ["--literal-pathspecs", ...args], {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: MAX_BLOB_BYTES,
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (result.status !== 0) throw new Error("Committed context could not be read within the source-size/time budget.");
    return result.stdout;
  }
  const cache = new Map<string, { content: string | null } | null>();
  const dependencies = new Map<string, Set<string>>();
  function readSource(file: string): { content: string | null } | null {
    if (cache.has(file)) return cache.get(file) ?? null;
    const entry = git(["ls-tree", "-l", "-z", headCommit, "--", file]);
    const match = /^(\d+) blob ([0-9a-f]+)\s+(\d+)\t/.exec(entry);
    if (!match) {
      cache.set(file, null);
      return null;
    }
    // An existing but unreadable module must shadow lower-priority candidates;
    // falling through would supply a contract from a different module.
    let reason: string | undefined;
    if (match[1] !== "100644" && match[1] !== "100755") reason = "Committed source is not a regular file; symlinks are not followed.";
    else if (shouldExcludeFileFromDiff(file) || file.split("/").includes("node_modules")) reason = "Committed source is excluded from review context.";
    else if (Number(match[3]) > MAX_BLOB_BYTES) reason = "Committed source exceeds the 256 KiB extraction limit.";
    if (reason) omissions.push({ file, reason });
    const source = { content: reason ? null : git(["cat-file", "blob", match[2]!]) };
    cache.set(file, source);
    return source;
  }

  try {
    if (![baseCommit, headCommit].every((commit) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit))) {
      throw new Error("Context extraction requires immutable commit IDs.");
    }
    const changed = git(["diff", "--name-only", "-z", "--diff-filter=AMR", `${baseCommit}...${headCommit}`, "--"])
      .split("\0").filter((file) => SOURCE_EXTENSION.test(file)).sort();
    for (const file of changed) {
      const content = readSource(file)?.content;
      if (content == null) continue;
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const names = importedNames(statement);
        const specifier = statement.moduleSpecifier.text;
        if (!names.length || (!specifier.startsWith(".") && !specifier.startsWith("/"))) continue;
        const candidate = moduleCandidates(file, specifier).find((candidate) => readSource(candidate) !== null);
        if (!candidate) {
          omissions.push({ file, reason: `Local import ${JSON.stringify(specifier)} could not be resolved to a committed source file.` });
          continue;
        }
        if (cache.get(candidate)?.content == null) continue;
        const wanted = dependencies.get(candidate) ?? new Set<string>();
        names.forEach((name) => wanted.add(name));
        dependencies.set(candidate, wanted);
      }
    }
  } catch (error) {
    omissions.push({ file: "[context extraction]", reason: error instanceof Error ? error.message : "Context extraction failed." });
  }
  for (const [file, names] of [...dependencies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (Date.now() >= deadline) {
      omissions.push({ file: "[context extraction]", reason: "Remaining declarations omitted because the extraction time budget was exceeded." });
      break;
    }
    try {
      const selected = selectDeclarations(file, cache.get(file)!.content!, names);
      if (selected.content) contexts.push({ file, content: selected.content });
      if (selected.missing.length) omissions.push({
        file, reason: `Declarations not extracted (possibly re-exported): ${selected.missing.join(", ")}. Transitive modules are not expanded.`,
      });
    } catch {
      omissions.push({ file, reason: "Committed declarations could not be parsed safely." });
    }
  }
  return boundRelatedContexts(contexts, omissions);
}
