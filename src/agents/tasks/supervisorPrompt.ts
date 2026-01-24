import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createLogger, type Logger } from "../../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_SUPERVISOR_PROMPT_PATH = path.join(PROJECT_ROOT, "templates", "supervisor.md");

interface FileCache {
  path: string;
  mtimeMs: number;
  hash: string;
  content: string;
}

export interface SupervisorPromptResult {
  text: string;
  source: "workspace" | "default" | "custom" | "missing";
  path: string;
  hash: string;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  return undefined;
}

function resolveWorkspacePromptPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".ads", "templates", "supervisor.md");
}

function resolveCustomPromptPath(workspaceRoot: string): string | null {
  const raw = process.env.ADS_SUPERVISOR_PROMPT_PATH;
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceRoot, trimmed);
}

export class SupervisorPromptLoader {
  private readonly logger: Logger;
  private cache: FileCache | null = null;
  private workspaceWarningLogged = false;
  private defaultWarningLogged = false;
  private customWarningLogged = false;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger ?? createLogger("SupervisorPrompt");
  }

  load(workspaceRoot: string): SupervisorPromptResult {
    const enabled = parseBoolean(process.env.ADS_SUPERVISOR_PROMPT_ENABLED);
    if (enabled === false) {
      return { text: "", source: "missing", path: "", hash: "disabled" };
    }

    const normalizedRoot = path.resolve(workspaceRoot);
    const customPath = resolveCustomPromptPath(normalizedRoot);
    if (customPath) {
      const customCache = this.readFileWithCache(
        customPath,
        false,
        "custom supervisor prompt",
        this.cache?.path === customPath ? this.cache : null,
      );
      this.cache = customCache;
      if (customCache.hash === "missing") {
        if (!this.customWarningLogged) {
          this.logger.warn(`[SupervisorPrompt] missing custom prompt at ${customPath}`);
          this.customWarningLogged = true;
        }
        return { text: "", source: "missing", path: customPath, hash: "missing" };
      }
      this.customWarningLogged = false;
      return { text: customCache.content, source: "custom", path: customCache.path, hash: customCache.hash };
    }

    const workspacePath = resolveWorkspacePromptPath(normalizedRoot);
    const workspaceCache = this.readFileWithCache(
      workspacePath,
      false,
      "workspace supervisor prompt",
      this.cache?.path === workspacePath ? this.cache : null,
    );

    if (workspaceCache.hash !== "missing") {
      this.cache = workspaceCache;
      this.workspaceWarningLogged = false;
      return { text: workspaceCache.content, source: "workspace", path: workspaceCache.path, hash: workspaceCache.hash };
    }

    const fallbackCache = this.readFileWithCache(
      DEFAULT_SUPERVISOR_PROMPT_PATH,
      false,
      "default supervisor prompt",
      this.cache?.path === DEFAULT_SUPERVISOR_PROMPT_PATH ? this.cache : null,
    );
    this.cache = fallbackCache.hash === "missing" ? workspaceCache : fallbackCache;

    if (!this.workspaceWarningLogged) {
      this.logger.warn(`[SupervisorPrompt] workspace prompt missing at ${workspacePath}, using built-in templates/supervisor.md`);
      this.workspaceWarningLogged = true;
    }

    if (fallbackCache.hash === "missing") {
      if (!this.defaultWarningLogged) {
        this.logger.warn(`[SupervisorPrompt] built-in templates/supervisor.md missing at ${DEFAULT_SUPERVISOR_PROMPT_PATH}`);
        this.defaultWarningLogged = true;
      }
      return { text: "", source: "missing", path: DEFAULT_SUPERVISOR_PROMPT_PATH, hash: "missing" };
    }

    this.defaultWarningLogged = false;
    return { text: fallbackCache.content, source: "default", path: fallbackCache.path, hash: fallbackCache.hash };
  }

  private readFileWithCache(
    filePath: string,
    required: boolean,
    label: string,
    cache: FileCache | null,
  ): FileCache {
    try {
      const stats = fs.statSync(filePath);
      if (cache && cache.path === filePath && cache.mtimeMs === stats.mtimeMs) {
        return cache;
      }
      const content = fs.readFileSync(filePath, "utf8");
      return {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        content,
        hash: crypto.createHash("sha1").update(content).digest("hex"),
      };
    } catch (error) {
      if (required) {
        throw new Error(
          `[SupervisorPrompt] failed to read ${label}: ${filePath}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      return { path: filePath, mtimeMs: 0, content: "", hash: "missing" };
    }
  }
}

