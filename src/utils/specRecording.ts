import path from "node:path";
import { promises as fs } from "node:fs";

import yaml from "yaml";

import { createWorkflowFromTemplate } from "../workflow/templateService.js";

export interface SpecWriteResult {
  specRef: string;
  absoluteDir: string;
  title: string;
  writtenFiles: string[];
  created: boolean;
}

export interface SpecProcessingResult {
  cleanedText: string;
  results: SpecWriteResult[];
  warnings: string[];
  finalText: string;
}

interface ExtractedSpecBlock {
  raw: string;
  yamlText: string;
}

interface SpecBlockRecord {
  title?: unknown;
  template_id?: unknown;
  templateId?: unknown;
  template?: unknown;
  description?: unknown;
  specRef?: unknown;
  spec_ref?: unknown;
  files?: unknown;
  requirements?: unknown;
  requirement?: unknown;
  design?: unknown;
  implementation?: unknown;
}

function extractSpecBlocks(text: string): { blocks: ExtractedSpecBlock[]; cleanedText: string } {
  const blocks: ExtractedSpecBlock[] = [];
  const regex = /<<<spec[ \t]*\r?\n([\s\S]*?)\r?\n>>>/g;

  let cursor = 0;
  let cleaned = "";
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    cleaned += text.slice(cursor, match.index);
    cursor = regex.lastIndex;
    blocks.push({ raw: match[0], yamlText: match[1] });
  }
  cleaned += text.slice(cursor);

  return { blocks, cleanedText: cleaned };
}

function toNonEmptyString(value: unknown): string | null {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function normalizeSpecRef(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  const noPrefix = trimmed.replace(/^(?:\.\/)+/, "");
  return noPrefix.replace(/\/+$/, "");
}

function isSafeSpecDir(workspaceRoot: string, absoluteDir: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedDir = path.resolve(absoluteDir);
  const specsBase = path.resolve(resolvedRoot, "docs", "spec");
  if (resolvedDir === specsBase) return true;
  return resolvedDir.startsWith(specsBase + path.sep);
}

function normalizeSpecRecord(value: unknown): SpecBlockRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as SpecBlockRecord;
}

function normalizeFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = String(key ?? "").trim();
    if (!k) continue;
    const v = toNonEmptyString(raw);
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function pickSpecFileContent(record: SpecBlockRecord, files: Record<string, string>, target: string): string | null {
  const direct = toNonEmptyString(files[target]);
  if (direct) return direct;

  if (target === "requirements.md") {
    return toNonEmptyString(record.requirements) ?? toNonEmptyString(record.requirement) ?? toNonEmptyString(files["requirement.md"]);
  }
  if (target === "design.md") {
    return toNonEmptyString(record.design);
  }
  if (target === "implementation.md") {
    return toNonEmptyString(record.implementation);
  }
  return null;
}

function buildNotice(results: SpecWriteResult[], warnings: string[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const files = result.writtenFiles.length ? ` (${result.writtenFiles.join(", ")})` : "";
    const verb = result.created ? "Spec created" : "Spec updated";
    lines.push(`${verb}: ${result.specRef}${files}`);
  }
  for (const warning of warnings) {
    lines.push(`Spec warning: ${warning}`);
  }
  return lines.length ? `\n\n---\n${lines.join("\n")}` : "";
}

async function createSpecWorkflow(args: {
  workspaceRoot: string;
  title: string;
  templateId?: string | null;
  description?: string | null;
}): Promise<{ specRef: string; absoluteDir: string } | { error: string }> {
  const response = await createWorkflowFromTemplate({
    template_id: args.templateId ?? undefined,
    title: args.title,
    description: args.description ?? undefined,
    workspace_path: args.workspaceRoot,
    format: "cli",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response) as unknown;
  } catch {
    return { error: "workflow create returned non-JSON response" };
  }

  const record = parsed as { error?: unknown; workflow?: unknown };
  if (record?.error) {
    return { error: String(record.error) };
  }

  const workflow = record?.workflow as { spec_dir?: unknown } | null;
  const specDir = toNonEmptyString(workflow?.spec_dir);
  if (!specDir) {
    return { error: "workflow create response missing workflow.spec_dir" };
  }

  const specRef = normalizeSpecRef(specDir);
  const absoluteDir = path.resolve(args.workspaceRoot, specRef);
  if (!isSafeSpecDir(args.workspaceRoot, absoluteDir)) {
    return { error: `invalid spec dir resolved outside docs/spec: ${specRef}` };
  }
  return { specRef, absoluteDir };
}

export async function processSpecBlocks(text: string, workspaceRoot: string): Promise<SpecProcessingResult> {
  const raw = String(text ?? "");
  const { blocks, cleanedText } = extractSpecBlocks(raw);
  if (blocks.length === 0) {
    return { cleanedText, results: [], warnings: [], finalText: cleanedText };
  }

  const warnings: string[] = [];
  const results: SpecWriteResult[] = [];

  for (const block of blocks) {
    let parsedYaml: unknown;
    try {
      parsedYaml = yaml.parse(block.yamlText);
    } catch (error) {
      warnings.push(`invalid YAML in spec block: ${(error as Error).message}`);
      continue;
    }

    const record = normalizeSpecRecord(parsedYaml);
    if (!record) {
      warnings.push("invalid spec block payload: expected a mapping");
      continue;
    }

    const specRefInput = toNonEmptyString(record.specRef) ?? toNonEmptyString(record.spec_ref);
    const title = toNonEmptyString(record.title) ?? (specRefInput ? path.basename(normalizeSpecRef(specRefInput)) : null);
    if (!title) {
      warnings.push("spec block missing title");
      continue;
    }

    const templateId =
      toNonEmptyString(record.template_id) ?? toNonEmptyString(record.templateId) ?? toNonEmptyString(record.template);
    const description = toNonEmptyString(record.description);

    const files = normalizeFiles(record.files);
    const targets = ["requirements.md", "design.md", "implementation.md"] as const;

    let specRef: string;
    let absoluteDir: string;
    let created = false;

    if (specRefInput) {
      specRef = normalizeSpecRef(specRefInput);
      absoluteDir = path.resolve(workspaceRoot, specRef);
      if (!isSafeSpecDir(workspaceRoot, absoluteDir)) {
        warnings.push(`invalid specRef: ${specRef}`);
        continue;
      }
      try {
        const stat = await fs.stat(absoluteDir);
        if (!stat.isDirectory()) {
          warnings.push(`specRef is not a directory: ${specRef}`);
          continue;
        }
      } catch {
        warnings.push(`specRef not found: ${specRef}`);
        continue;
      }
    } else {
      const createdResult = await createSpecWorkflow({
        workspaceRoot,
        title,
        templateId,
        description,
      });
      if ("error" in createdResult) {
        warnings.push(`failed to create workflow spec: ${createdResult.error}`);
        continue;
      }
      ({ specRef, absoluteDir } = createdResult);
      created = true;
    }

    const writtenFiles: string[] = [];
    for (const target of targets) {
      const content = pickSpecFileContent(record, files, target);
      if (!content) {
        warnings.push(`spec ${specRef} missing content for ${target}`);
        continue;
      }
      const targetPath = path.join(absoluteDir, target);
      const resolvedTarget = path.resolve(targetPath);
      if (!resolvedTarget.startsWith(path.resolve(absoluteDir) + path.sep)) {
        warnings.push(`refusing to write outside spec dir: ${target}`);
        continue;
      }
      await fs.writeFile(resolvedTarget, `${content.trimEnd()}\n`, { encoding: "utf8" });
      writtenFiles.push(target);
    }

    results.push({ specRef, absoluteDir, title, writtenFiles, created });
  }

  const finalText = cleanedText + buildNotice(results, warnings);
  return { cleanedText, results, warnings, finalText };
}

