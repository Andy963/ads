import type { Input, InputTextPart } from "../../../agents/protocol/types.js";

import { parseSlashCommand } from "../../../codexConfig.js";
import { discoverSkills } from "../../../skills/loader.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";

export const PLANNER_DRAFT_SLASH_COMMAND = "draft";
export const PLANNER_DRAFT_SKILL_ID = "planner-slash-draft";

function extractPrimaryText(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .filter((part): part is InputTextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return String(input ?? "");
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function parsePlannerDraftSlashCommand(input: Input): { body: string } | null {
  const text = firstNonEmptyLine(extractPrimaryText(input));
  if (!text.startsWith("/")) {
    return null;
  }
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return null;
  }
  if (parsed.command.trim().toLowerCase() !== PLANNER_DRAFT_SLASH_COMMAND) {
    return null;
  }
  return { body: parsed.body };
}

export function injectPlannerDraftSkill(input: Input): Input {
  const marker = `$${PLANNER_DRAFT_SKILL_ID}`;
  const existing = extractPrimaryText(input);
  if (existing.includes(marker)) {
    return input;
  }

  if (typeof input === "string") {
    const trimmed = input.trimEnd();
    return `${trimmed}\n\n${marker}`;
  }

  if (Array.isArray(input)) {
    return [...input, { type: "text", text: `\n\n${marker}` }];
  }

  const trimmed = String(input ?? "").trimEnd();
  return `${trimmed}\n\n${marker}`;
}

/**
 * `/draft` is meaningless without its skill: the marker would resolve to
 * `<skill missing="true" />` and the planner would invent its own bundle format.
 * Callers check this first so the failure is visible instead of silent.
 */
export function isPlannerDraftSkillAvailable(cwd: string): boolean {
  try {
    const workspaceRoot = detectWorkspaceFrom(cwd || process.cwd());
    return discoverSkills(workspaceRoot).some((skill) => skill.name.toLowerCase() === PLANNER_DRAFT_SKILL_ID);
  } catch {
    return false;
  }
}

export function buildPlannerDraftSkillMissingMessage(): string {
  return (
    `/draft 不可用：缺少 \`${PLANNER_DRAFT_SKILL_ID}\` skill，交付格式无法保证。\n` +
    `请确认 ADS 安装完整（应存在 .agent/skills/${PLANNER_DRAFT_SKILL_ID}/SKILL.md），` +
    `或在 workspace 的 .agent/skills/ 下自行提供同名 skill。`
  );
}

