import type { ChatItem } from "./controllerTypes";

type AssistantItem = { id: string; text: string; beforeCommandIds?: string[] };

function turnRange(messages: ChatItem[], turnId: string): [number, number] | null {
  const start = messages.findIndex(message => message.role === "user" && message.id === turnId);
  if (start < 0) return null;
  const next = messages.findIndex((message, index) => index > start && message.role === "user");
  return [start + 1, next < 0 ? messages.length : next];
}

export function assistantMessageId(turnId: string, itemId: string): string {
  return `assistant-item:${JSON.stringify([turnId, itemId])}`;
}

/** Apply absolute provider item snapshots; equal text never identifies a message. */
export function applyAssistantItem(
  messages: ChatItem[], turnId: string, item: AssistantItem, streaming: boolean, ts?: number, completed = false,
): ChatItem[] | null {
  const range = turnRange(messages, turnId);
  if (!range) return null;
  const [start, end] = range;
  const id = assistantMessageId(turnId, item.id);
  const existing = messages.findIndex((message, index) => index >= start && index < end && message.id === id);
  const next = messages.slice();
  if (existing >= 0) {
    // A replayed delta must not reopen an already completed item.
    if (streaming && next[existing]!.assistantCompleted === true) return next;
    if (!item.text.trim()) return next.filter((_, index) => index !== existing);
    next[existing] = { ...next[existing]!, content: item.text, streaming, assistantCompleted: completed || next[existing]!.assistantCompleted };
    return next;
  }
  if (!item.text.trim()) return next;
  const unowned = next.slice(start, end).some(message =>
    message.role === "assistant" && message.kind === "text" && message.content.trim() && message.assistantAggregate === true);
  // A restored aggregate has no provider item IDs. Keep it until the terminal
  // result reconciles this turn, rather than duplicating its partial contents.
  if (unowned) return next;
  let insertAt = end;
  while (insertAt > start && next[insertAt - 1]!.id.startsWith("live-")) insertAt--;
  next.splice(insertAt, 0, {
    id, role: "assistant", kind: "text", content: item.text, streaming, ts,
    assistantTurnId: turnId, assistantCompleted: completed,
  });
  return next.filter((message, index) =>
    !(index >= start && index < end && message.role === "assistant" && message.streaming && !message.content.trim()));
}

/** Reconcile only the result's owning turn, including a restored aggregate. */
export function reconcileAssistantItems(
  messages: ChatItem[], turnId: string, value: unknown, output: string, ts?: number,
): ChatItem[] | null {
  const range = turnRange(messages, turnId);
  if (!range || !Array.isArray(value) || !value.length) return null;
  const items: AssistantItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.text !== "string") return null;
    if (entry.beforeCommandIds !== undefined
      && (!Array.isArray(entry.beforeCommandIds) || !entry.beforeCommandIds.every((id: unknown) => typeof id === "string"))) return null;
    items.push({ id: entry.id, text: entry.text, beforeCommandIds: entry.beforeCommandIds });
  }
  if (new Set(items.map(item => item.id)).size !== items.length
    || items.map(item => item.text).join("").trim() !== output.trim()) return null;
  const [start, end] = range;
  const owned = messages.slice(start, end).filter(message => message.role === "assistant" && message.kind === "text");
  if (owned.some(message => message.content.trim() && message.assistantAggregate === true)) {
    const ids = new Set(owned.map(message => message.id));
    const first = messages.findIndex(message => ids.has(message.id));
    const next = messages.filter(message => !ids.has(message.id));
    next.splice(first < 0 ? start : first, 0, {
      id: assistantMessageId(turnId, "aggregate"), role: "assistant", kind: "text",
      content: output, streaming: false, assistantAggregate: true, ts,
    });
    return next;
  }
  let next = messages;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const id = assistantMessageId(turnId, item.id);
    const present = next.some(message => message.id === id);
    next = applyAssistantItem(next, turnId, item, false, ts, true) ?? next;
    if (!present) {
      const inserted = next.findIndex(message => message.id === id);
      const following = items[index + 1];
      const neighborId = following ? assistantMessageId(turnId, following.id) : "";
      if (inserted >= 0) {
        const [message] = next.splice(inserted, 1);
        const nextRange = turnRange(next, turnId)!;
        const neighbor = next.findIndex((message, messageIndex) =>
          messageIndex >= nextRange[0] && messageIndex < nextRange[1]
          && (message.id === neighborId || (message.providerCommandId && item.beforeCommandIds?.includes(message.providerCommandId))));
        next.splice(neighbor < 0 ? inserted : neighbor, 0, message!);
      }
    }
  }
  return next;
}
