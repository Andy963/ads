import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

import { fileURLToPath } from "node:url";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("SkillRegistryMetadata");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADS_REPO_ROOT = path.resolve(__dirname, "..", "..");

export type SkillRegistryMode = "overlay" | "whitelist";

export type SkillRegistryEntry = {
  provides: string[];
  priority: number;
  enabled: boolean;
};

export type SkillRegistry = {
  mode: SkillRegistryMode;
  skills: Map<string, SkillRegistryEntry>;
};

type CachedRegistry = {
  path: string;
  mtimeMs: number;
  registry: SkillRegistry;
};

let cached: CachedRegistry | null = null;

function isWorkspaceSkillsEnabled(): boolean {
  const raw = String(process.env.ADS_ENABLE_WORKSPACE_SKILLS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveSkillRegistryMetadataCandidates(workspaceRoot?: string): string[] {
  const candidates: string[] = [];
  const explicit = String(process.env.ADS_SKILLS_METADATA_PATH ?? "").trim();
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }

  candidates.push(path.join(resolveAdsStateDir(), ".agent", "skills", "metadata.yaml"));
  candidates.push(path.join(ADS_REPO_ROOT, ".agent", "skills", "metadata.yaml"));
  candidates.push(path.join(os.homedir(), ".agent", "skills", "metadata.yaml"));
  if (workspaceRoot && isWorkspaceSkillsEnabled()) {
    candidates.push(path.join(path.resolve(workspaceRoot), ".agent", "skills", "metadata.yaml"));
  }
  return candidates;
}

export function resolveSkillRegistryMetadataPath(workspaceRoot?: string): string {
  const candidates = resolveSkillRegistryMetadataCandidates(workspaceRoot);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return candidates[0] ?? path.join(resolveAdsStateDir(), ".agent", "skills", "metadata.yaml");
}

export function loadSkillRegistry(workspaceRoot?: string): SkillRegistry | null {
  const metadataPath = resolveSkillRegistryMetadataPath(workspaceRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(metadataPath);
  } catch {
    cached = null;
    return null;
  }

  if (cached && cached.path === metadataPath && cached.mtimeMs === stat.mtimeMs) {
    return cached.registry;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(metadataPath, "utf8");
  } catch (error) {
    cached = null;
    logger.warn(`Failed to read skill metadata: ${error}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (error) {
    cached = null;
    logger.warn(`Failed to parse skill metadata YAML: ${error}`);
    return null;
  }

  const registry = normalizeRegistry(parsed);
  cached = { path: metadataPath, mtimeMs: stat.mtimeMs, registry };
  return registry;
}

function normalizeRegistry(parsed: unknown): SkillRegistry {
  const obj = isRecord(parsed) ? parsed : {};
  const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
  const mode: SkillRegistryMode = modeRaw === "whitelist" ? "whitelist" : "overlay";

  const skills = new Map<string, SkillRegistryEntry>();
  const skillsObj = isRecord(obj.skills) ? obj.skills : null;
  if (skillsObj) {
    for (const [key, value] of Object.entries(skillsObj)) {
      const name = String(key ?? "").trim();
      if (!name) continue;
      const lowered = name.toLowerCase();
      const entryObj = isRecord(value) ? value : {};

      const enabled = entryObj.enabled !== false;
      const priority = typeof entryObj.priority === "number" && Number.isFinite(entryObj.priority)
        ? entryObj.priority
        : parseFiniteInt(entryObj.priority) ?? 0;
      const provides = normalizeProvides(entryObj.provides);

      skills.set(lowered, { enabled, priority, provides });
    }
  }

  return { mode, skills };
}

function normalizeProvides(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  const out: string[] = [];
  for (const item of val) {
    const tok = typeof item === "string" ? item.trim() : "";
    if (!tok) continue;
    out.push(tok);
  }
  return out;
}

function parseFiniteInt(val: unknown): number | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return !!val && typeof val === "object" && !Array.isArray(val);
}
