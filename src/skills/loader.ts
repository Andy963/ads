import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

import { fileURLToPath } from "node:url";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("SkillLoader");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_ROOT = path.resolve(__dirname, "builtin");
const PROJECT_SKILLS_DIR = ".agent/skills";
const SKILL_FILE_NAME = "SKILL.md";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
  source: "project" | "global" | "builtin";
}

export function discoverSkills(workspacePath: string, builtinRoot?: string): SkillMetadata[] {
  const resolvedBuiltin = builtinRoot ?? BUILTIN_SKILLS_ROOT;
  const roots: Array<{ dir: string; source: SkillMetadata["source"] }> = [
    { dir: path.join(path.resolve(workspacePath), PROJECT_SKILLS_DIR), source: "project" },
    { dir: path.join(os.homedir(), PROJECT_SKILLS_DIR), source: "global" },
    { dir: resolvedBuiltin, source: "builtin" },
  ];

  const byName = new Map<string, SkillMetadata>();

  for (const { dir, source } of roots) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillFile = path.join(dir, entry.name, SKILL_FILE_NAME);
      const meta = readSkill(skillFile, entry.name, source);
      if (meta === null) {
        continue;
      }
      const key = meta.name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, meta);
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function loadSkillBody(name: string, workspacePath: string, builtinRoot?: string): string | null {
  const lowered = name.toLowerCase();
  for (const skill of discoverSkills(workspacePath, builtinRoot)) {
    if (skill.name.toLowerCase() === lowered) {
      try {
        return fs.readFileSync(skill.location, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function renderCompactSkills(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = ["<available_skills>"];
  for (const skill of skills) {
    lines.push(`  <skill name="${skill.name}" source="${skill.source}">`);
    lines.push(`    ${skill.description}`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function readSkill(skillFile: string, dirName: string, source: SkillMetadata["source"]): SkillMetadata | null {
  if (!fs.existsSync(skillFile)) {
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(skillFile, "utf-8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const name = String(frontmatter.name ?? dirName).trim();
  const description = String(frontmatter.description ?? "No description provided.").trim();

  if (!name) {
    return null;
  }

  return { name, description, location: path.resolve(skillFile), source };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  if (!lines.length || lines[0].trim() !== "---") {
    return {};
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const payload = lines.slice(1, i).join("\n");
      try {
        const parsed = yaml.parse(payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const normalized: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(parsed)) {
            normalized[String(key).toLowerCase()] = value;
          }
          return normalized;
        }
      } catch (error) {
        logger.warn(`Failed to parse SKILL.md frontmatter: ${error}`);
      }
      return {};
    }
  }
  return {};
}
