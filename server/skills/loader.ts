import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

import { fileURLToPath } from "node:url";

import { createLogger } from "../utils/logger.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";

const logger = createLogger("SkillLoader");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADS_REPO_ROOT = path.resolve(__dirname, "..", "..");
const BUILTIN_SKILLS_ROOT = path.resolve(__dirname, "builtin");
const WORKSPACE_SKILLS_DIR = ".agent/skills";
const ADS_REPO_SKILLS_DIR = path.join(ADS_REPO_ROOT, WORKSPACE_SKILLS_DIR);
const SKILL_FILE_NAME = "SKILL.md";
const WORKSPACE_SKILLS_METADATA_FILE = "metadata.yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
  source: "workspace" | "ads" | "state" | "global" | "builtin";
}

function isWorkspaceSkillsEnabled(workspacePath: string): boolean {
  const raw = String(process.env.ADS_ENABLE_WORKSPACE_SKILLS ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }

  try {
    const metadataPath = path.join(path.resolve(workspacePath), WORKSPACE_SKILLS_DIR, WORKSPACE_SKILLS_METADATA_FILE);
    return fs.existsSync(metadataPath);
  } catch {
    return false;
  }
}

interface SkillFileCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
  meta: SkillMetadata | null;
}

const skillFileCache = new Map<string, SkillFileCacheEntry>();

function makeSkillFileCacheKey(source: SkillMetadata["source"], resolvedSkillFile: string): string {
  return `${source}:${resolvedSkillFile}`;
}

function readSkillFileWithCache(skillFile: string, source: SkillMetadata["source"]): SkillFileCacheEntry | null {
  const resolved = path.resolve(skillFile);
  const cacheKey = makeSkillFileCacheKey(source, resolved);
  const cached = skillFileCache.get(cacheKey) ?? null;

  try {
    const stats = fs.statSync(resolved);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached;
    }

    const content = fs.readFileSync(resolved, "utf-8");
    const dirName = path.basename(path.dirname(resolved));
    const frontmatter = parseFrontmatter(content);
    const name = String(frontmatter.name ?? dirName).trim();
    const description = String(frontmatter.description ?? "No description provided.").trim();

    const next: SkillFileCacheEntry = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      content,
      meta: name ? { name, description, location: resolved, source } : null,
    };
    skillFileCache.set(cacheKey, next);
    return next;
  } catch {
    if (cached) {
      skillFileCache.delete(cacheKey);
    }
    return null;
  }
}

function pruneSkillFileCache(activeRoots: Array<{ dir: string; source: SkillMetadata["source"] }>): void {
  const normalizedRoots = activeRoots.map(({ dir, source }) => ({
    dir: path.resolve(dir),
    source,
  }));

  for (const cacheKey of skillFileCache.keys()) {
    const matchedRoot = normalizedRoots.find(({ source }) => cacheKey.startsWith(`${source}:`));
    if (!matchedRoot) {
      skillFileCache.delete(cacheKey);
      continue;
    }

    const resolvedSkillFile = cacheKey.slice(`${matchedRoot.source}:`.length);
    const underActiveRoot =
      resolvedSkillFile === path.join(matchedRoot.dir, SKILL_FILE_NAME) ||
      resolvedSkillFile.startsWith(`${matchedRoot.dir}${path.sep}`);

    if (!underActiveRoot || !fs.existsSync(resolvedSkillFile)) {
      skillFileCache.delete(cacheKey);
    }
  }
}

export function discoverSkills(workspacePath: string, builtinRoot?: string): SkillMetadata[] {
  const resolvedBuiltin = builtinRoot ?? BUILTIN_SKILLS_ROOT;
  const adsStateSkillsDir = path.join(resolveAdsStateDir(), WORKSPACE_SKILLS_DIR);
  const roots: Array<{ dir: string; source: SkillMetadata["source"] }> = [];
  if (isWorkspaceSkillsEnabled(workspacePath)) {
    roots.push({ dir: path.join(path.resolve(workspacePath), WORKSPACE_SKILLS_DIR), source: "workspace" });
  }
  roots.push(
    { dir: adsStateSkillsDir, source: "state" },
    { dir: ADS_REPO_SKILLS_DIR, source: "ads" },
    { dir: path.join(os.homedir(), WORKSPACE_SKILLS_DIR), source: "global" },
    { dir: resolvedBuiltin, source: "builtin" },
  );

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
      const meta = readSkillFileWithCache(skillFile, source)?.meta ?? null;
      if (meta === null) {
        continue;
      }
      const key = meta.name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, meta);
      }
    }
  }

  pruneSkillFileCache(roots);

  return Array.from(byName.values()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function loadSkillBody(name: string, workspacePath: string, builtinRoot?: string): string | null {
  const lowered = name.toLowerCase();
  for (const skill of discoverSkills(workspacePath, builtinRoot)) {
    if (skill.name.toLowerCase() === lowered) {
      return readSkillFileWithCache(skill.location, skill.source)?.content ?? null;
    }
  }
  return null;
}

export function getSkillFileCacheSizeForTests(): number {
  return skillFileCache.size;
}

export function resetSkillFileCacheForTests(): void {
  skillFileCache.clear();
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

export function renderSkillMetaInstruction(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return [
      "<skill_system>",
      "当前没有可用的 skill。",
      "当你需要扩展能力时，可以使用 /ads.skill.init <name> 创建新的 skill。",
      "skill 存放位置：ADS state $ADS_STATE_DIR/.agent/skills/<name>/SKILL.md（默认 .ads/.agent/skills），全局 ~/.agent/skills/<name>/SKILL.md。",
      "</skill_system>",
    ].join("\n");
  }
  return [
    "<skill_system>",
    `当前有 ${skills.length} 个可用 skill。`,
    "当你遇到不熟悉的领域、需要专业知识、或者意识到自身能力不足时：",
    "1. 使用 /ads.skill.list 查看所有可用 skill 的名称和描述",
    "2. 使用 /ads.skill.load <name> 加载具体 skill 的完整内容到上下文",
    "3. 如果没有合适的 skill，使用 /ads.skill.init <name> 创建新的 skill",
    "",
    "不要猜测，主动查找和加载 skill 来获取专业指导。",
    "</skill_system>",
  ].join("\n");
}

export function renderSkillList(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "当前没有可用的 skill。使用 /ads.skill.init <name> 创建。";
  }
  const lines: string[] = [`共 ${skills.length} 个可用 skill：`, ""];
  for (const skill of skills) {
    lines.push(`- **${skill.name}** (${skill.source}): ${skill.description}`);
  }
  lines.push("");
  lines.push("使用 /ads.skill.load <name> 加载具体 skill。");
  return lines.join("\n");
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
