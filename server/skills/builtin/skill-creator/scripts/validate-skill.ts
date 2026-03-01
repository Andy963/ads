#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const ALLOWED_KEYS = new Set(["name", "description", "metadata"]);

function validateSkill(skillDir: string): { valid: boolean; message: string } {
  const skillMd = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(skillMd)) {
    return { valid: false, message: "SKILL.md not found" };
  }

  const content = fs.readFileSync(skillMd, "utf-8");

  if (!content.startsWith("---")) {
    return { valid: false, message: "No YAML frontmatter found" };
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { valid: false, message: "Invalid frontmatter format" };
  }

  const frontmatterText = content.slice(content.indexOf("\n", 0) + 1, endIndex);
  const frontmatter = parseFrontmatter(frontmatterText);

  if (frontmatter === null) {
    return { valid: false, message: "Frontmatter must be a YAML dictionary" };
  }

  const unexpectedKeys = Object.keys(frontmatter).filter((k) => !ALLOWED_KEYS.has(k));
  if (unexpectedKeys.length > 0) {
    const allowed = [...ALLOWED_KEYS].sort().join(", ");
    const unexpected = unexpectedKeys.sort().join(", ");
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${unexpected}. Allowed properties are: ${allowed}`,
    };
  }

  if (!("name" in frontmatter)) {
    return { valid: false, message: "Missing 'name' in frontmatter" };
  }
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const name = (frontmatter.name ?? "").trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `Name '${name}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `Name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    if (name.length > MAX_NAME_LENGTH) {
      return {
        valid: false,
        message: `Name is too long (${name.length} characters). Maximum is ${MAX_NAME_LENGTH} characters.`,
      };
    }
  }

  const description = (frontmatter.description ?? "").trim();
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return {
        valid: false,
        message: `Description is too long (${description.length} characters). Maximum is ${MAX_DESCRIPTION_LENGTH} characters.`,
      };
    }
  }

  return { valid: true, message: "Skill is valid!" };
}

function parseFrontmatter(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) return null;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

const skillDir = process.argv[2];
if (!skillDir) {
  console.log("Usage: npx tsx scripts/validate-skill.ts <skill-directory>");
  process.exit(1);
}

const { valid, message } = validateSkill(path.resolve(skillDir));
console.log(message);
process.exit(valid ? 0 : 1);
