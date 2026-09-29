import type { ChatItem } from "../app/controllerTypes";

export const TURN_FAILURE_CARD_PREFIX = "turn-failure:";

const USER_ABORT_MARKERS = [
  "\u5df2\u4e2d\u65ad",
  "\u7528\u6237\u4e2d\u65ad",
  "Prompt execution was interrupted before completion. Retry explicitly to resume with incomplete-turn recovery.",
];

export function isUserAbortFailure(content: string, aborted?: unknown): boolean {
  if (aborted === true) return true;
  const normalized = String(content ?? "").trim();
  return USER_ABORT_MARKERS.some((marker) => normalized.includes(marker));
}

export function turnFailureCardId(userMessageId: string): string {
  return `${TURN_FAILURE_CARD_PREFIX}${userMessageId}`;
}

export function findLastUserMessageIndex(items: ChatItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.role === "user") return index;
  }
  return -1;
}

/**
 * Anchor a persistent failure record to the turn that failed. The record id
 * is derived from the user message id so repeated failures of the same turn
 * replace the previous record instead of stacking duplicates, and so live
 * errors and history replay converge on the same retry target.
 *
 * The anchor is the failed turn's own user message when its id is known (the
 * turn that was awaiting ack when the error arrived); otherwise it falls back
 * to the newest user message, which during sequential history replay is the
 * turn the error entry belongs to.
 */
export function upsertTurnFailureCard(
  items: ChatItem[],
  content: string,
  ts?: number,
  anchorUserMessageId?: string,
): ChatItem[] {
  const anchorId = String(anchorUserMessageId ?? "").trim();
  const anchored = anchorId
    ? items.find((item) => item.role === "user" && item.id === anchorId)
    : undefined;
  const userIndex = anchored
    ? items.indexOf(anchored)
    : findLastUserMessageIndex(items);
  if (userIndex < 0) return items;
  const userItem = items[userIndex]!;
  const cardId = turnFailureCardId(userItem.id);
  const next = items.filter((item) => item.id !== cardId);
  next.push({
    id: cardId,
    role: "system",
    kind: "error",
    content,
    ts: ts ?? Date.now(),
  });
  return next;
}
