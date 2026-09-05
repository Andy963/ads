import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

import { fileURLToPath } from "node:url";

import { createLogger } from "../utils/logger.js";
import { loadSkillRegistry } from "./registryMetadata.js";
import { SkillFrontmatterV1Schema, type SkillFrontmatterV1 } from "./schema.js";
import {
  SKILL_FILE_NAME,
  resolveGlobalSkillsDir,
} from "./paths.js";
import { migrateLegacyStateSkills } from "./migration.js";

const logger = createLogger("SkillLoader");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_ROOT = path.resolve(__dirname, "builtin");

export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
  source: "global" | "builtin";
  version: number;
  provides: string[];
  priority: number;
  platforms: Array<"linux" | "macos" | "win32">;
  requiredEnv: Array<{ name: string; prompt?: string; secret: boolean }>;
  triggers: { keywords: string[]; intents: string[] };
  entrypoints: Array<{ cmd: string; script?: string; argsTemplate: string[]; description?: string }>;
  deprecated: boolean;
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
    const normalizedFrontmatter = {
      ...frontmatter,
      name: String(frontmatter.name ?? dirName).trim(),
      description: String(frontmatter.description ?? "No description provided.").trim(),
    };
    const parsed = SkillFrontmatterV1Schema.safeParse(normalizedFrontmatter);
    if (!parsed.success) {
      logger.warn(`Invalid SKILL.md frontmatter at ${resolved}: ${parsed.error.message}`);
    }
    const skill = parsed.success ? parsed.data : buildLegacySkillFrontmatter(normalizedFrontmatter);

    const next: SkillFileCacheEntry = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      content,
      meta: skill.name ? toSkillMetadata(skill, resolved, source) : null,
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

function buildLegacySkillFrontmatter(frontmatter: Record<string, unknown>): SkillFrontmatterV1 {
  const name = String(frontmatter.name ?? "").trim();
  return {
    name: /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : "",
    description: String(frontmatter.description ?? "No description provided.").trim() || "No description provided.",
    version: 1,
    provides: [],
    priority: 100,
    platforms: ["linux", "macos", "win32"],
    required_env: [],
    triggers: { keywords: [], intents: [] },
    entrypoints: [],
    deprecated: false,
  };
}

function toSkillMetadata(skill: SkillFrontmatterV1, location: string, source: SkillMetadata["source"]): SkillMetadata {
  return {
    name: skill.name,
    description: skill.description,
    location,
    source,
    version: skill.version,
    provides: skill.provides,
    priority: skill.priority,
    platforms: skill.platforms,
    requiredEnv: skill.required_env,
    triggers: skill.triggers,
    entrypoints: skill.entrypoints.map((entry) => ({
      cmd: entry.cmd,
      script: entry.script,
      argsTemplate: entry.args_template,
      description: entry.description,
    })),
    deprecated: skill.deprecated,
  };
}

function applyRegistryOverrides(skills: SkillMetadata[], workspacePath: string): SkillMetadata[] {
  const registry = loadSkillRegistry(workspacePath);
  if (!registry) return skills;
  const maybeWhitelisted = registry.mode === "whitelist"
    ? skills.filter((skill) => registry.skills.get(skill.name.toLowerCase())?.enabled === true)
    : skills;
  return maybeWhitelisted
    .map((skill) => {
      const override = registry.skills.get(skill.name.toLowerCase());
      if (!override) return skill;
      if (!override.enabled) return null;
      return {
        ...skill,
        provides: override.provides.length > 0 ? override.provides : skill.provides,
        priority: override.priority,
        deprecated: true,
      };
    })
    .filter((skill): skill is SkillMetadata => skill !== null);
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
  if (process.env.ADS_MIGRATE_LEGACY_SKILLS !== "0") {
    migrateLegacyStateSkills();
  }
  const resolvedBuiltin = builtinRoot ?? BUILTIN_SKILLS_ROOT;
  const roots: Array<{ dir: string; source: SkillMetadata["source"] }> = [];
  roots.push(
    { dir: resolveGlobalSkillsDir(), source: "global" },
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

  return applyRegistryOverrides(Array.from(byName.values()), workspacePath)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
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
      "skill 存放位置：全局 $CODEX_HOME/skills/<name>/SKILL.md（默认 ~/.codex/skills）。",
      "</skill_system>",
    ].join("\n");
  }
  return [
    "<skill_system>",
    `当前有 ${skills.length} 个可用 skill。`,
    "ADS 会按用户请求自动加载匹配 skill 的完整内容。",
    "当上下文中有 <requested_skills> 时，直接按其内容执行；`location` 是该 SKILL.md 的绝对路径，脚本就在同目录下。",
    "不得为了寻找已经注入的 skill 或其脚本再次调用 /ads.skill.list、/ads.skill.load 或搜索整个文件系统。",
    "如果没有匹配 skill，才使用 /ads.skill.list 查看能力，或使用 /ads.skill.init <name> 创建新的 skill。",
    "",
    "不要猜测，优先使用已注入的专业指导。",
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
