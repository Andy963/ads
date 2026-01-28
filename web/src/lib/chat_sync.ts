export type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  streaming?: boolean;
};

type ComparableChat = { role: ChatItem["role"]; kind: ChatItem["kind"]; content: string };

function normalizeContentForMerge(text: string): string {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

function toComparable(items: ChatItem[], liveStepId: string): ComparableChat[] {
  return items
    .filter((m) => m.id !== liveStepId && m.kind !== "execute")
    .map((m) => ({ role: m.role, kind: m.kind, content: normalizeContentForMerge(m.content) }));
}

function comparableEquals(a: ComparableChat, b: ComparableChat): boolean {
  return a.role === b.role && a.kind === b.kind && a.content === b.content;
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
  const local = localMessages.filter((m) => m.id !== liveStepId && m.kind !== "execute");
  const server = serverHistory.filter((m) => m.id !== liveStepId && m.kind !== "execute");
  if (local.length === 0) return server;
  if (server.length === 0) return local;

  const localCmp = toComparable(local, liveStepId);
  const serverCmp = toComparable(server, liveStepId);
  let lastMatchedServerIdx = -1;

  // Find the newest server message that already exists locally; local history may have been trimmed.
  for (let s = serverCmp.length - 1; s >= 0; s--) {
    const target = serverCmp[s]!;
    let found = false;
    for (let l = localCmp.length - 1; l >= 0; l--) {
      if (comparableEquals(target, localCmp[l]!)) {
        found = true;
        break;
      }
    }
    if (found) {
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
