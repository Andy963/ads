import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createLogger, type Logger } from "../utils/logger.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_INSTRUCTIONS_PATH = path.join(PROJECT_ROOT, "templates", "instructions.md");

export interface ReinjectionConfig {
  enabled: boolean;
  turns: number;
  rulesTurns?: number;
}

export interface SystemPromptManagerOptions {
  workspaceRoot: string;
  reinjection?: Partial<ReinjectionConfig>;
  logger?: Logger;
}

interface FileCache {
  path: string;
  mtimeMs: number;
  hash: string;
  content: string;
}

export interface PromptInjection {
  text: string;
  reason: string;
  instructionsHash: string;
  rulesHash: string;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
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

function parseTurns(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns < 1) {
    return undefined;
  }
  return Math.floor(turns);
}

export function resolveReinjectionConfig(prefix?: string): ReinjectionConfig {
  const enabledEnvName = prefix ? `${prefix}_REINJECTION_ENABLED` : undefined;
  const turnsEnvName = prefix ? `${prefix}_REINJECTION_TURNS` : undefined;
  const rulesTurnsEnvName = prefix ? `${prefix}_RULES_REINJECTION_TURNS` : undefined;

  const enabledEnv =
    parseBoolean(enabledEnvName ? process.env[enabledEnvName] : undefined) ??
    parseBoolean(process.env.ADS_REINJECTION_ENABLED);
  const turnsEnv =
    parseTurns(turnsEnvName ? process.env[turnsEnvName] : undefined) ??
    parseTurns(process.env.ADS_REINJECTION_TURNS);
  const rulesTurnsEnv =
    parseTurns(rulesTurnsEnvName ? process.env[rulesTurnsEnvName] : undefined) ??
    parseTurns(process.env.ADS_RULES_REINJECTION_TURNS);

  return {
    enabled: enabledEnv ?? true,
    turns: turnsEnv ?? 6,
    rulesTurns: rulesTurnsEnv ?? 1,
  };
}

export class SystemPromptManager {
  private workspaceRoot: string;
  private workspaceInitialized: boolean;
  private readonly logger: Logger;
  private readonly reinjection: ReinjectionConfig;
  private readonly rulesReinjectionTurns: number;
  private instructionsCache: FileCache | null = null;
  private rulesCache: FileCache | null = null;
  private hasInjected = false;
  private turnCount = 0;
  private lastInjectionTurn = -1;
  private lastRulesInjectionTurn = -1;
  private pendingReason: string | null = null;
  private lastInstructionsHash: string | null = null;
  private lastRulesHash: string | null = null;
  private instructionsWarningLogged = false;
  private workspaceWarningLogged = false;
  private rulesWarningLogged = false;

  constructor(options: SystemPromptManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.workspaceInitialized = this.checkWorkspaceInitialized(this.workspaceRoot);
    this.reinjection = {
      enabled: options.reinjection?.enabled ?? true,
      turns: options.reinjection?.turns ?? 6,
      rulesTurns: options.reinjection?.rulesTurns ?? 1,
    };
    if (this.reinjection.turns < 1) {
      this.reinjection.turns = 10;
    }
    const ruleTurns = this.reinjection.rulesTurns && this.reinjection.rulesTurns > 0
      ? this.reinjection.rulesTurns
      : 1;
    this.rulesReinjectionTurns = ruleTurns;
    this.logger = options.logger ?? createLogger("SystemPrompt");
  }

  setWorkspaceRoot(nextRoot: string): void {
    const normalized = path.resolve(nextRoot);
    if (normalized === this.workspaceRoot) {
      return;
    }
    this.workspaceRoot = normalized;
    this.workspaceInitialized = this.checkWorkspaceInitialized(normalized);
    this.instructionsCache = null;
    this.rulesCache = null;
    this.instructionsWarningLogged = false;
    this.workspaceWarningLogged = false;
    this.rulesWarningLogged = false;
    this.pendingReason = "workspace-changed";
    this.logger.debug(`Workspace switched to ${normalized}`);
  }

  maybeInject(): PromptInjection | null {
    // 先刷新缓存以捕获指令/规则变更，确保 pendingReason 在本次判断前就绪
    const instructionsCache = this.readInstructions();
    const rulesCache = this.readRules();

    const reason = this.computeInjectionReason();
    if (!reason) {
      return null;
    }

    const rulesOnly = reason.startsWith("rules-only");
    const instructions = rulesOnly ? null : instructionsCache;
    const rules = rulesCache;

    const textParts: string[] = [];
    const workspaceNotice = this.buildWorkspaceNotice();
    if (workspaceNotice) {
      textParts.push(workspaceNotice);
    }
    if (!rulesOnly && instructions && instructions.content.trim()) {
      textParts.push(instructions.content.trim());
    }
    if (rules.content.trim()) {
      textParts.push(rules.content.trim());
    }
    if (textParts.length === 0) {
      return null;
    }
    const text = textParts.join("\n\n\n");

    this.hasInjected = true;
    // 只有在注入了 instructions 时才刷新指令注入计数，避免 rules-only 流程阻塞周期性指令注入
    if (!rulesOnly) {
      this.lastInjectionTurn = this.turnCount;
    }
    this.lastRulesInjectionTurn = this.turnCount;
    if (!rulesOnly && instructions) {
      this.lastInstructionsHash = instructions.hash;
    }
    this.lastRulesHash = rules.hash;
    this.logger.debug(
      `Injected (${reason}) instructions=${rulesOnly || !instructions ? "skip" : shortHash(instructions.hash)} rules=${shortHash(rules.hash)}`,
    );

    return {
      text,
      reason,
      instructionsHash: rulesOnly || !instructions ? this.lastInstructionsHash ?? "" : instructions.hash,
      rulesHash: rules.hash,
    };
  }

  completeTurn(): void {
    this.turnCount += 1;
  }

  private computeInjectionReason(): string | null {
    if (!this.hasInjected) {
      return "initial";
    }

    if (this.pendingReason) {
      const reason = this.pendingReason;
      this.pendingReason = null;
      return reason;
    }

    if (
      this.reinjection.enabled &&
      this.reinjection.turns > 0 &&
      this.turnCount - this.lastInjectionTurn >= this.reinjection.turns
    ) {
      return `turn-${this.turnCount}`;
    }

    if (
      this.rulesReinjectionTurns > 0 &&
      this.turnCount - this.lastRulesInjectionTurn >= this.rulesReinjectionTurns
    ) {
      return `rules-only-${this.turnCount}`;
    }
    return null;
  }

  private readInstructions(): FileCache {
    migrateLegacyWorkspaceAdsIfNeeded(this.workspaceRoot);
    const instructionsPath = resolveWorkspaceStatePath(this.workspaceRoot, "templates", "instructions.md");

    // Always check workspace instructions first to allow hot-loading after fallback
    const workspaceCache = this.readFileWithCache(
      instructionsPath,
      false,
      "instructions",
      this.instructionsCache?.path === instructionsPath ? this.instructionsCache : null,
    );

    let cache = workspaceCache;

    if (workspaceCache.hash === "missing") {
      const fallbackCache = this.readFileWithCache(
        DEFAULT_INSTRUCTIONS_PATH,
        false,
        "default instructions",
        this.instructionsCache?.path === DEFAULT_INSTRUCTIONS_PATH ? this.instructionsCache : null,
      );

      if (fallbackCache.hash !== "missing") {
        cache = fallbackCache;
        if (!this.instructionsWarningLogged) {
          this.logger.warn(
            `workspace instructions missing at ${instructionsPath}, using built-in templates/instructions.md`,
          );
          this.instructionsWarningLogged = true;
        }
      } else if (!this.instructionsWarningLogged) {
        this.logger.warn(
          `instructions missing at ${instructionsPath}, and no default templates/instructions.md found`,
        );
        this.instructionsWarningLogged = true;
      }
    } else {
      this.instructionsWarningLogged = false;
    }

    this.instructionsCache = cache;
    if (this.lastInstructionsHash && cache.hash !== this.lastInstructionsHash && cache.hash !== "missing") {
      this.pendingReason = this.pendingReason ?? "instructions-updated";
    }
    return cache;
  }

  private checkWorkspaceInitialized(workspaceRoot: string): boolean {
    migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
    return fs.existsSync(resolveWorkspaceStatePath(workspaceRoot, "workspace.json"));
  }

  private buildWorkspaceNotice(): string | null {
    if (!this.workspaceInitialized) {
      const nowInitialized = this.checkWorkspaceInitialized(this.workspaceRoot);
      if (nowInitialized) {
        this.workspaceInitialized = true;
        this.workspaceWarningLogged = false;
      }
    }
    if (this.workspaceInitialized) {
      return null;
    }
    if (!this.workspaceWarningLogged) {
      this.logger.warn(
        `workspace not initialized at ${this.workspaceRoot}; instructions/rules falling back to built-in templates.`,
      );
      this.workspaceWarningLogged = true;
    }
    return [
      "[Workspace Notice] 当前工作区尚未初始化（workspace.json 缺失）。",
      "将使用内置 templates/ 指令与规则；如需自定义，请运行 `ads init` 初始化工作区。",
    ].join("\n");
  }

  private readRules(): FileCache {
    migrateLegacyWorkspaceAdsIfNeeded(this.workspaceRoot);
    const rulesPath = resolveWorkspaceStatePath(this.workspaceRoot, "rules.md");
    const templateRules = resolveWorkspaceStatePath(this.workspaceRoot, "templates", "rules.md");
    let cache: FileCache | null = null;

    if (fs.existsSync(rulesPath)) {
      cache = this.readFileWithCache(rulesPath, false, "workspace rules", this.rulesCache);
    } else if (fs.existsSync(templateRules)) {
      cache = this.readFileWithCache(templateRules, false, "template rules", this.rulesCache);
    } else {
      cache = {
        path: rulesPath,
        content: "",
        hash: "missing",
        mtimeMs: 0,
      };
    }

    if (cache.hash === "missing" && !this.rulesWarningLogged) {
      this.logger.warn(
        `workspace rules missing at ${rulesPath}, continuing with instructions only`,
      );
      this.rulesWarningLogged = true;
    }

    this.rulesCache = cache;
    if (this.lastRulesHash && cache.hash !== this.lastRulesHash && cache.hash !== "missing") {
      this.pendingReason = this.pendingReason ?? "rules-updated";
    }
    if (cache.hash === "missing") {
      cache.hash = "missing";
    } else {
      this.rulesWarningLogged = false;
    }
    return cache;
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
      const content = fs.readFileSync(filePath, "utf-8");
      return {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        content,
        hash: crypto.createHash("sha1").update(content).digest("hex"),
      };
    } catch (error) {
      if (required) {
        throw new Error(
          `[SystemPrompt] 无法读取 ${label}: ${filePath}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      return {
        path: filePath,
        mtimeMs: 0,
        content: "",
        hash: "missing",
      };
    }
  }
}
