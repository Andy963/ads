import type { ChatItem } from "../app/controllerTypes";

type ComparableChat = { role: ChatItem["role"]; kind: ChatItem["kind"]; content: string };

function normalizeContentForMerge(text: string): string {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

function withoutLiveAndExecute(items: ChatItem[], liveStepId: string): ChatItem[] {
  return items.filter((m) => m.id !== liveStepId && m.kind !== "execute");
}

function toComparable(items: ChatItem[]): ComparableChat[] {
  return items.map((m) => ({ role: m.role, kind: m.kind, content: normalizeContentForMerge(m.content) }));
}

function comparableKey(chat: ComparableChat): string {
  return `${chat.role}\u0000${chat.kind}\u0000${chat.content}`;
}

export function finalizeStreamingOnDisconnect(items: ChatItem[], liveStepId: string): ChatItem[] {
  let next = items.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const m = next[i]!;
    if (m.id === liveStepId) continue;
    if (m.role !== "assistant" || !m.streaming) continue;
    const content = String(m.content ?? "");
    if (!content.trim()) {
      next = [...next.slice(0, i), ...next.slice(i + 1)];
      continue;
    }
    next[i] = { ...m, streaming: false };
  }
  return next;
}

export function mergeHistoryFromServer(
  localMessages: ChatItem[],
  serverHistory: ChatItem[],
  liveStepId: string,
): ChatItem[] {
  const local = withoutLiveAndExecute(localMessages, liveStepId);
  const server = withoutLiveAndExecute(serverHistory, liveStepId);
  if (local.length === 0) return server;
  if (server.length === 0) return local;

  const localCmp = toComparable(local);
  const serverCmp = toComparable(server);
  const localComparableKeys = new Set(localCmp.map((item) => comparableKey(item)));
  let lastMatchedServerIdx = -1;

  // Find the newest server message that already exists locally; local history may have been trimmed.
  for (let s = serverCmp.length - 1; s >= 0; s--) {
    if (localComparableKeys.has(comparableKey(serverCmp[s]!))) {
      lastMatchedServerIdx = s;
      break;
    }
  }

  if (lastMatchedServerIdx < 0) {
    // If there is no overlap, avoid clobbering an existing UI transcript.
    // Only hydrate from server when the local view is effectively empty (system-only).
    const hasUserOrAssistant = localCmp.some((m) => m.role === "user" || m.role === "assistant");
    return hasUserOrAssistant ? local : server;
  }

  const tailStart = Math.min(server.length, Math.max(0, lastMatchedServerIdx + 1));
  const tail = server.slice(tailStart);
  if (tail.length === 0) return local;

  // If the local tail is a truncated version of the server's next message (common after disconnect),
  // replace it instead of duplicating it.
  const lastLocal = local[local.length - 1]!;
  const firstNew = tail[0]!;
  if (
    lastLocal.role === firstNew.role &&
    lastLocal.kind === firstNew.kind &&
    lastLocal.role === "assistant" &&
    lastLocal.kind === "text"
  ) {
    const localText = normalizeContentForMerge(lastLocal.content);
    const serverText = normalizeContentForMerge(firstNew.content);
    if (localText && serverText && serverText.startsWith(localText) && serverText.length > localText.length) {
      const replaced = { ...firstNew, id: lastLocal.id };
      return [...local.slice(0, -1), replaced, ...tail.slice(1)];
    }
  }

  return [...local, ...tail];
}
