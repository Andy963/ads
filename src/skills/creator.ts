import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const ALLOWED_RESOURCE_DIRS = new Set(["scripts", "references", "assets"]);
const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "description", "metadata"]);

const SKILL_TEMPLATE = `---
name: {skill_name}
description: "[TODO: Describe what this skill does and when to use it]"
---

# {skill_title}

## Overview

[TODO: 1-2 sentences explaining what this skill enables]

## [TODO: Main section]

[TODO: Add content]
`;

const EXAMPLE_SCRIPT = `#!/usr/bin/env python3
"""
Example helper script for {skill_name}

This is a placeholder script that can be executed directly.
Replace with actual implementation or delete if not needed.
"""

def main():
    print("This is an example script for {skill_name}")

if __name__ == "__main__":
    main()
`;

const EXAMPLE_REFERENCE = `# Reference Documentation for {skill_title}

This is a placeholder for detailed reference documentation.
Replace with actual reference content or delete if not needed.

## Structure Suggestions

- Overview
- Authentication
- Endpoints with examples
- Error codes
`;

const EXAMPLE_ASSET = `# Example Asset File

This placeholder represents where asset files would be stored.
Replace with actual asset files (templates, images, fonts, etc.) or delete if not needed.

Asset files are NOT intended to be loaded into context, but rather used within
the output the agent produces.
`;

export interface InitSkillParams {
  workspaceRoot: string;
  rawName: string;
  resources?: string[];
  includeExamples?: boolean;
}

export interface InitSkillResult {
  skillName: string;
  skillDir: string;
  createdFiles: string[];
}

export interface ValidateSkillResult {
  valid: boolean;
  message: string;
  skillDir: string;
}

export interface SaveSkillDraftParams {
  workspaceRoot: string;
  name: string;
  description: string | null;
  body: string;
}

export interface SavedSkillDraft {
  skillName: string;
  skillDir: string;
  skillMdPath: string;
  backupPath: string | null;
}

export function normalizeSkillName(raw: string): string {
  let normalized = raw.trim().toLowerCase();
  normalized = normalized.replace(/[^a-z0-9]+/g, "-");
  normalized = normalized.replace(/^-+|-+$/g, "");
  normalized = normalized.replace(/-{2,}/g, "-");
  return normalized;
}

export function titleCaseSkillName(skillName: string): string {
  return skillName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseResourceList(raw: string | undefined): string[] {
  if (!raw) return [];
  const resources = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return normalizeResources(resources);
}

export function normalizeResources(resources: string[]): string[] {
  const invalid = resources.filter((r) => !ALLOWED_RESOURCE_DIRS.has(r));
  if (invalid.length > 0) {
    const allowed = [...ALLOWED_RESOURCE_DIRS].sort().join(", ");
    throw new Error(`Unknown resource type(s): ${invalid.sort().join(", ")}. Allowed: ${allowed}`);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource)) continue;
    seen.add(resource);
    deduped.push(resource);
  }
  return deduped;
}

export function initSkill(params: InitSkillParams): InitSkillResult {
  const rawName = params.rawName.trim();
  if (!rawName) {
    throw new Error("Skill name is required.");
  }

  const skillName = normalizeSkillName(rawName);
  if (!skillName) {
    throw new Error("Skill name becomes empty after normalization.");
  }
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Skill name is too long (${skillName.length}). Maximum is ${MAX_SKILL_NAME_LENGTH}.`);
  }
  if (!/^[a-z0-9-]+$/.test(skillName) || skillName.includes("--") || skillName.startsWith("-") || skillName.endsWith("-")) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }

  const workspaceRoot = path.resolve(params.workspaceRoot);
  const skillsRoot = path.join(workspaceRoot, ".agent", "skills");
  const skillDir = path.join(skillsRoot, skillName);

  if (!skillDir.startsWith(`${skillsRoot}${path.sep}`) && skillDir !== skillsRoot) {
    throw new Error("Skill path escapes workspace skills root.");
  }

  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill directory already exists: ${skillDir}`);
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const skillTitle = titleCaseSkillName(skillName);
  const skillContent = fillTemplate(SKILL_TEMPLATE, {
    skill_name: skillName,
    skill_title: skillTitle,
  });

  const createdFiles: string[] = [];
  const skillMdPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, skillContent, "utf8");
  createdFiles.push(skillMdPath);

  const resources = normalizeResources(params.resources ?? []);
  if (resources.length > 0) {
    const vars = { skill_name: skillName, skill_title: skillTitle };
    for (const resource of resources) {
      const resourceDir = path.join(skillDir, resource);
      fs.mkdirSync(resourceDir, { recursive: true });

      if (!params.includeExamples) {
        continue;
      }

      if (resource === "scripts") {
        const filePath = path.join(resourceDir, "example.py");
        fs.writeFileSync(filePath, fillTemplate(EXAMPLE_SCRIPT, vars), "utf8");
        fs.chmodSync(filePath, 0o755);
        createdFiles.push(filePath);
        continue;
      }

      if (resource === "references") {
        const filePath = path.join(resourceDir, "api_reference.md");
        fs.writeFileSync(filePath, fillTemplate(EXAMPLE_REFERENCE, vars), "utf8");
        createdFiles.push(filePath);
        continue;
      }

      if (resource === "assets") {
        const filePath = path.join(resourceDir, "example_asset.txt");
        fs.writeFileSync(filePath, EXAMPLE_ASSET, "utf8");
        createdFiles.push(filePath);
        continue;
      }
    }
  }

  return { skillName, skillDir, createdFiles };
}

export function validateSkillDirectory(skillDir: string): ValidateSkillResult {
  const resolvedDir = path.resolve(expandTilde(skillDir));
  const skillMd = path.join(resolvedDir, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    return { valid: false, message: "SKILL.md not found", skillDir: resolvedDir };
  }

  let content: string;
  try {
    content = fs.readFileSync(skillMd, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, message: `Failed to read SKILL.md: ${detail}`, skillDir: resolvedDir };
  }

  const frontmatter = extractYamlFrontmatter(content);
  if (!frontmatter.ok) {
    return { valid: false, message: frontmatter.error, skillDir: resolvedDir };
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(frontmatter.yaml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, message: `Invalid YAML frontmatter: ${detail}`, skillDir: resolvedDir };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, message: "Frontmatter must be a YAML dictionary", skillDir: resolvedDir };
  }

  const dict = parsed as Record<string, unknown>;
  const unexpectedKeys = Object.keys(dict).filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
  if (unexpectedKeys.length > 0) {
    const allowed = [...ALLOWED_FRONTMATTER_KEYS].sort().join(", ");
    const unexpected = unexpectedKeys.sort().join(", ");
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected}. Allowed properties are: ${allowed}`,
      skillDir: resolvedDir,
    };
  }

  const name = String(dict.name ?? "").trim();
  const description = String(dict.description ?? "").trim();
  if (!name) {
    return { valid: false, message: "Missing 'name' in frontmatter", skillDir: resolvedDir };
  }
  if (!description) {
    return { valid: false, message: "Missing 'description' in frontmatter", skillDir: resolvedDir };
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return {
      valid: false,
      message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      skillDir: resolvedDir,
    };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return {
      valid: false,
      message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      skillDir: resolvedDir,
    };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return {
      valid: false,
      message: `Name is too long (${name.length} characters). Maximum is ${MAX_SKILL_NAME_LENGTH} characters.`,
      skillDir: resolvedDir,
    };
  }

  if (description.includes("<") || description.includes(">")) {
    return { valid: false, message: "Description cannot contain angle brackets (< or >)", skillDir: resolvedDir };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      message: `Description is too long (${description.length} characters). Maximum is ${MAX_DESCRIPTION_LENGTH} characters.`,
      skillDir: resolvedDir,
    };
  }

  return { valid: true, message: "Skill is valid!", skillDir: resolvedDir };
}

export function saveSkillDraftFromBlock(params: SaveSkillDraftParams): SavedSkillDraft {
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const normalizedName = normalizeSkillName(params.name);
  if (!normalizedName) {
    throw new Error("Skill name becomes empty after normalization.");
  }
  if (!/^[a-z0-9-]+$/.test(normalizedName) || normalizedName.includes("--") || normalizedName.startsWith("-") || normalizedName.endsWith("-")) {
    throw new Error(`Invalid skill name: ${normalizedName}`);
  }
  if (normalizedName.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Skill name is too long (${normalizedName.length}). Maximum is ${MAX_SKILL_NAME_LENGTH}.`);
  }

  const skillsRoot = path.join(workspaceRoot, ".agent", "skills");
  const skillDir = path.join(skillsRoot, normalizedName);
  if (!skillDir.startsWith(`${skillsRoot}${path.sep}`) && skillDir !== skillsRoot) {
    throw new Error("Skill path escapes workspace skills root.");
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const skillMdPath = path.join(skillDir, "SKILL.md");
  const backupPath = fs.existsSync(skillMdPath) ? `${skillMdPath}.bak.${Date.now()}` : null;
  if (backupPath) {
    fs.copyFileSync(skillMdPath, backupPath);
  }

  const body = String(params.body ?? "").trim();
  const description = (params.description ?? "").trim();
  const content = body.startsWith("---")
    ? ensureTrailingNewline(body)
    : ensureTrailingNewline(buildSkillMarkdown({ skillName: normalizedName, description, body }));

  fs.writeFileSync(skillMdPath, content, "utf8");

  const validated = validateSkillDirectory(skillDir);
  if (!validated.valid) {
    if (backupPath) {
      fs.copyFileSync(backupPath, skillMdPath);
    } else {
      try {
        fs.rmSync(skillMdPath, { force: true });
      } catch {
        // ignore
      }
    }
    throw new Error(validated.message);
  }

  return { skillName: normalizedName, skillDir, skillMdPath, backupPath };
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function expandTilde(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
}

function extractYamlFrontmatter(content: string): { ok: true; yaml: string } | { ok: false; error: string } {
  if (!content.startsWith("---")) {
    return { ok: false, error: "No YAML frontmatter found" };
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { ok: false, error: "Invalid frontmatter format" };
  }

  const start = content.indexOf("\n") + 1;
  const yamlText = content.slice(start, endIndex);
  return { ok: true, yaml: yamlText };
}

function buildSkillMarkdown(params: { skillName: string; description: string; body: string }): string {
  const skillTitle = titleCaseSkillName(params.skillName);
  const safeDescription = (params.description || "[TODO: Describe what this skill does and when to use it]")
    .replaceAll('"', '\\"')
    .trim();

  const header = [
    "---",
    `name: ${params.skillName}`,
    `description: "${safeDescription}"`,
    "---",
    "",
    `# ${skillTitle}`,
    "",
  ].join("\n");

  const trimmedBody = params.body.trim();
  if (!trimmedBody) {
    return header + "\n";
  }
  return `${header}${trimmedBody}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
