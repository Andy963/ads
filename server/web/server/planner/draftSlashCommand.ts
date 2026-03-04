import type { Input, InputTextPart } from "../../../agents/protocol/types.js";

import { parseSlashCommand } from "../../../codexConfig.js";

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

