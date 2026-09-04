import type { ChatItem } from "../app/controllerTypes";
import { isLiveMessageId } from "../app/chatLive";

type ComparableChat = { role: ChatItem["role"]; kind: ChatItem["kind"]; content: string; command: string };

const LEGACY_STREAM_DISCONNECT_NOTICE = "[connection lost before this response finished; waiting for reconnect sync]";
export const STREAM_DISCONNECT_NOTICE = "[连接中断：这段回复尚未完成，正在等待重连同步]";
export const EXECUTE_DISCONNECT_NOTICE = "[连接中断：命令输出可能不完整，正在等待重连同步]";

function normalizeContentForMerge(text: string): string {
  return stripStreamingDisconnectNotice(String(text ?? "").replace(/\r\n/g, "\n"))
    .replace(new RegExp(`(?:^|\\n)${escapeRegExp(EXECUTE_DISCONNECT_NOTICE)}$`), "")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripStreamingDisconnectNotice(text: string): string {
  return String(text ?? "")
    .replace(new RegExp(`\\n\\n${escapeRegExp(STREAM_DISCONNECT_NOTICE)}$`), "")
    .replace(new RegExp(`\\n\\n${escapeRegExp(LEGACY_STREAM_DISCONNECT_NOTICE)}$`), "");
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
  if (local.role === "assistant" && (local.kind === "text" || local.kind === "thought")) return true;
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

function findLcsAlignment(
  localCmp: ComparableChat[],
  serverCmp: ComparableChat[],
): Array<{ localIdx: number; serverIdx: number }> {
  const n = localCmp.length;
  const m = serverCmp.length;
  if (n === m && localCmp.every((item, i) => comparableKey(item) === comparableKey(serverCmp[i]!))) {
    return localCmp.map((_, i) => ({ localIdx: i, serverIdx: i }));
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    const localKey = comparableKey(localCmp[i]!);
    for (let j = 0; j < m; j++) {
      if (localKey === comparableKey(serverCmp[j]!)) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const alignment: Array<{ localIdx: number; serverIdx: number }> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const localKey = comparableKey(localCmp[i - 1]!);
    const serverKey = comparableKey(serverCmp[j - 1]!);
    if (localKey === serverKey) {
      alignment.unshift({ localIdx: i - 1, serverIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i]![j - 1]! >= dp[i - 1]![j]!) {
      j--;
    } else {
      i--;
    }
  }

  return alignment;
}

function alignAndBackfillHistory(
  local: ChatItem[],
  server: ChatItem[],
  alignment: Array<{ localIdx: number; serverIdx: number }>,
): ChatItem[] {
  const result: ChatItem[] = [];
  let prevLocalIdx = -1;
  let prevServerIdx = -1;

  for (let k = 0; k <= alignment.length; k++) {
    const pair = alignment[k];
    const curLocalIdx = pair ? pair.localIdx : local.length;
    const curServerIdx = pair ? pair.serverIdx : server.length;

    const localSlice = local.slice(prevLocalIdx + 1, curLocalIdx);
    const serverSlice = server.slice(prevServerIdx + 1, curServerIdx);

    if (k === alignment.length) {
      let hydratedTail = localSlice;
      if (serverSlice.length === 0) {
        if (hydratedTail.length > 0 && hydratedTail.every(isDisconnectMarkedTail)) {
          hydratedTail = [];
        }
        result.push(...hydratedTail);
      } else {
        const firstNew = serverSlice[0]!;
        const reconciledTail = hydratedTail.filter(
          (item) => !isDisconnectMarkedTail(item) || canReplaceLocalTailWithServer(item, firstNew),
        );
        const lastLocal = reconciledTail[reconciledTail.length - 1];
        if (lastLocal && canReplaceLocalTailWithServer(lastLocal, firstNew)) {
          const localText = normalizeContentForMerge(lastLocal.content);
          const serverText = normalizeContentForMerge(firstNew.content);
          const replacesTruncatedTail =
            localText && serverText.startsWith(localText) && serverText.length > localText.length;
          const replacesEmptyExecuteNotice = lastLocal.kind === "execute" && !localText && Boolean(serverText);
          if (serverText && (replacesTruncatedTail || replacesEmptyExecuteNotice)) {
            const replaced = { ...firstNew, id: lastLocal.id };
            result.push(...reconciledTail.slice(0, -1), replaced, ...serverSlice.slice(1));
          } else {
            result.push(...reconciledTail, ...serverSlice);
          }
        } else {
          result.push(...reconciledTail, ...serverSlice);
        }
      }
    } else {
      const localSliceKeys = new Set(localSlice.map((item) => comparableKey(toComparable([item])[0]!)));
      const missingFromServer = serverSlice.filter(
        (item) => !localSliceKeys.has(comparableKey(toComparable([item])[0]!)),
      );
      result.push(...missingFromServer, ...localSlice);

      const anchorLocal = local[curLocalIdx]!;
      const anchorServer = server[curServerIdx]!;
      result.push(hydrateOverlappingExecuteMetadata([anchorLocal], 0, anchorServer)[0]!);
    }

    prevLocalIdx = curLocalIdx;
    prevServerIdx = curServerIdx;
  }

  return result;
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
  const alignment = findLcsAlignment(localCmp, serverCmp);
  if (alignment.length === 0) {
    const hasUserOrAssistant = localCmp.some((m) => m.role === "user" || m.role === "assistant");
    return hasUserOrAssistant ? local : server;
  }

  return alignAndBackfillHistory(local, server, alignment);
}

export function getSemanticCardRank(item: ChatItem): number {
  if (item.role === "user") return 0;
  if (item.kind === "plan") return 1;
  if (item.kind === "thought" || isLiveMessageId(item.id)) return 2;
  return 3;
}

type TurnBounds = { start: number; end: number };

function getCurrentTurnBounds(messages: ChatItem[]): TurnBounds {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index;
      break;
    }
  }
  if (start < 0) return { start: 0, end: messages.length };

  let end = messages.length;
  for (let index = start + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      end = index;
      break;
    }
  }
  return { start, end };
}

/**
 * Return the insertion point for the current process/live card.
 *
 * A process card is a mutable status snapshot. It belongs after plan/thought
 * cards and every other live card, but before execute, patch, or assistant
 * output. Keeping this anchor explicit means live updates remain ordered even
 * when the caller's setter does not perform semantic normalization.
 */
export function findProcessInsertIndex(messages: ChatItem[]): number {
  const { start, end } = getCurrentTurnBounds(messages);
  let insertAt = Math.min(end, start + 1);
  for (let index = start + 1; index < end; index += 1) {
    const item = messages[index]!;
    if (isLiveMessageId(item.id) || item.kind === "plan" || item.kind === "thought") {
      insertAt = index + 1;
      continue;
    }
    return index;
  }
  return insertAt;
}

/**
 * Return the insertion point for a command execution card in the current turn.
 * In an interleaved turn, execution blocks follow the explanation that triggered them,
 * remaining strictly ahead of live-progress indicators.
 */
export function findExecuteInsertIndex(messages: ChatItem[]): number {
  // Keep the execution card below the current turn's existing narrative.
  // Empty typing placeholders are intentionally included in this boundary so
  // an execution event cannot visually jump ahead of the assistant stream.
  return getCurrentTurnBounds(messages).end;
}

/** Return the end of the current turn for a newly-created assistant stream. */
export function findAssistantInsertIndex(messages: ChatItem[]): number {
  return getCurrentTurnBounds(messages).end;
}

export function normalizeTurnSemanticOrder(messages: ChatItem[]): ChatItem[] {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? messages : [];
  }

  // A reconnect or a legacy producer can replay the same fixed live id more
  // than once. Keep the newest snapshot so the renderer never receives
  // duplicate Vue keys or two visible process cards.
  const latestLiveIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const id = messages[index]!.id;
    if (isLiveMessageId(id)) latestLiveIndex.set(id, index);
  }
  const deduplicated = latestLiveIndex.size === 0
    ? messages
    : messages.filter((item, index) => !isLiveMessageId(item.id) || latestLiveIndex.get(item.id) === index);

  const result: ChatItem[] = [];
  let turnStart = -1;

  for (let i = 0; i < deduplicated.length; i++) {
    if (deduplicated[i]!.role === "user") {
      if (turnStart >= 0) {
        result.push(...sortSingleTurn(deduplicated.slice(turnStart, i)));
      } else if (i > 0) {
        result.push(...deduplicated.slice(0, i));
      }
      turnStart = i;
    }
  }

  if (turnStart >= 0) {
    result.push(...sortSingleTurn(deduplicated.slice(turnStart)));
  } else {
    result.push(...sortSingleTurn(deduplicated));
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
