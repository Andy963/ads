import type { ChatItem } from "../app/controllerTypes";
import { isLiveMessageId } from "../app/chatLive";

type ComparableChat = { role: ChatItem["role"]; kind: ChatItem["kind"]; content: string; command: string };

const LEGACY_STREAM_DISCONNECT_NOTICE = "[connection lost before this response finished; waiting for reconnect sync]";
export const STREAM_DISCONNECT_NOTICE = "[连接中断：这段回复尚未完成，正在等待重连同步]";
export const EXECUTE_DISCONNECT_NOTICE = "[连接中断：命令输出可能不完整，正在等待重连同步]";

function normalizeContentForMerge(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(new RegExp(`\\n\\n${escapeRegExp(STREAM_DISCONNECT_NOTICE)}$`), "")
    .replace(new RegExp(`\\n\\n${escapeRegExp(LEGACY_STREAM_DISCONNECT_NOTICE)}$`), "")
    .replace(new RegExp(`(?:^|\\n)${escapeRegExp(EXECUTE_DISCONNECT_NOTICE)}$`), "")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTransientExecutePreview(item: ChatItem): boolean {
  return item.kind === "execute" && (item.streaming === true || String(item.id ?? "").startsWith("exec:"));
}

function withoutLiveAndTransientExecute(items: ChatItem[], liveStepId: string): ChatItem[] {
  const filtered = items.filter((m) => m.id !== liveStepId && !isTransientExecutePreview(m));
  const lastPlanIndex = new Map<string, number>();
  for (let i = 0; i < filtered.length; i += 1) {
    const planId = String(filtered[i]?.plan?.planId ?? "").trim();
    if (planId) lastPlanIndex.set(planId, i);
  }
  return filtered.filter((item, index) => {
    const planId = String(item.plan?.planId ?? "").trim();
    return !planId || lastPlanIndex.get(planId) === index;
  });
}

function preferServerPlanSnapshots(local: ChatItem[], server: ChatItem[]): ChatItem[] {
  const serverPlanIds = new Set(
    server.map((item) => String(item.plan?.planId ?? "").trim()).filter(Boolean),
  );
  if (serverPlanIds.size === 0) return local;
  return local.filter((item) => {
    const planId = String(item.plan?.planId ?? "").trim();
    return !planId || !serverPlanIds.has(planId);
  });
}

function toComparable(items: ChatItem[]): ComparableChat[] {
  return items.map((m) => ({
    role: m.role,
    kind: m.kind,
    content: normalizeContentForMerge(m.content),
    command: m.kind === "execute" ? String(m.command ?? "").trim() : "",
  }));
}

function comparableKey(chat: ComparableChat): string {
  return `${chat.role}\u0000${chat.kind}\u0000${chat.command}\u0000${chat.content}`;
}

function canReplaceLocalTailWithServer(local: ChatItem, server: ChatItem): boolean {
  if (local.role !== server.role || local.kind !== server.kind) return false;
  if (local.role === "assistant" && local.kind === "text") return true;
  if (local.kind !== "execute") return false;

  const localCommand = String(local.command ?? "").trim();
  const serverCommand = String(server.command ?? "").trim();
  return Boolean(localCommand) && localCommand === serverCommand;
}

function shouldHydrateExecuteMetadata(local: ChatItem, server: ChatItem): boolean {
  if (local.kind !== "execute" || server.kind !== "execute") return false;
  const localCommand = String(local.command ?? "").trim();
  const serverCommand = String(server.command ?? "").trim();
  if (!localCommand || localCommand !== serverCommand) return false;
  return (
    Boolean(server.fullContent && server.fullContent !== local.fullContent) ||
    server.hiddenLineCount !== local.hiddenLineCount ||
    String(local.content ?? "").includes(EXECUTE_DISCONNECT_NOTICE)
  );
}

function isDisconnectMarkedTail(item: ChatItem): boolean {
  const content = String(item.content ?? "");
  if (item.role === "assistant" && item.kind === "text") {
    return content.includes(STREAM_DISCONNECT_NOTICE) || content.includes(LEGACY_STREAM_DISCONNECT_NOTICE);
  }
  if (item.kind === "execute") {
    return content.includes(EXECUTE_DISCONNECT_NOTICE);
  }
  return false;
}

function hydrateOverlappingExecuteMetadata(local: ChatItem[], localIdx: number, serverItem: ChatItem): ChatItem[] {
  const localItem = local[localIdx];
  if (!localItem || !shouldHydrateExecuteMetadata(localItem, serverItem)) return local;
  const next = local.slice();
  next[localIdx] = {
    ...localItem,
    content: String(localItem.content ?? "").includes(EXECUTE_DISCONNECT_NOTICE)
      ? serverItem.content
      : localItem.content,
    fullContent: serverItem.fullContent ?? localItem.fullContent,
    hiddenLineCount: serverItem.hiddenLineCount ?? localItem.hiddenLineCount,
  };
  return next;
}

export function finalizeStreamingOnDisconnect(items: ChatItem[], liveStepId: string): ChatItem[] {
  let next = items.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const m = next[i]!;
    if (m.id === liveStepId) continue;
    if (m.kind === "execute" && m.streaming) {
      const content = String(m.content ?? "");
      const markedContent = content.includes(EXECUTE_DISCONNECT_NOTICE)
        ? content
        : content.trim()
          ? `${content.trimEnd()}\n${EXECUTE_DISCONNECT_NOTICE}`
          : EXECUTE_DISCONNECT_NOTICE;
      next[i] = { ...m, streaming: false, content: markedContent };
      continue;
    }
    if (m.role !== "assistant" || !m.streaming) continue;
    const content = String(m.content ?? "");
    if (!content.trim()) {
      next = [...next.slice(0, i), ...next.slice(i + 1)];
      continue;
    }
    const markedContent = content.includes(STREAM_DISCONNECT_NOTICE) || content.includes(LEGACY_STREAM_DISCONNECT_NOTICE)
      ? content
      : `${content.trimEnd()}\n\n${STREAM_DISCONNECT_NOTICE}`;
    next[i] = { ...m, streaming: false, content: markedContent };
  }
  return next;
}

export function mergeHistoryFromServer(
  localMessages: ChatItem[],
  serverHistory: ChatItem[],
  liveStepId: string,
): ChatItem[] {
  const server = withoutLiveAndTransientExecute(serverHistory, liveStepId);
  const local = preferServerPlanSnapshots(withoutLiveAndTransientExecute(localMessages, liveStepId), server);
  if (local.length === 0) return server;
  if (server.length === 0) return local;

  const localCmp = toComparable(local);
  const serverCmp = toComparable(server);
  const localComparableKeyToIdx = new Map<string, number>();
  for (let i = 0; i < localCmp.length; i += 1) {
    localComparableKeyToIdx.set(comparableKey(localCmp[i]!), i);
  }
  let lastMatchedServerIdx = -1;
  let lastMatchedLocalIdx = -1;

  // Find the newest server message that already exists locally; local history may have been trimmed.
  for (let s = serverCmp.length - 1; s >= 0; s--) {
    const localIdx = localComparableKeyToIdx.get(comparableKey(serverCmp[s]!));
    if (localIdx !== undefined) {
      lastMatchedServerIdx = s;
      lastMatchedLocalIdx = localIdx;
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
  let hydratedLocal = hydrateOverlappingExecuteMetadata(local, lastMatchedLocalIdx, server[lastMatchedServerIdx]!);
  if (tail.length === 0) {
    const localTail = hydratedLocal.slice(lastMatchedLocalIdx + 1);
    if (localTail.length > 0 && localTail.every(isDisconnectMarkedTail)) {
      return hydratedLocal.slice(0, lastMatchedLocalIdx + 1);
    }
    return hydratedLocal;
  }

  const firstNew = tail[0]!;
  const localPrefix = hydratedLocal.slice(0, lastMatchedLocalIdx + 1);
  const localTail = hydratedLocal.slice(lastMatchedLocalIdx + 1);
  const reconciledTail = localTail.filter(
    (item) => !isDisconnectMarkedTail(item) || canReplaceLocalTailWithServer(item, firstNew),
  );
  if (reconciledTail.length !== localTail.length) {
    hydratedLocal = [...localPrefix, ...reconciledTail];
  }

  // If the local tail is a truncated version of the server's next message (common after disconnect),
  // replace it instead of duplicating it.
  const lastLocal = hydratedLocal[hydratedLocal.length - 1]!;
  if (canReplaceLocalTailWithServer(lastLocal, firstNew)) {
    const localText = normalizeContentForMerge(lastLocal.content);
    const serverText = normalizeContentForMerge(firstNew.content);
    const replacesTruncatedTail = localText && serverText.startsWith(localText) && serverText.length > localText.length;
    const replacesEmptyExecuteNotice = lastLocal.kind === "execute" && !localText && Boolean(serverText);
    if (serverText && (replacesTruncatedTail || replacesEmptyExecuteNotice)) {
      const replaced = { ...firstNew, id: lastLocal.id };
      return [...hydratedLocal.slice(0, -1), replaced, ...tail.slice(1)];
    }
  }

  return [...hydratedLocal, ...tail];
}

export function getSemanticCardRank(item: ChatItem): number {
  if (item.role === "user") return 0;
  if (item.kind === "plan") return 1;
  if (isLiveMessageId(item.id)) return 1.5;
  if (item.kind === "execute") return 2;
  if (item.kind === "patch") return 3;
  if (item.role === "assistant") return 4;
  return 5;
}

export function normalizeTurnSemanticOrder(messages: ChatItem[]): ChatItem[] {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? messages : [];
  }

  const result: ChatItem[] = [];
  let turnStart = -1;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      if (turnStart >= 0) {
        result.push(...sortSingleTurn(messages.slice(turnStart, i)));
      } else if (i > 0) {
        result.push(...messages.slice(0, i));
      }
      turnStart = i;
    }
  }

  if (turnStart >= 0) {
    result.push(...sortSingleTurn(messages.slice(turnStart)));
  } else {
    result.push(...sortSingleTurn(messages));
  }

  return result;
}

function sortSingleTurn(turnItems: ChatItem[]): ChatItem[] {
  if (turnItems.length <= 1) return turnItems;

  const indexed = turnItems.map((item, originalIndex) => ({
    item,
    originalIndex,
    rank: getSemanticCardRank(item),
  }));

  indexed.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return a.originalIndex - b.originalIndex;
  });

  return indexed.map((x) => x.item);
}
