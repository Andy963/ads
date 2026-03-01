#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_SKILL_NAME_LENGTH = 64;
const ALLOWED_RESOURCES = new Set(["scripts", "references", "assets"]);

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

function normalizeSkillName(raw: string): string {
  let normalized = raw.trim().toLowerCase();
  normalized = normalized.replace(/[^a-z0-9]+/g, "-");
  normalized = normalized.replace(/^-+|-+$/g, "");
  normalized = normalized.replace(/-{2,}/g, "-");
  return normalized;
}

function titleCaseSkillName(skillName: string): string {
  return skillName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function parseResources(raw: string): string[] {
  if (!raw) return [];
  const resources = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = resources.filter((r) => !ALLOWED_RESOURCES.has(r));
  if (invalid.length > 0) {
    const allowed = [...ALLOWED_RESOURCES].sort().join(", ");
    console.error(`[ERROR] Unknown resource type(s): ${invalid.sort().join(", ")}`);
    console.error(`   Allowed: ${allowed}`);
    process.exit(1);
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    if (!seen.has(r)) {
      deduped.push(r);
      seen.add(r);
    }
  }
  return deduped;
}

function createResourceDirs(
  skillDir: string,
  skillName: string,
  skillTitle: string,
  resources: string[],
  includeExamples: boolean,
): void {
  const vars = { skill_name: skillName, skill_title: skillTitle };
  for (const resource of resources) {
    const resourceDir = path.join(skillDir, resource);
    fs.mkdirSync(resourceDir, { recursive: true });

    if (resource === "scripts") {
      if (includeExamples) {
        const filePath = path.join(resourceDir, "example.py");
        fs.writeFileSync(filePath, fillTemplate(EXAMPLE_SCRIPT, vars));
        fs.chmodSync(filePath, 0o755);
        console.log("[OK] Created scripts/example.py");
      } else {
        console.log("[OK] Created scripts/");
      }
    } else if (resource === "references") {
      if (includeExamples) {
        const filePath = path.join(resourceDir, "api_reference.md");
        fs.writeFileSync(filePath, fillTemplate(EXAMPLE_REFERENCE, vars));
        console.log("[OK] Created references/api_reference.md");
      } else {
        console.log("[OK] Created references/");
      }
    } else if (resource === "assets") {
      if (includeExamples) {
        const filePath = path.join(resourceDir, "example_asset.txt");
        fs.writeFileSync(filePath, EXAMPLE_ASSET);
        console.log("[OK] Created assets/example_asset.txt");
      } else {
        console.log("[OK] Created assets/");
      }
    }
  }
}

function initSkill(
  skillName: string,
  targetPath: string,
  resources: string[],
  includeExamples: boolean,
): string | null {
  const resolved = path.resolve(expandTilde(targetPath));
  const skillDir = path.join(resolved, skillName);

  if (fs.existsSync(skillDir)) {
    console.error(`[ERROR] Skill directory already exists: ${skillDir}`);
    return null;
  }

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    console.log(`[OK] Created skill directory: ${skillDir}`);
  } catch (e: unknown) {
    console.error(`[ERROR] Error creating directory: ${(e as Error).message}`);
    return null;
  }

  const skillTitle = titleCaseSkillName(skillName);
  const skillContent = fillTemplate(SKILL_TEMPLATE, {
    skill_name: skillName,
    skill_title: skillTitle,
  });

  const skillMdPath = path.join(skillDir, "SKILL.md");
  try {
    fs.writeFileSync(skillMdPath, skillContent);
    console.log("[OK] Created SKILL.md");
  } catch (e: unknown) {
    console.error(`[ERROR] Error creating SKILL.md: ${(e as Error).message}`);
    return null;
  }

  if (resources.length > 0) {
    try {
      createResourceDirs(skillDir, skillName, skillTitle, resources, includeExamples);
    } catch (e: unknown) {
      console.error(`[ERROR] Error creating resource directories: ${(e as Error).message}`);
      return null;
    }
  }

  console.log(`\n[OK] Skill '${skillName}' initialized successfully at ${skillDir}`);
  console.log("\nNext steps:");
  console.log("1. Edit SKILL.md to complete the TODO items and update the description");
  if (resources.length > 0) {
    if (includeExamples) {
      console.log("2. Customize or delete the example files in scripts/, references/, and assets/");
    } else {
      console.log("2. Add resources to scripts/, references/, and assets/ as needed");
    }
  } else {
    console.log("2. Create resource directories only if needed (scripts/, references/, assets/)");
  }
  console.log("3. Run the validator when ready to check the skill structure");

  return skillDir;
}

function parseArgs(argv: string[]): {
  skillName: string;
  path: string;
  resources: string;
  examples: boolean;
} {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: init-skill.ts <skill-name> --path <dir> [--resources scripts,references,assets] [--examples]",
    );
    process.exit(0);
  }

  let skillName = "";
  let targetPath = "";
  let resources = "";
  let examples = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--path") {
      i++;
      if (i >= args.length) {
        console.error("[ERROR] --path requires a value.");
        process.exit(1);
      }
      targetPath = args[i];
    } else if (arg === "--resources") {
      i++;
      if (i >= args.length) {
        console.error("[ERROR] --resources requires a value.");
        process.exit(1);
      }
      resources = args[i];
    } else if (arg === "--examples") {
      examples = true;
    } else if (arg.startsWith("-")) {
      console.error(`[ERROR] Unknown option: ${arg}`);
      process.exit(1);
    } else {
      if (skillName) {
        console.error("[ERROR] Multiple skill names provided. Expected exactly one.");
        process.exit(1);
      }
      skillName = arg;
    }
    i++;
  }

  if (!skillName) {
    console.error("[ERROR] Skill name is required.");
    process.exit(1);
  }
  if (!targetPath) {
    console.error("[ERROR] --path is required.");
    process.exit(1);
  }

  return { skillName, path: targetPath, resources, examples };
}

function main(): void {
  const parsed = parseArgs(process.argv);

  const rawSkillName = parsed.skillName;
  const skillName = normalizeSkillName(rawSkillName);

  if (!skillName) {
    console.error("[ERROR] Skill name must include at least one letter or digit.");
    process.exit(1);
  }
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    console.error(
      `[ERROR] Skill name '${skillName}' is too long (${skillName.length} characters). ` +
        `Maximum is ${MAX_SKILL_NAME_LENGTH} characters.`,
    );
    process.exit(1);
  }
  if (skillName !== rawSkillName) {
    console.log(`Note: Normalized skill name from '${rawSkillName}' to '${skillName}'.`);
  }

  const resources = parseResources(parsed.resources);
  if (parsed.examples && resources.length === 0) {
    console.error("[ERROR] --examples requires --resources to be set.");
    process.exit(1);
  }

  console.log(`Initializing skill: ${skillName}`);
  console.log(`   Location: ${parsed.path}`);
  if (resources.length > 0) {
    console.log(`   Resources: ${resources.join(", ")}`);
    if (parsed.examples) {
      console.log("   Examples: enabled");
    }
  } else {
    console.log("   Resources: none (create as needed)");
  }
  console.log();

  const result = initSkill(skillName, parsed.path, resources, parsed.examples);
  process.exit(result ? 0 : 1);
}

main();
