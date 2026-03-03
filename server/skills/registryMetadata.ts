import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

import { fileURLToPath } from "node:url";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { parseOptionalBooleanFlag } from "../utils/flags.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("SkillRegistryMetadata");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADS_REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_METADATA_RELATIVE_PATH = path.join(".agent", "skills", "metadata.yaml");

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

function isWorkspaceSkillsEnabled(workspaceRoot?: string): boolean {
  const enabled = parseOptionalBooleanFlag(process.env.ADS_ENABLE_WORKSPACE_SKILLS);
  if (enabled === true) {
    return true;
  }
  if (!workspaceRoot) {
    return false;
  }
  try {
    const metadataPath = path.join(path.resolve(workspaceRoot), SKILLS_METADATA_RELATIVE_PATH);
    return fs.existsSync(metadataPath);
  } catch {
    return false;
  }
}

function resolveSkillRegistryMetadataCandidates(workspaceRoot?: string): string[] {
  const candidates: string[] = [];
  const explicit = String(process.env.ADS_SKILLS_METADATA_PATH ?? "").trim();
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }

  candidates.push(path.join(resolveAdsStateDir(), SKILLS_METADATA_RELATIVE_PATH));
  candidates.push(path.join(ADS_REPO_ROOT, SKILLS_METADATA_RELATIVE_PATH));
  candidates.push(path.join(os.homedir(), SKILLS_METADATA_RELATIVE_PATH));
  if (workspaceRoot && isWorkspaceSkillsEnabled(workspaceRoot)) {
    candidates.push(path.join(path.resolve(workspaceRoot), SKILLS_METADATA_RELATIVE_PATH));
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
  return candidates[0] ?? path.join(resolveAdsStateDir(), SKILLS_METADATA_RELATIVE_PATH);
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

  const overlayPath =
    explicit || !workspaceRoot || !isWorkspaceSkillsEnabled(workspaceRoot)
      ? null
      : path.join(path.resolve(workspaceRoot), SKILLS_METADATA_RELATIVE_PATH);

  let overlayStat: fs.Stats | null = null;
  if (overlayPath && overlayPath !== metadataPath) {
    try {
      overlayStat = fs.statSync(overlayPath);
    } catch {
      overlayStat = null;
    }
  }

  const signature = overlayStat
    ? `${metadataPath}:${stat.mtimeMs}|${overlayPath!}:${overlayStat.mtimeMs}`
    : `${metadataPath}:${stat.mtimeMs}`;

  if (cached && cached.signature === signature) {
    return cached.registry;
  }

  const baseRegistry = loadSkillRegistryFromPath(metadataPath);
  if (!baseRegistry) {
    cached = null;
    return null;
  }

  let registry = baseRegistry;
  if (overlayStat && overlayPath) {
    const overlayRegistry = loadSkillRegistryFromPath(overlayPath);
    if (overlayRegistry) {
      registry = mergeRegistries(registry, overlayRegistry);
    }
  }

  cached = { signature, registry };
  return registry;
}

function mergeRegistries(base: SkillRegistry, overlay: SkillRegistry): SkillRegistry {
  const skills = new Map(base.skills);
  for (const [key, entry] of overlay.skills.entries()) {
    skills.set(key, entry);
  }
  return { mode: overlay.mode, skills };
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
