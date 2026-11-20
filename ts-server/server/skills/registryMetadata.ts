import fs from "node:fs";
import path from "node:path";

import yaml from "yaml";

import { createLogger } from "../utils/logger.js";
import {
  GLOBAL_SKILLS_METADATA_FILE,
  resolveGlobalSkillsDir,
} from "./paths.js";

const logger = createLogger("SkillRegistryMetadata");


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
  signature: string;
  registry: SkillRegistry;
};

let cached: CachedRegistry | null = null;

function resolveSkillRegistryMetadataCandidates(_workspaceRoot?: string): string[] {
  const candidates: string[] = [];
  const explicit = String(process.env.ADS_SKILLS_METADATA_PATH ?? "").trim();
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }

  candidates.push(path.join(resolveGlobalSkillsDir(), GLOBAL_SKILLS_METADATA_FILE));
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
  return candidates[0] ?? path.join(resolveGlobalSkillsDir(), GLOBAL_SKILLS_METADATA_FILE);
}

export function loadSkillRegistry(workspaceRoot?: string): SkillRegistry | null {
  const explicit = String(process.env.ADS_SKILLS_METADATA_PATH ?? "").trim();
  const metadataPath = explicit ? path.resolve(explicit) : resolveSkillRegistryMetadataPath(workspaceRoot);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(metadataPath);
  } catch {
    cached = null;
    return null;
  }

  const signature = `${metadataPath}:${stat.mtimeMs}`;

  if (cached && cached.signature === signature) {
    return cached.registry;
  }

  const baseRegistry = loadSkillRegistryFromPath(metadataPath);
  if (!baseRegistry) {
    cached = null;
    return null;
  }

  const registry = baseRegistry;
  cached = { signature, registry };
  return registry;
}

function loadSkillRegistryFromPath(metadataPath: string): SkillRegistry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(metadataPath, "utf8");
  } catch (error) {
    logger.warn(`Failed to read skill metadata: ${error}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (error) {
    logger.warn(`Failed to parse skill metadata YAML: ${error}`);
    return null;
  }

  return normalizeRegistry(parsed);
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
