import { finalizeStreamingOnDisconnect, mergeHistoryFromServer } from "../lib/chat_sync";
import {
  clearLiveActivityWindow,
  ingestCommandActivity,
  ingestExploredActivity,
  renderLiveActivityMarkdown,
} from "../lib/live_activity";

import type { AppContext, BufferedTaskChatEvent, ChatItem, IncomingImage, ProjectRuntime, QueuedPrompt } from "./controller";

export const LIVE_STEP_ID = "live-step";
export const LIVE_ACTIVITY_ID = "live-activity";
export const LIVE_MESSAGE_IDS = [LIVE_STEP_ID, LIVE_ACTIVITY_ID] as const;

export const TASK_CHAT_BUFFER_TTL_MS = 5 * 60_000;
export const TASK_CHAT_BUFFER_MAX_EVENTS = 64;

type PersistedPrompt = { clientMessageId: string; text: string; createdAt: number };

function isLiveMessageId(id: string): boolean {
  return (LIVE_MESSAGE_IDS as readonly string[]).includes(id);
}

function findFirstLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = idx < 0 ? at : Math.min(idx, at);
  }
  return idx;
}

function findLastLiveIndex(items: ChatItem[]): number {
  let idx = -1;
  for (const liveId of LIVE_MESSAGE_IDS) {
    const at = items.findIndex((m) => m.id === liveId);
    if (at < 0) continue;
    idx = Math.max(idx, at);
  }
  return idx;
}

function trimRightLine(line: string): string {
  return String(line ?? "").replace(/\s+$/, "");
}

export function createChatActions(ctx: AppContext) {
  const {
    queuedPrompts,
    runtimeOrActive,
    runtimeAgentBusy,
    safeJsonParse,
    maxChatMessages,
    maxExecutePreviewLines,
    maxRecentCommands,
    maxTurnCommands,
  } = ctx;
  const { randomId, randomUuid } = ctx;

  const pendingPromptStorageKey = (sessionId: string): string => {
    const normalized = String(sessionId ?? "").trim();
    return normalized ? `ads.pendingPrompt.${normalized}` : "ads.pendingPrompt.unknown";
  };

  const savePendingPrompt = (rt: ProjectRuntime, prompt: QueuedPrompt): void => {
    if (!rt.projectSessionId) return;
    if (prompt.images.length > 0) return;
    const key = pendingPromptStorageKey(rt.projectSessionId);
    const payload: PersistedPrompt = {
      clientMessageId: prompt.clientMessageId,
      text: prompt.text,
      createdAt: prompt.createdAt,
    };
    try {
      sessionStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // ignore
    }
  };

  const clearPendingPrompt = (rt: ProjectRuntime): void => {
    if (!rt.projectSessionId) return;
    const key = pendingPromptStorageKey(rt.projectSessionId);
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  };

  const restorePendingPrompt = (rt: ProjectRuntime): void => {
    if (!rt.projectSessionId) return;
    const key = pendingPromptStorageKey(rt.projectSessionId);
    const stored = safeJsonParse<PersistedPrompt>(sessionStorage.getItem(key));
    if (!stored) return;
    const clientMessageId = String(stored.clientMessageId ?? "").trim();
    const text = String(stored.text ?? "");
    if (!clientMessageId) return;
    const alreadyQueued = rt.queuedPrompts.value.some((q) => q.clientMessageId === clientMessageId);
    if (alreadyQueued) return;
    if (runtimeAgentBusy(rt)) return;
    rt.queuedPrompts.value = [
      { id: randomId("q"), clientMessageId, text, images: [], createdAt: Number(stored.createdAt) || Date.now() },
      ...rt.queuedPrompts.value,
    ];
  };

  const trimChatItems = (items: ChatItem[]): ChatItem[] => {
    const existing = Array.isArray(items) ? items : [];
    const liveById = new Map<string, ChatItem>();
    for (const liveId of LIVE_MESSAGE_IDS) {
      const msg = existing.find((m) => m.id === liveId) ?? null;
      if (msg) liveById.set(liveId, msg);
    }

    const nonLive = existing.filter((m) => !isLiveMessageId(m.id));
    const trimmed = nonLive.length <= maxChatMessages ? nonLive : nonLive.slice(nonLive.length - maxChatMessages);
    const liveBlock = LIVE_MESSAGE_IDS.map((id) => liveById.get(id)).filter(Boolean) as ChatItem[];
    if (liveBlock.length === 0) {
      return trimmed;
    }

    let insertAt = trimmed.length;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const m = trimmed[i]!;
      if (m.role === "assistant" && m.streaming) {
        insertAt = i;
        break;
      }
    }
    for (let i = 0; i < insertAt; i++) {
      if (trimmed[i]!.kind === "execute") {
        insertAt = i;
        break;
      }
    }

    return [...trimmed.slice(0, insertAt), ...liveBlock, ...trimmed.slice(insertAt)];
  };

  const setMessages = (items: ChatItem[], rt?: ProjectRuntime): void => {
    runtimeOrActive(rt).messages.value = trimChatItems(items);
  };

  const pushMessageBeforeLive = (item: Omit<ChatItem, "id">, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    const liveIndex = findFirstLiveIndex(existing);
    const next = { ...item, id: randomId("msg"), ts: item.ts ?? Date.now() };
    if (liveIndex < 0) {
      setMessages([...existing, next], state);
      return;
    }
    setMessages([...existing.slice(0, liveIndex), next, ...existing.slice(liveIndex)], state);
  };

  const pushRecentCommand = (command: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const trimmed = String(command ?? "").trim();
    if (!trimmed) return;
    const turn = [...state.turnCommands, trimmed];
    state.turnCommands = turn.slice(Math.max(0, turn.length - maxTurnCommands));
    const recent = [...state.recentCommands.value, trimmed];
    state.recentCommands.value = recent.slice(Math.max(0, recent.length - maxRecentCommands));
  };

  const resetConversation = (rt: ProjectRuntime, notice: string, keepLatestTurn = true): void => {
    const existing = rt.messages.value.slice();
    const withoutLive = existing.filter((m) => !isLiveMessageId(m.id));
    const tail = (() => {
      if (!keepLatestTurn) return [];
      for (let i = withoutLive.length - 1; i >= 0; i--) {
        if (withoutLive[i]!.role === "user") return withoutLive.slice(i);
      }
      return [];
    })();

    rt.recentCommands.value = [];
    rt.turnCommands = [];
    rt.executePreviewByKey.clear();
    rt.executeOrder = [];
    rt.seenCommandIds.clear();
    rt.pendingImages.value = [];
    rt.turnInFlight = false;
    clearStepLive(rt);

    const next: ChatItem[] = notice.trim()
      ? [{ id: randomId("sys"), role: "system", kind: "text", content: notice.trim() }, ...tail]
      : [...tail];
    setMessages(next, rt);
  };

  const recordChatClear = (reason: "thread_reset", source: string): void => {
    try {
      console.info("[ads][chat_clear]", { reason, source, ts: Date.now() });
    } catch {
      // ignore
    }
  };

  const threadReset = (
    rt: ProjectRuntime,
    params: {
      notice: string;
      warning?: string | null;
      keepLatestTurn?: boolean;
      clearBackendHistory?: boolean;
      resetThreadId?: boolean;
      source?: string;
    },
  ): void => {
    rt.threadWarning.value = params.warning ?? null;
    rt.ignoreNextHistory = true;
    resetConversation(rt, params.notice, params.keepLatestTurn ?? false);
    if (params.resetThreadId) {
      rt.activeThreadId.value = null;
    }
    if (params.clearBackendHistory) {
      rt.suppressNextClearHistoryResult = true;
      rt.ws?.clearHistory();
    }
    recordChatClear("thread_reset", params.source ?? "unknown");
  };

  const clearConversationForResume = (rt: ProjectRuntime): void => {
    rt.threadWarning.value = null;
    rt.ignoreNextHistory = false;
    resetConversation(rt, "", false);
    rt.activeThreadId.value = null;
    finalizeCommandBlock(rt);
  };

  const applyStreamingDisconnectCleanup = (rt: ProjectRuntime): void => {
    const existing = rt.messages.value.slice();
    const next = finalizeStreamingOnDisconnect(existing, LIVE_STEP_ID);
    if (next.length === existing.length && next.every((m, idx) => m === existing[idx])) return;
    setMessages(next, rt);
  };

  const applyMergedHistory = (serverHistory: ChatItem[], rt: ProjectRuntime): void => {
    const next = mergeHistoryFromServer(rt.messages.value, serverHistory, LIVE_STEP_ID);
    setMessages(next, rt);
  };

  const dropEmptyAssistantPlaceholder = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.kind === "text" && m.streaming && !String(m.content ?? "").trim()) {
        setMessages([...existing.slice(0, i), ...existing.slice(i + 1)], state);
        return;
      }
      if (m.role === "assistant" && m.streaming) {
        return;
      }
    }
  };

  const hasEmptyAssistantPlaceholder = (rt?: ProjectRuntime): boolean => {
    const state = runtimeOrActive(rt);
    return state.messages.value.some((m) => m.role === "assistant" && m.kind === "text" && m.streaming && !String(m.content ?? "").trim());
  };

  const hasAssistantAfterLastUser = (rt?: ProjectRuntime): boolean => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.filter((m) => !isLiveMessageId(m.id));
    let lastUserIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i]!.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return false;
    for (let i = existing.length - 1; i > lastUserIndex; i--) {
      const m = existing[i]!;
      if (m.role === "assistant" && String(m.content ?? "").trim()) {
        return true;
      }
    }
    return false;
  };

  const shouldIgnoreStepDelta = (delta: string): boolean => {
    const normalized = String(delta ?? "");
    if (!normalized) return true;
    if (normalized.length > 2000) return false;
    const trimmed = normalized.trim();
    if (!trimmed) return true;
    const firstLine = trimmed.split("\n")[0]!.trim().toLowerCase();
    if (firstLine.startsWith("[boot]") || firstLine.startsWith("[analysis]")) {
      return true;
    }
    return firstLine === "active" || firstLine === "thinking…" || firstLine === "thinking..." || firstLine === "working…";
  };

  const ingestCommand = (rawCmd: string, rt?: ProjectRuntime, id?: string | null): void => {
    const state = runtimeOrActive(rt);
    const cmd = String(rawCmd ?? "").trim();
    if (!cmd) return;

    if (id) {
      if (state.seenCommandIds.has(id)) return;
      state.seenCommandIds.add(id);
    }
    pushRecentCommand(cmd, state);
  };

  const commandKeyForWsEvent = (command: string, id: string | null): string | null => {
    const normalizedCmd = String(command ?? "").trim();
    if (!normalizedCmd) return null;
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) return normalizedCmd;
    return `${normalizedId}:${normalizedCmd}`;
  };

  const stripCommandHeader = (outputDelta: string, command: string): string => {
    const normalizedDelta = String(outputDelta ?? "");
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand) return normalizedDelta;
    const header = `$ ${normalizedCommand}\n`;
    if (normalizedDelta.startsWith(header)) {
      return normalizedDelta.slice(header.length);
    }
    return normalizedDelta;
  };

  const upsertExecuteBlock = (key: string, command: string, outputDelta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand) return;

    const existing = state.messages.value.slice();
    const current = state.executePreviewByKey.get(normalizedKey) ??
      (() => {
        const created = { key: normalizedKey, command: normalizedCommand, previewLines: [] as string[], totalLines: 0, remainder: "" };
        state.executePreviewByKey.set(normalizedKey, created);
        state.executeOrder = [...state.executeOrder, normalizedKey];
        return created;
      })();

    const cleanedDelta = stripCommandHeader(outputDelta, normalizedCommand).replace(/^\n+/, "");
    if (cleanedDelta) {
      const combined = (current.remainder + cleanedDelta).replace(/\r\n/g, "\n");
      const parts = combined.split("\n");
      current.remainder = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = trimRightLine(rawLine);
        if (!line) continue;
        current.totalLines += 1;
        if (current.previewLines.length < maxExecutePreviewLines) {
          current.previewLines.push(line);
        }
      }
    }

    const preview = current.previewLines.slice();
    if (preview.length < maxExecutePreviewLines) {
      const partial = trimRightLine(current.remainder);
      if (partial) preview.push(partial);
    }

    const hiddenLineCount = Math.max(0, current.totalLines - current.previewLines.length);
    const itemId = `exec:${normalizedKey}`;
    const nextItem: ChatItem = {
      id: itemId,
      role: "system",
      kind: "execute",
      content: preview.join("\n"),
      command: normalizedCommand,
      hiddenLineCount,
      streaming: true,
    };

    const existingIdx = existing.findIndex((m) => m.id === itemId);
    if (existingIdx >= 0) {
      existing[existingIdx] = nextItem;
      setMessages(existing.slice(), state);
      return;
    }

    const lastLiveIndex = findLastLiveIndex(existing);
    let insertAt = lastLiveIndex < 0 ? existing.length : lastLiveIndex + 1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        insertAt = Math.min(insertAt, i);
        break;
      }
    }
    if (lastLiveIndex >= 0) {
      insertAt = Math.max(insertAt, lastLiveIndex + 1);
    }

    let lastExecuteIdx = -1;
    for (let i = 0; i < insertAt; i++) {
      if (existing[i]!.kind === "execute") {
        lastExecuteIdx = i;
      }
    }
    if (lastExecuteIdx >= 0) insertAt = lastExecuteIdx + 1;

    setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);

    if (state.executeOrder.length > maxTurnCommands) {
      const overflow = state.executeOrder.length - maxTurnCommands;
      const toDrop = state.executeOrder.slice(0, overflow);
      state.executeOrder = state.executeOrder.slice(overflow);
      for (const k of toDrop) {
        state.executePreviewByKey.delete(k);
      }
      const pruned = state.messages.value.filter(
        (m) => !(m.kind === "execute" && toDrop.includes(String(m.id).slice("exec:".length))),
      );
      setMessages(pruned, state);
    }
  };

  const finalizeCommandBlock = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    let insertAt = -1;
    const withoutExecute: ChatItem[] = [];
    for (let i = 0; i < existing.length; i++) {
      const m = existing[i]!;
      if (m.kind === "execute") {
        if (insertAt < 0) insertAt = withoutExecute.length;
        continue;
      }
      withoutExecute.push(m);
    }

    const commands = state.turnCommands.slice();
    const content = commands.map((c) => `$ ${c}`).join("\n").trim();

    state.recentCommands.value = [];
    state.turnCommands = [];
    state.executePreviewByKey.clear();
    state.executeOrder = [];
    state.seenCommandIds.clear();

    if (!content) {
      if (withoutExecute.length !== existing.length) setMessages(withoutExecute, state);
      return;
    }

    if (insertAt < 0) {
      const liveIndex = findFirstLiveIndex(withoutExecute);
      insertAt = liveIndex < 0 ? withoutExecute.length : liveIndex;
      for (let i = withoutExecute.length - 1; i >= 0; i--) {
        const m = withoutExecute[i]!;
        if (isLiveMessageId(m.id)) continue;
        if (m.role === "assistant" && m.streaming) {
          insertAt = Math.min(insertAt, i);
          break;
        }
      }
    }

    const item: ChatItem = { id: randomId("cmd"), role: "system", kind: "command", content, streaming: false };
    setMessages([...withoutExecute.slice(0, insertAt), item, ...withoutExecute.slice(insertAt)], state);
  };

  const removeQueuedPrompt = (id: string): void => {
    const target = String(id ?? "").trim();
    if (!target) return;
    queuedPrompts.value = queuedPrompts.value.filter((q) => q.id !== target);
  };

  const enqueueMainPrompt = (text: string, images: IncomingImage[]): void => {
    const content = String(text ?? "").trim();
    const imgs = Array.isArray(images) ? images : [];
    if (!content && imgs.length === 0) return;
    queuedPrompts.value = [
      ...queuedPrompts.value,
      { id: randomId("q"), clientMessageId: randomUuid(), text: content, images: imgs, createdAt: Date.now() },
    ];
    flushQueuedPrompts();
  };

  const flushQueuedPrompts = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    if (runtimeAgentBusy(state)) return;
    if (!state.connected.value) return;
    if (!state.ws) return;
    if (state.queuedPrompts.value.length === 0) return;

    const next = state.queuedPrompts.value[0]!;
    state.queuedPrompts.value = state.queuedPrompts.value.slice(1);

    try {
      const display =
        next.text && next.images.length > 0
          ? `${next.text}\n\n[图片 x${next.images.length}]`
          : next.text
            ? next.text
            : `[图片 x${next.images.length}]`;

      finalizeCommandBlock(state);
      clearStepLive(state);

      pushMessageBeforeLive({ role: "user", kind: "text", content: display }, state);
      pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true }, state);
      state.busy.value = true;
      state.turnInFlight = true;
      state.pendingAckClientMessageId = next.clientMessageId;
      savePendingPrompt(state, next);
      state.ws.sendPrompt(next.images.length > 0 ? { text: next.text, images: next.images } : next.text, next.clientMessageId);
    } catch {
      state.queuedPrompts.value = [next, ...state.queuedPrompts.value];
    }
  };

  const upsertStreamingDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    dropEmptyAssistantPlaceholder(state);
    const existing = state.messages.value.slice();
    let streamIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        streamIndex = i;
        break;
      }
    }
    if (streamIndex >= 0) {
      existing[streamIndex]!.content += chunk;
      setMessages(existing.slice(), state);
      return;
    }

    const nextItem: ChatItem = {
      id: randomId("stream"),
      role: "assistant",
      kind: "text",
      content: chunk,
      streaming: true,
      ts: Date.now(),
    };
    const lastLiveIndex = findLastLiveIndex(existing);
    if (lastLiveIndex < 0) {
      setMessages([...existing, nextItem], state);
      return;
    }
    const insertAt = Math.min(existing.length, lastLiveIndex + 1);
    setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);
  };

  const trimToLastLines = (text: string, maxLines: number, maxChars = 2500): string => {
    const normalized = String(text ?? "");
    const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
    const lines = recent.split("\n");
    if (lines.length <= maxLines) return recent;
    return lines.slice(lines.length - maxLines).join("\n");
  };

  const upsertStepLiveDelta = (delta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    dropEmptyAssistantPlaceholder(state);
    const chunk = String(delta ?? "");
    if (!chunk) return;
    const existing = state.messages.value.slice();
    const idx = existing.findIndex((m) => m.id === LIVE_STEP_ID);
    const current = idx >= 0 ? existing[idx]!.content : "";
    const nextText = trimToLastLines(current + chunk, 14);
    const nextItem: ChatItem = {
      id: LIVE_STEP_ID,
      role: "assistant",
      kind: "text",
      content: nextText,
      streaming: true,
      ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
    };
    const withoutStep = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

    let insertAt = withoutStep.length;
    for (let i = withoutStep.length - 1; i >= 0; i--) {
      const m = withoutStep[i]!;
      if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
        insertAt = i;
        break;
      }
    }

    const next = [...withoutStep.slice(0, insertAt), nextItem, ...withoutStep.slice(insertAt)];
    setMessages(next, state);
  };

  const upsertLiveActivity = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    dropEmptyAssistantPlaceholder(state);
    const markdown = renderLiveActivityMarkdown(state.liveActivity);

    const existing = state.messages.value.slice();

    if (!markdown) {
      const next = existing.filter((m) => m.id !== LIVE_ACTIVITY_ID);
      if (next.length === existing.length) return;
      setMessages(next, state);
      return;
    }

    const idx = existing.findIndex((m) => m.id === LIVE_ACTIVITY_ID);
    const nextItem: ChatItem = {
      id: LIVE_ACTIVITY_ID,
      role: "assistant",
      kind: "text",
      content: markdown,
      streaming: true,
      ts: (idx >= 0 ? existing[idx]!.ts : null) ?? Date.now(),
    };
    const withoutActivity = idx >= 0 ? [...existing.slice(0, idx), ...existing.slice(idx + 1)] : existing;

    const stepIdx = withoutActivity.findIndex((m) => m.id === LIVE_STEP_ID);
    let insertAt = stepIdx >= 0 ? stepIdx : withoutActivity.length;
    if (stepIdx < 0) {
      for (let i = withoutActivity.length - 1; i >= 0; i--) {
        const m = withoutActivity[i]!;
        if (m.role === "assistant" && m.streaming && !isLiveMessageId(m.id)) {
          insertAt = i;
          break;
        }
      }
    }

    const next = [...withoutActivity.slice(0, insertAt), nextItem, ...withoutActivity.slice(insertAt)];
    setMessages(next, state);
  };

  const clearStepLive = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    clearLiveActivityWindow(state.liveActivity);
    const existing = state.messages.value.slice();
    const next = existing.filter((m) => !isLiveMessageId(m.id));
    if (next.length === existing.length) return;
    setMessages(next, state);
  };

  const finalizeAssistant = (content: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const text = String(content ?? "").replace(/\r\n/g, "\n");
    const trimmedText = text.trim();
    const existing = state.messages.value.slice();
    let streamIndex = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        streamIndex = i;
        break;
      }
    }
    if (streamIndex >= 0) {
      const current = String(existing[streamIndex]!.content ?? "");
      if (!trimmedText) {
        if (!current.trim()) {
          setMessages([...existing.slice(0, streamIndex), ...existing.slice(streamIndex + 1)], state);
          return;
        }
        existing[streamIndex]!.streaming = false;
        setMessages(existing.slice(), state);
        return;
      }
      existing[streamIndex]!.content = text;
      existing[streamIndex]!.streaming = false;
      setMessages(existing.slice(), state);
      return;
    }

    if (!trimmedText) return;
    const normalizedText = trimmedText;
    const lastNonLive = (() => {
      for (let i = existing.length - 1; i >= 0; i--) {
        const m = existing[i]!;
        if (isLiveMessageId(m.id)) continue;
        return m;
      }
      return null;
    })();
    if (lastNonLive?.role === "assistant" && lastNonLive.kind === "text") {
      const prev = String(lastNonLive.content ?? "").replace(/\r\n/g, "\n").trim();
      if (prev === normalizedText) {
        return;
      }
    }

    pushMessageBeforeLive({ role: "assistant", kind: "text", content: text }, state);
  };

  const pruneTaskChatBuffer = (rt: ProjectRuntime): void => {
    const now = Date.now();
    for (const [taskId, entry] of rt.taskChatBufferByTaskId.entries()) {
      if (!taskId) {
        rt.taskChatBufferByTaskId.delete(taskId);
        continue;
      }
      if (entry.events.length === 0 || now - entry.firstTs > TASK_CHAT_BUFFER_TTL_MS) {
        rt.taskChatBufferByTaskId.delete(taskId);
      }
    }
  };

  const bufferTaskChatEvent = (taskId: string, event: BufferedTaskChatEvent, rt: ProjectRuntime): void => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    pruneTaskChatBuffer(rt);
    const existing = rt.taskChatBufferByTaskId.get(id);
    if (!existing) {
      rt.taskChatBufferByTaskId.set(id, { firstTs: Date.now(), events: [event] });
      return;
    }
    const nextEvents = [...existing.events, event].slice(-TASK_CHAT_BUFFER_MAX_EVENTS);
    rt.taskChatBufferByTaskId.set(id, { firstTs: existing.firstTs, events: nextEvents });
  };

  const markTaskChatStarted = (taskId: string, rt: ProjectRuntime): void => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    if (!rt.startedTaskIds.has(id)) {
      rt.startedTaskIds.add(id);
    }
    const buffered = rt.taskChatBufferByTaskId.get(id);
    if (!buffered || buffered.events.length === 0) return;
    rt.taskChatBufferByTaskId.delete(id);

    for (const ev of buffered.events) {
      if (ev.kind === "message") {
        if (ev.role === "assistant") {
          finalizeAssistant(ev.content, rt);
        } else {
          pushMessageBeforeLive({ role: ev.role, kind: "text", content: ev.content }, rt);
        }
        continue;
      }
      if (ev.kind === "delta") {
        if (ev.source === "step") {
          upsertStepLiveDelta(ev.delta, rt);
        } else {
          upsertStreamingDelta(ev.delta, rt);
        }
        continue;
      }
      if (ev.kind === "command") {
        ingestCommand(ev.command, rt, null);
        continue;
      }
    }
  };

  return {
    isLiveMessageId,
    findFirstLiveIndex,
    findLastLiveIndex,
    savePendingPrompt,
    clearPendingPrompt,
    restorePendingPrompt,
    trimChatItems,
    setMessages,
    pushMessageBeforeLive,
    pushRecentCommand,
    resetConversation,
    threadReset,
    clearConversationForResume,
    applyStreamingDisconnectCleanup,
    applyMergedHistory,
    dropEmptyAssistantPlaceholder,
    hasEmptyAssistantPlaceholder,
    hasAssistantAfterLastUser,
    shouldIgnoreStepDelta,
    ingestCommand,
    ingestCommandActivity,
    ingestExploredActivity,
    commandKeyForWsEvent,
    upsertExecuteBlock,
    finalizeCommandBlock,
    removeQueuedPrompt,
    enqueueMainPrompt,
    flushQueuedPrompts,
    upsertStreamingDelta,
    upsertStepLiveDelta,
    upsertLiveActivity,
    clearStepLive,
    finalizeAssistant,
    pruneTaskChatBuffer,
    bufferTaskChatEvent,
    markTaskChatStarted,
  };
}

export type ChatActions = ReturnType<typeof createChatActions>;
