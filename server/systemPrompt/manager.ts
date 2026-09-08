import crypto from "node:crypto";

import { createLogger, type Logger } from "../utils/logger.js";
import { parseOptionalBooleanFlag } from "../utils/flags.js";
import { discoverSkills, loadSkillBody, renderCompactSkills, renderSkillMetaInstruction } from "../skills/loader.js";
import { readMemory } from "../memory/memory.js";
import { getStateDatabase } from "../state/database.js";
import { BASE_LANE_PROMPTS, type LaneName } from "../state/lanePromptDefaults.js";
import { type ActiveLanePrompt, createLanePromptStore, type LanePromptStore } from "../state/lanePromptStore.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";

export interface ReinjectionConfig {
  enabled: boolean;
  turns: number;
}

const DEFAULT_INSTRUCTIONS_REINJECTION_TURNS = 6;

export interface SystemPromptManagerOptions {
  workspaceRoot: string;
  lane?: LaneName;
  stateDbPath?: string;
  lanePromptStore?: LanePromptStore;
  reinjection?: Partial<ReinjectionConfig>;
  logger?: Logger;
}

export interface PromptInjection {
  text: string;
  reason: string;
  instructionsHash: string;
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
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

  const enabledEnv =
    parseOptionalBooleanFlag(enabledEnvName ? process.env[enabledEnvName] : undefined) ??
    parseOptionalBooleanFlag(process.env.ADS_REINJECTION_ENABLED);
  const turnsEnv =
    parseTurns(turnsEnvName ? process.env[turnsEnvName] : undefined) ??
    parseTurns(process.env.ADS_REINJECTION_TURNS);

  return {
    enabled: enabledEnv ?? true,
    turns: turnsEnv ?? DEFAULT_INSTRUCTIONS_REINJECTION_TURNS,
  };
}

function hashLanePrompt(prompt: ActiveLanePrompt): string {
  return crypto
    .createHash("sha1")
    .update(`${prompt.lane}:${prompt.version}:${prompt.prompt}`)
    .digest("hex");
}

export class SystemPromptManager {
  private workspaceRoot: string;
  private readonly lane: LaneName | null;
  private readonly lanePromptStore: LanePromptStore | null;
  private readonly logger: Logger;
  private readonly reinjection: ReinjectionConfig;
  private lastLanePromptHash: string | null = null;
  private lastMemoryHash: string | null = null;
  private lastSkillsHash: string | null = null;
  private requestedSkillNames: string[] = [];
  private hasInjected = false;
  private turnCount = 0;
  private lastInjectionTurn = -1;
  private pendingReason: string | null = null;
  private lanePromptWarningLogged = false;

  constructor(options: SystemPromptManagerOptions) {
    this.workspaceRoot = detectWorkspaceFrom(options.workspaceRoot);
    this.lane = options.lane ?? null;
    this.logger = options.logger ?? createLogger("SystemPrompt");
    this.reinjection = {
      enabled: options.reinjection?.enabled ?? true,
      turns: options.reinjection?.turns ?? DEFAULT_INSTRUCTIONS_REINJECTION_TURNS,
    };
    if (this.reinjection.turns < 1) {
      this.reinjection.turns = DEFAULT_INSTRUCTIONS_REINJECTION_TURNS;
    }

    if (this.lane) {
      try {
        this.lanePromptStore =
          options.lanePromptStore ?? createLanePromptStore(getStateDatabase(options.stateDbPath));
      } catch (error) {
        this.lanePromptStore = null;
        this.logger.warn(
          `Lane prompt database unavailable; using the built-in ${this.lane} baseline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      this.lanePromptStore = null;
    }
  }

  setWorkspaceRoot(nextRoot: string): void {
    const normalized = detectWorkspaceFrom(nextRoot);
    if (normalized === this.workspaceRoot) {
      return;
    }
    this.workspaceRoot = normalized;
    this.lastMemoryHash = null;
    this.lastSkillsHash = null;
    this.requestedSkillNames = [];
    this.pendingReason = "workspace-changed";
    this.logger.debug(`Workspace switched to ${normalized}`);
  }

  setRequestedSkills(skillNames: string[]): void {
    const cleaned = skillNames
      .map((name) => String(name ?? "").trim())
      .filter(Boolean)
      .map((name) => name.toLowerCase());
    if (cleaned.length === 0) {
      return;
    }
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const name of cleaned) {
      if (seen.has(name)) continue;
      seen.add(name);
      uniq.push(name);
    }
    this.requestedSkillNames = uniq.slice(0, 6);
    this.pendingReason = this.pendingReason ?? "skills-requested";
  }

  maybeInject(): PromptInjection | null {
    const lanePrompt = this.readLanePrompt();
    const lanePromptHash = lanePrompt ? hashLanePrompt(lanePrompt) : null;
    const memoryHash = this.computeMemoryHash();
    const skillsHash = this.computeSkillsHash();

    if (this.hasInjected) {
      if (this.lastLanePromptHash && lanePromptHash !== this.lastLanePromptHash) {
        this.pendingReason = this.pendingReason ?? "lane-prompt-updated";
      }
      if (this.lastMemoryHash && memoryHash !== this.lastMemoryHash) {
        this.pendingReason = this.pendingReason ?? "memory-updated";
      }
      if (this.lastSkillsHash && skillsHash !== this.lastSkillsHash) {
        this.pendingReason = this.pendingReason ?? "skills-updated";
      }
    }

    const reason = this.computeInjectionReason();
    if (!reason) {
      return null;
    }

    const textParts: string[] = [];
    if (lanePrompt?.prompt.trim()) {
      textParts.push(lanePrompt.prompt.trim());
    }
    const skillsBlock = this.renderSkillsBlock();
    if (skillsBlock) {
      textParts.push(skillsBlock);
    }
    const requestedSkillsBlock = this.renderRequestedSkillsBlock();
    if (requestedSkillsBlock) {
      textParts.push(requestedSkillsBlock);
    }
    const memoryBlock = this.renderMemoryBlock();
    if (memoryBlock) {
      textParts.push(memoryBlock);
    }
    if (textParts.length === 0) {
      return null;
    }

    const text = textParts.join("\n\n\n");
    this.hasInjected = true;
    this.lastInjectionTurn = this.turnCount;
    this.lastLanePromptHash = lanePromptHash;
    this.lastMemoryHash = memoryHash;
    this.lastSkillsHash = skillsHash;
    this.requestedSkillNames = [];
    this.logger.debug(
      `Injected (${reason}) lane=${this.lane ?? "none"} prompt=${lanePromptHash ? shortHash(lanePromptHash) : "none"}`,
    );

    return {
      text,
      reason,
      instructionsHash: lanePromptHash ?? "none",
    };
  }

  completeTurn(): void {
    this.turnCount += 1;
  }

  private readLanePrompt(): ActiveLanePrompt | null {
    if (!this.lane) {
      return null;
    }
    if (!this.lanePromptStore) {
      return { lane: this.lane, version: 0, prompt: BASE_LANE_PROMPTS[this.lane] };
    }
    try {
      this.lanePromptWarningLogged = false;
      return this.lanePromptStore.getActiveLanePrompt(this.lane);
    } catch (error) {
      if (!this.lanePromptWarningLogged) {
        this.logger.warn(
          `Failed to read ${this.lane} lane prompt; using the built-in baseline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.lanePromptWarningLogged = true;
      }
      return { lane: this.lane, version: 0, prompt: BASE_LANE_PROMPTS[this.lane] };
    }
  }

  private renderSkillsBlock(): string | null {
    try {
      const skills = discoverSkills(this.workspaceRoot);
      const compactSkills = renderCompactSkills(skills);
      return [renderSkillMetaInstruction(skills), compactSkills]
        .filter((part) => part && part.trim())
        .join("\n\n");
    } catch {
      return null;
    }
  }

  private renderMemoryBlock(): string | null {
    if (String(process.env.ADS_MEMORY_INJECTION_ENABLED ?? "true").trim().toLowerCase() === "false") {
      return null;
    }
    try {
      const content = readMemory(this.workspaceRoot);
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }
      return `<memory>\n${trimmed}\n</memory>`;
    } catch {
      return null;
    }
  }

  private renderRequestedSkillsBlock(): string | null {
    if (this.requestedSkillNames.length === 0) {
      return null;
    }
    const availableByName = new Map(
      discoverSkills(this.workspaceRoot).map((skill) => [skill.name.toLowerCase(), skill]),
    );
    const parts = ["<requested_skills>"];
    for (const name of this.requestedSkillNames) {
      const skill = availableByName.get(name.toLowerCase());
      const body = skill ? loadSkillBody(skill.name, this.workspaceRoot) : null;
      if (!skill || !body) {
        parts.push(`  <skill name="${name}" missing="true" />`);
        continue;
      }
      parts.push(`  <skill name="${skill.name}" location="${skill.location}">`);
      parts.push(body.trim());
      parts.push("  </skill>");
    }
    parts.push("</requested_skills>");
    return parts.join("\n");
  }

  private computeMemoryHash(): string {
    try {
      const content = readMemory(this.workspaceRoot);
      return crypto.createHash("sha1").update(content ?? "").digest("hex");
    } catch {
      return crypto.createHash("sha1").update("").digest("hex");
    }
  }

  private computeSkillsHash(): string {
    try {
      const skills = discoverSkills(this.workspaceRoot);
      const payload = skills.map((skill) => ({ name: skill.name, description: skill.description, source: skill.source }));
      return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
    } catch {
      return crypto.createHash("sha1").update("[]").digest("hex");
    }
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

    if (this.requestedSkillNames.length > 0) {
      return `skills-requested-${this.turnCount}`;
    }
    return null;
  }
}
