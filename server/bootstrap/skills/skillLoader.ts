import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createLogger, type Logger } from "../../utils/logger.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../../workspace/adsPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_SKILLS_DIR = path.join(PROJECT_ROOT, "templates", "skills");

interface FileCache {
  path: string;
  mtimeMs: number;
  hash: string;
  content: string;
}

export interface SkillLoadResult {
  name: string;
  text: string;
  source: "workspace" | "default" | "missing";
  path: string;
  hash: string;
}

function resolveWorkspaceSkillPath(workspaceRoot: string, name: string): string {
  migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
  return resolveWorkspaceStatePath(workspaceRoot, "templates", "skills", `${name}.md`);
}

function resolveDefaultSkillPath(name: string): string {
  return path.join(DEFAULT_SKILLS_DIR, `${name}.md`);
}

export class SkillLoader {
  private readonly logger: Logger;
  private readonly cacheByPath = new Map<string, FileCache>();
  private readonly warnedMissingWorkspace = new Set<string>();
  private readonly warnedMissingDefault = new Set<string>();

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger ?? createLogger("SkillLoader");
  }

  load(name: string, options?: { workspaceRoot?: string | null; required?: boolean }): SkillLoadResult {
    const normalizedName = String(name ?? "").trim();
    if (!normalizedName) {
      if (options?.required) {
        throw new Error("skill name is required");
      }
      return { name: "", text: "", source: "missing", path: "", hash: "missing" };
    }

    const workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
    if (workspaceRoot) {
      const workspacePath = resolveWorkspaceSkillPath(workspaceRoot, normalizedName);
      const workspaceCache = this.readFileWithCache(workspacePath, false, `workspace skill ${normalizedName}`);
      if (workspaceCache.hash !== "missing") {
        return { name: normalizedName, text: workspaceCache.content, source: "workspace", path: workspaceCache.path, hash: workspaceCache.hash };
      }
      if (!this.warnedMissingWorkspace.has(workspacePath)) {
        this.logger.warn(`[SkillLoader] workspace skill missing at ${workspacePath}, using built-in templates/skills/${normalizedName}.md`);
        this.warnedMissingWorkspace.add(workspacePath);
      }
    }

    const defaultPath = resolveDefaultSkillPath(normalizedName);
    const fallbackCache = this.readFileWithCache(defaultPath, options?.required === true, `default skill ${normalizedName}`);
    if (fallbackCache.hash === "missing") {
      if (!this.warnedMissingDefault.has(defaultPath)) {
        this.logger.warn(`[SkillLoader] built-in templates/skills/${normalizedName}.md missing at ${defaultPath}`);
        this.warnedMissingDefault.add(defaultPath);
      }
      return { name: normalizedName, text: "", source: "missing", path: defaultPath, hash: "missing" };
    }
    return { name: normalizedName, text: fallbackCache.content, source: "default", path: fallbackCache.path, hash: fallbackCache.hash };
  }

  private readFileWithCache(filePath: string, required: boolean, label: string): FileCache {
    const cached = this.cacheByPath.get(filePath) ?? null;
    try {
      const stats = fs.statSync(filePath);
      if (cached && cached.mtimeMs === stats.mtimeMs) {
        return cached;
      }
      const content = fs.readFileSync(filePath, "utf8");
      const next: FileCache = {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        content,
        hash: crypto.createHash("sha1").update(content).digest("hex"),
      };
      this.cacheByPath.set(filePath, next);
      return next;
    } catch (error) {
      if (required) {
        throw new Error(`[SkillLoader] failed to read ${label}: ${filePath}`, error instanceof Error ? { cause: error } : undefined);
      }
      const missing: FileCache = { path: filePath, mtimeMs: 0, content: "", hash: "missing" };
      this.cacheByPath.set(filePath, missing);
      return missing;
    }
  }
}

