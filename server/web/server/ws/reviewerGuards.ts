/**
 * Reviewer input extraction and write-like request detection.
 *
 * Pure helpers that classify incoming Input values for the reviewer lane,
 * enforcing the read-only invariant by detecting write-like intents.
 */

import type { Input } from "../../../agents/protocol/types.js";

export function extractInputText(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return String(input ?? "");
  }
  return input
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

export const REVIEWER_WRITE_LIKE_PATTERNS: RegExp[] = [
  /^\s*\/draft\b/i,
  /^\s*\/(?:spec|adr|schedule)\b/i,
  /\b(?:write|edit|modify|change|update|create|delete|remove|rename|implement|fix|apply)\b.{0,80}\b(?:file|files|code|patch|diff|spec|draft|adr|schedule|workspace|worktree)\b/i,
  /\b(?:create|write|save|generate)\b.{0,40}\b(?:draft|spec|adr|schedule)\b/i,
  /\b(?:open|submit)\b.{0,40}\b(?:pr|pull request)\b/i,
];

export function isReviewerWriteLikeRequest(input: Input): boolean {
  const text = extractInputText(input);
  return Boolean(text) && REVIEWER_WRITE_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}
