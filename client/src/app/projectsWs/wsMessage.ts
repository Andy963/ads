import type { ChatActions } from "../chat";
import type {
  ChatItem,
  ChatPatch,
  ChatPatchFile,
  ChatPlan,
  ChatPlanItem,
  ChatPlanItemStatus,
  LaneStatus,
  ProjectRuntime,
  ProjectTab,
  ResumableSession,
  WorkspaceState,
} from "../controllerTypes";
import type { TaskBundleDraft } from "../../api/types";
import {
  buildModelIdStorageKey,
  buildReasoningEffortStorageKey,
  normalizeModelId,
  normalizeReasoningEffort,
} from "../../lib/chatPreferences";
import { splitUnifiedDiffByPath } from "../../lib/patchDiff";
import { normalizeTurnSemanticOrder } from "../../lib/chat_sync";

import { listTaskBundleDrafts, removeTaskBundleDraft, upsertTaskBundleDraft } from "../taskBundleDraftsState";
import { isReconnectNotice } from "./reconnectNotice";

type Ref<T> = { value: T };

const HISTORY_EXECUTE_PREVIEW_LINES = 3;
const THREAD_RESUMED_NOTICE = "已恢复后端上下文线程。";
const HISTORY_INJECTION_NOTICE = "没有可复用的原生会话，下一轮发送时会注入最近聊天历史来延续上下文。";
const TRANSIENT_RETRY_NOTICE_ID = "transient-retry-notice";
const BACKEND_WAITING_STATUS_MESSAGES = new Set([
  "上一轮仍在执行，正在等待后端结果。",
  "上一轮仍在执行，正在等待后端结果…",
]);
const SELECTION_NOTICE_PATTERNS = [
  /^已切换到代理:\s*.+$/,
  /^模型已从.+切换到.+，已启动新会话线程。?$/,
  /^模型已切换到.+，已启动新会话线程。?$/,
];

function stripSelectionChangeNotices(content: string): string {
  return String(content ?? "")
    .split("\n")
    .filter((line) => !SELECTION_NOTICE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .trim();
}

function decodeHistoryKindValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function parseExecutionFromHistoryKind(kind: string): ChatItem["execution"] | undefined {
  const marker = ";prompt_meta:";
  const markerIndex = kind.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const raw = kind.slice(markerIndex + marker.length);
  const execution: NonNullable<ChatItem["execution"]> = {};
  for (const part of raw.split(",")) {
    const [keyRaw, valueRaw = ""] = part.split("=");
    const key = String(keyRaw ?? "").trim();
    const value = decodeHistoryKindValue(valueRaw).trim();
    if (!key || !value) continue;
    if (key === "agent") execution.agentId = value;
    else if (key === "model") execution.model = value;
    else if (key === "effort") execution.modelReasoningEffort = value;
    else if (key === "eff_agent") execution.effectiveAgentId = value;
    else if (key === "eff_model") execution.effectiveModel = value;
    else if (key === "eff_effort") execution.effectiveModelReasoningEffort = value;
  }
  return Object.keys(execution).length > 0 ? execution : undefined;
}

function parseClientMessageIdFromHistoryKind(kind: string): string {
  const prefix = "client_message_id:";
  if (!kind.startsWith(prefix)) return "";
  const tail = kind.slice(prefix.length);
  const separator = tail.indexOf(";");
  return (separator >= 0 ? tail.slice(0, separator) : tail).trim();
}

function contextModeNotice(contextMode: string): string {
  if (contextMode === "thread_resumed") return THREAD_RESUMED_NOTICE;
  if (contextMode === "history_injection") return HISTORY_INJECTION_NOTICE;
  return "";
}

function replayedLaneStatus(kind: string, content: string): LaneStatus | null {
  if (kind === "error") {
    return { kind: "error", message: content };
  }
  if (kind !== "status") {
    return null;
  }
  if (content.startsWith("当前工作目录:") || content.startsWith("已切换到:")) {
    return { kind: "info", message: content };
  }
  return null;
}

function hasTerminalHistoryTail(items: unknown[]): boolean {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    const entry = items[idx];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const role = String(rec.role ?? "");
    const kind = String(rec.kind ?? "");
    const text = String(rec.text ?? "").trim();
    if (!text) continue;
    if (role === "status" && kind === "status" && !replayedLaneStatus(kind, text)) {
      continue;
    }
    return role === "ai" || (role === "status" && (kind === "execute" || kind === "error" || Boolean(replayedLaneStatus(kind, text))));
  }
  return false;
}

function collectCompletedClientMessageIdsFromHistoryItems(items: unknown[]): Set<string> {
  const completed = new Set<string>();
  let currentClientMessageId = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as { role?: unknown; kind?: unknown };
    const role = String(entry.role ?? "");
    const kind = String(entry.kind ?? "").trim();
    if (role === "user") {
      currentClientMessageId = parseClientMessageIdFromHistoryKind(kind);
      continue;
    }
    if (!currentClientMessageId) continue;
    if (role === "ai" || (role === "status" && (kind === "error" || kind === "execute"))) {
      completed.add(currentClientMessageId);
      currentClientMessageId = "";
    }
  }
  return completed;
}

export type WsMessageHandlerArgs = {
  projects: Ref<ProjectTab[]>;
  pid: string;
  rt: ProjectRuntime;
  wsInstance: { send: (type: string, payload: unknown) => void };
  maxTurnCommands: number;
  randomId: (prefix: string) => string;

  updateProject: (id: string, updates: Partial<ProjectTab>) => void;

  applyResumeHistory: ChatActions["applyResumeHistory"];
  cancelPendingResume: ChatActions["cancelPendingResume"];
  clearPendingPrompt: ChatActions["clearPendingPrompt"];
  clearStepLive: ChatActions["clearStepLive"];
  commandKeyForWsEvent: ChatActions["commandKeyForWsEvent"];
  finalizeAssistant: ChatActions["finalizeAssistant"];
  finalizeCommandBlock: ChatActions["finalizeCommandBlock"];
  flushQueuedPrompts: ChatActions["flushQueuedPrompts"];
  ingestCommand: ChatActions["ingestCommand"];
  ingestCommandActivity: ChatActions["ingestCommandActivity"];
  ingestExploredActivity: ChatActions["ingestExploredActivity"];
  pushMessageBeforeLive: ChatActions["pushMessageBeforeLive"];
  shouldIgnoreStepDelta: ChatActions["shouldIgnoreStepDelta"];
  threadReset: ChatActions["threadReset"];
  upsertExecuteBlock: ChatActions["upsertExecuteBlock"];
  upsertLiveActivity: ChatActions["upsertLiveActivity"];
  upsertStepLiveDelta: ChatActions["upsertStepLiveDelta"];
  upsertStreamingDelta: ChatActions["upsertStreamingDelta"];
  replaceStreamingText: ChatActions["replaceStreamingText"];
};

export function createWsMessageHandler(args: WsMessageHandlerArgs) {
  const {
    projects,
    pid,
    rt,
    wsInstance,
    randomId,
    updateProject,
    applyResumeHistory,
    cancelPendingResume,
    clearPendingPrompt,
    clearStepLive,
    commandKeyForWsEvent,
    finalizeAssistant,
    finalizeCommandBlock,
    flushQueuedPrompts,
    ingestCommand,
    ingestCommandActivity,
    ingestExploredActivity,
    pushMessageBeforeLive,
    shouldIgnoreStepDelta,
    threadReset,
    upsertExecuteBlock,
    upsertLiveActivity,
    upsertStepLiveDelta,
    upsertStreamingDelta,
    replaceStreamingText,
  } = args;
  rt.inputLocked ??= { value: false };
  rt.laneStatus ??= { value: null };
  let recoveredBackendActivitySeen = false;

  const isGitDiffCommand = (raw: string): boolean => {
    const cmd = String(raw ?? "").trim().toLowerCase();
    if (!cmd) return false;
    // Handle common compositions like `cd x && git diff ...`.
    return /(^|[;&|]|\|\||&&)\s*git(?:\s+--[^\s]+|\s+-[^\s]+|\s+-c\s+[^\s=]+=[^\s]+)*\s+diff\b/.test(cmd);
  };

  const looksLikeUnifiedDiff = (raw: string): boolean => {
    const text = String(raw ?? "");
    if (!text.trim()) return false;
    if (text.includes("*** Begin Patch")) return true;
    if (text.includes("diff --git ")) return true;
    if (text.includes("\n+++ ") || text.startsWith("+++ ")) return true;
    if (text.includes("\n--- ") || text.startsWith("--- ")) return true;
    if (text.includes("\n@@ ") || text.startsWith("@@ ")) return true;
    return false;
  };

  const clearTransientRetryNotice = (): void => {
    const existing = rt.messages.value.slice();
    const next = existing.filter((m) => !(m.transient === true && String(m.id ?? "") === TRANSIENT_RETRY_NOTICE_ID));
    if (next.length !== existing.length) {
      rt.messages.value = next;
    }
    if (rt.laneStatus.value?.kind === "progress" && rt.laneStatus.value.message.includes("retry")) {
      rt.laneStatus.value = null;
    }
  };

  const clearRecoveredBackendStatus = (): void => {
    recoveredBackendActivitySeen = true;
    if (
      rt.laneStatus.value?.kind === "progress" ||
      (rt.laneStatus.value?.kind === "info" && BACKEND_WAITING_STATUS_MESSAGES.has(rt.laneStatus.value.message))
    ) {
      rt.laneStatus.value = null;
    }
  };

  const reconcilePendingPromptsByClientMessageIds = (clientMessageIds: Set<string>): boolean => {
    if (clientMessageIds.size === 0) return false;
    const before = rt.queuedPrompts.value;
    const after = before.filter(
      (prompt) => !clientMessageIds.has(String(prompt.clientMessageId ?? "").trim()),
    );
    const pendingAckClientMessageId = String(rt.pendingAckClientMessageId ?? "").trim();
    const matchedPendingAck = Boolean(pendingAckClientMessageId && clientMessageIds.has(pendingAckClientMessageId));
    if (after.length === before.length && !matchedPendingAck) return false;
    rt.queuedPrompts.value = after;
    if (!pendingAckClientMessageId || matchedPendingAck) {
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
    }
    return true;
  };

  const reconcilePendingPromptsFromBootstrapHistory = (items: unknown[], terminalHistoryTail: boolean): void => {
    if (!rt.awaitingBootstrapHistory) return;
    const serverUserClientMessageIds = new Set<string>();
    let newestServerUser = "";
    for (const item of [...items].reverse()) {
      const entry = item as { role?: unknown; text?: unknown; kind?: unknown };
      if (String(entry.role ?? "") !== "user") {
        continue;
      }
      const kind = String(entry.kind ?? "").trim();
      const clientMessageId = parseClientMessageIdFromHistoryKind(kind);
      if (clientMessageId) {
        serverUserClientMessageIds.add(clientMessageId);
      }
      if (!newestServerUser) {
        newestServerUser = String(entry.text ?? "").trim();
      }
    }
    const completedClientMessageIds = collectCompletedClientMessageIdsFromHistoryItems(items);
    const backendStillRunning = rt.busy.value || rt.turnInFlight;
    if (completedClientMessageIds.size > 0) {
      reconcilePendingPromptsByClientMessageIds(completedClientMessageIds);
    } else if (backendStillRunning && serverUserClientMessageIds.size > 0) {
      reconcilePendingPromptsByClientMessageIds(serverUserClientMessageIds);
    } else if (newestServerUser && (terminalHistoryTail || backendStillRunning)) {
      const before = rt.queuedPrompts.value;
      const after = before.filter((prompt) => String(prompt.text ?? "").trim() !== newestServerUser);
      if (after.length !== before.length) {
        const afterIds = new Set(after.map((prompt) => String(prompt.clientMessageId ?? "").trim()).filter(Boolean));
        const removedIds = before
          .map((prompt) => String(prompt.clientMessageId ?? "").trim())
          .filter((clientMessageId) => clientMessageId && !afterIds.has(clientMessageId));
        rt.queuedPrompts.value = after;
        const pendingAckClientMessageId = String(rt.pendingAckClientMessageId ?? "").trim();
        if (!pendingAckClientMessageId || removedIds.includes(pendingAckClientMessageId)) {
          rt.pendingAckClientMessageId = null;
          clearPendingPrompt(rt);
        }
      }
    }
    rt.awaitingBootstrapHistory = false;
  };

  const upsertTransientRetryNotice = (message: string, retryCount?: unknown): void => {
    const content = String(message ?? "").trim() || "Upstream model request failed temporarily; retrying.";
    const explicitCount = Number(retryCount);
    const nextCount = Number.isFinite(explicitCount) && explicitCount > 0
      ? Math.floor(explicitCount)
      : 1;
    rt.laneStatus.value = {
      kind: "progress",
      message: nextCount > 1 ? `${content}（第 ${nextCount} 次重试）` : content,
    };
  };

  const dropExecuteBlockForKey = (key: string): void => {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const itemId = `exec:${normalizedKey}`;
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    const next = existing.filter((m) => String(m?.id ?? "") !== itemId);
    if (next.length !== existing.length) {
      rt.messages.value = next;
    }
    rt.executePreviewByKey.delete(normalizedKey);
    rt.executeOrder = rt.executeOrder.filter((k) => k !== normalizedKey);
  };

  const dropRedundantDiffExecuteBlocks = (): void => {
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    if (existing.length === 0) return;
    for (const msg of existing) {
      if (!msg || msg.kind !== "execute") continue;
      const cmd = String(msg.command ?? "").trim();
      const preview = String(msg.content ?? "");
      if (!cmd) continue;
      if (!isGitDiffCommand(cmd)) continue;
      if (!looksLikeUnifiedDiff(preview)) continue;
      const id = String(msg.id ?? "");
      if (!id.startsWith("exec:")) continue;
      dropExecuteBlockForKey(id.slice("exec:".length));
    }
  };

  const buildExecuteMessage = (args: {
    id: string;
    command: string;
    output: string;
    ts?: number;
    streaming?: boolean;
  }): ChatItem => {
    const normalizedCommand = String(args.command ?? "").trim();
    const outputLines = String(args.output ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => String(line ?? "").replace(/\s+$/, ""))
      .filter((line) => line.trim());
    const previewLines = outputLines.slice(0, HISTORY_EXECUTE_PREVIEW_LINES);
    const hiddenLineCount = Math.max(0, outputLines.length - previewLines.length);
    const fullContent = outputLines.join("\n");
    return {
      id: args.id,
      role: "system",
      kind: "execute",
      content: previewLines.join("\n"),
      fullContent: hiddenLineCount > 0 ? fullContent : undefined,
      command: normalizedCommand,
      hiddenLineCount: hiddenLineCount || undefined,
      streaming: args.streaming,
      ts: args.ts,
    };
  };

  const dropReconnectBusyMessage = (): void => {
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    const next = existing.filter(
      (item) => !(item.role === "system" && item.kind === "text" && isReconnectNotice(String(item.content ?? ""))),
    );
    if (next.length !== existing.length) {
      rt.messages.value = next;
    }
  };

  type PatchFileStat = { added: number | null; removed: number | null };

  let turnPatchMessageId: string | null = null;
  let turnPatchSummaryTruncated = false;
  const turnPatchFilesByPath = new Map<string, PatchFileStat>();
  const turnPatchDiffByPath = new Map<string, string>();
  const turnPatchOrder: string[] = [];

  const resetTurnPatchSummary = (): void => {
    turnPatchMessageId = null;
    turnPatchSummaryTruncated = false;
    turnPatchFilesByPath.clear();
    turnPatchDiffByPath.clear();
    turnPatchOrder.length = 0;
  };

  const hydrateTurnPatchSummaryFromCurrentTurn = (): void => {
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    let lastUserIndex = -1;
    for (let index = existing.length - 1; index >= 0; index -= 1) {
      if (existing[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const patchMessage = existing.find(
      (item, index) => index > lastUserIndex && item.role === "system" && item.kind === "patch" && item.patch,
    );
    if (!patchMessage?.patch) return;
    turnPatchMessageId = String(patchMessage.id ?? "").trim() || null;
    turnPatchSummaryTruncated = Boolean(patchMessage.patch.truncated);
    for (const file of patchMessage.patch.files ?? []) {
      const filePath = String(file.path ?? "").trim();
      if (!filePath) continue;
      if (!turnPatchFilesByPath.has(filePath)) {
        turnPatchOrder.push(filePath);
      }
      turnPatchFilesByPath.set(filePath, {
        added: typeof file.added === "number" && Number.isFinite(file.added) ? file.added : null,
        removed: typeof file.removed === "number" && Number.isFinite(file.removed) ? file.removed : null,
      });
    }
    for (const [filePath, section] of splitUnifiedDiffByPath(String(patchMessage.patch.diff ?? "")).entries()) {
      if (!filePath || !section.trim()) continue;
      if (!turnPatchDiffByPath.has(filePath) && !turnPatchOrder.includes(filePath)) {
        turnPatchOrder.push(filePath);
      }
      turnPatchDiffByPath.set(filePath, section);
    }
  };

  const buildTurnPatchFiles = (): ChatPatchFile[] =>
    turnPatchOrder
      .map((path) => {
        const stat = turnPatchFilesByPath.get(path);
        return {
          path,
          added: stat?.added ?? null,
          removed: stat?.removed ?? null,
        } satisfies ChatPatchFile;
      })
      .filter((file) => Boolean(file.path));

  const buildTurnPatchDiff = (): string =>
    turnPatchOrder
      .map((path) => {
        const section = turnPatchDiffByPath.get(path);
        if (!section) return "";
        return section;
      })
      .filter(Boolean)
      .join("\n\n");

  const buildTurnPatchPayload = (): ChatPatch => ({
    files: buildTurnPatchFiles(),
    diff: buildTurnPatchDiff(),
    truncated: turnPatchSummaryTruncated || undefined,
  });

  const upsertTurnPatchMessage = (
    patch: ChatPatch,
    options?: { beforeTerminalAssistant?: boolean; ts?: number },
  ): void => {
    const id = String(turnPatchMessageId ?? "").trim();
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value.slice() : [];
    let lastUserIndex = -1;
    for (let index = existing.length - 1; index >= 0; index -= 1) {
      if (existing[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const matchingIndex = existing.findIndex(
      (item, index) => index > lastUserIndex && item.role === "system" && item.kind === "patch",
    );
    if (!id && matchingIndex >= 0) {
      const matching = existing[matchingIndex]!;
      existing[matchingIndex] = { ...matching, content: patch.diff, patch };
      rt.messages.value = existing;
      turnPatchMessageId = String(matching.id ?? "") || null;
      return;
    }
    if (id) {
      const idx = existing.findIndex((m) => String(m?.id ?? "") === id);
      if (idx >= 0) {
        const prev = existing[idx];
        if (prev && prev.role === "system" && prev.kind === "patch") {
          existing[idx] = { ...prev, content: patch.diff, patch };
          rt.messages.value = existing;
          return;
        }
      }
    }

    if (options?.beforeTerminalAssistant) {
      const patchId = randomId("patch");
      pushMessageBeforeLive({
        id: patchId,
        role: "system",
        kind: "patch",
        content: patch.diff,
        patch,
        ts: options.ts,
      }, rt);
      const reordered = Array.isArray(rt.messages.value) ? rt.messages.value.slice() : [];
      const insertedIndex = reordered.findIndex((item) => String(item.id ?? "") === patchId);
      if (insertedIndex >= 0) {
        const [patchMessage] = reordered.splice(insertedIndex, 1);
        let insertAt = reordered.length;
        for (let index = reordered.length - 1; index >= 0; index -= 1) {
          const item = reordered[index]!;
          if (item.role === "assistant" && item.kind === "text") {
            insertAt = index;
            break;
          }
        }
        if (patchMessage) {
          reordered.splice(insertAt, 0, patchMessage);
          rt.messages.value = reordered;
        }
      }
      turnPatchMessageId = patchId;
      return;
    }

    const beforeIds = new Set(existing.map((m) => String(m?.id ?? "")));
    pushMessageBeforeLive({ role: "system", kind: "patch", content: patch.diff, patch, ts: options?.ts ?? Date.now() }, rt);
    const inserted =
      (Array.isArray(rt.messages.value) ? rt.messages.value : []).find(
        (m) => !beforeIds.has(String(m?.id ?? "")) && m?.role === "system" && m?.kind === "patch" && String(m?.content ?? "") === patch.diff,
      ) ??
      (Array.isArray(rt.messages.value) ? rt.messages.value : []).find((m) => !beforeIds.has(String(m?.id ?? ""))) ??
      null;
    turnPatchMessageId = inserted ? String(inserted.id ?? "") : null;
  };

  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

  const buildWorkspaceProjectUpdates = (
    current: ProjectTab,
    nextPath: string,
    wsState: WorkspaceState | null,
  ): Partial<ProjectTab> => {
    const updates: Partial<ProjectTab> = { initialized: true };
    if (nextPath && current.id !== "default" && !current.path.trim()) {
      updates.path = nextPath;
    }
    if (wsState && Object.prototype.hasOwnProperty.call(wsState, "branch")) {
      updates.branch = String(wsState.branch ?? "");
    }
    return updates;
  };

  const syncProjectFromWorkspaceState = (
    current: ProjectTab | null,
    nextPath: string,
    wsState: WorkspaceState | null,
  ): void => {
    if (!current) {
      return;
    }
    updateProject(current.id, buildWorkspaceProjectUpdates(current, nextPath, wsState));
  };

  const persistEffectivePreferences = (): void => {
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    if (!sessionId) return;
    try {
      const agentId = String(rt.activeAgentId.value ?? "").trim();
      localStorage.setItem(buildModelIdStorageKey(sessionId, chatSessionId, agentId), normalizeModelId(rt.modelId.value));
      localStorage.setItem(
        buildReasoningEffortStorageKey(sessionId, chatSessionId, agentId),
        normalizeReasoningEffort(rt.modelReasoningEffort.value),
      );
    } catch {
      // ignore
    }
  };

  const applyEffectiveState = (payload: Record<string, unknown>): void => {
    const effectiveModel = String(payload.effectiveModel ?? "").trim();
    if (effectiveModel) {
      rt.modelId.value = normalizeModelId(effectiveModel);
    }
    const effectiveReasoningEffort = String(payload.effectiveModelReasoningEffort ?? "").trim();
    if (effectiveReasoningEffort) {
      rt.modelReasoningEffort.value = normalizeReasoningEffort(effectiveReasoningEffort);
    }
    const activeAgentId = String(payload.activeAgentId ?? "").trim();
    if (activeAgentId) {
      rt.activeAgentId.value = activeAgentId;
    }
    const notice = String(payload.notice ?? "").trim();
    if (notice) {
      rt.apiNotice.value = notice;
      const chatNotice = stripSelectionChangeNotices(notice);
      if (chatNotice) {
        rt.laneStatus.value = { kind: "info", message: chatNotice };
      }
      if (rt.noticeTimer !== null) {
        try {
          clearTimeout(rt.noticeTimer);
        } catch {
          // ignore
        }
      }
      rt.noticeTimer = window.setTimeout(() => {
        rt.noticeTimer = null;
        rt.apiNotice.value = null;
      }, 3000);
    }
    if (effectiveModel || effectiveReasoningEffort) {
      persistEffectivePreferences();
    }
  };

  const clearThreadWarningIfCurrent = (threadId: string): void => {
    if (!threadId) return;
    const activeThreadId = String(rt.activeThreadId.value ?? "").trim();
    if (!activeThreadId || activeThreadId === threadId) {
      rt.threadWarning.value = null;
    }
  };

  const annotatePendingUserMessageExecution = (payload: Record<string, unknown>): void => {
    const pendingId = String(rt.pendingAckClientMessageId ?? "").trim();
    if (!pendingId) return;
    const target = rt.messages.value.find((m) => m.id === pendingId && m.role === "user");
    if (!target) return;

    const effectiveAgentId = String(payload.activeAgentId ?? "").trim();
    const effectiveModel = String(payload.effectiveModel ?? "").trim();
    const effectiveModelReasoningEffort = String(payload.effectiveModelReasoningEffort ?? "").trim();
    target.execution = {
      ...(target.execution ?? {}),
      ...(effectiveAgentId ? { effectiveAgentId } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
      ...(effectiveModelReasoningEffort ? { effectiveModelReasoningEffort } : {}),
    };
  };

  const handleSharedSessionReset = (payload: Record<string, unknown>): void => {
    const effectiveChatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    const resetScope = String(payload.scope ?? "").trim().toLowerCase() || "shared";
    const sourceChatSessionId = String(payload.sourceChatSessionId ?? "").trim();
    if (resetScope === "lane" && sourceChatSessionId && sourceChatSessionId !== effectiveChatSessionId) {
      return;
    }
    const hasVisibleLocalContinuity =
      rt.messages.value.length > 0 ||
      Boolean(String(rt.activeThreadId.value ?? "").trim()) ||
      Boolean(String(rt.pendingAckClientMessageId ?? "").trim()) ||
      rt.queuedPrompts.value.length > 0 ||
      rt.turnInFlight ||
      rt.busy.value;

    cancelPendingResume(rt);
    rt.busy.value = false;
    rt.turnInFlight = false;
    rt.turnHasPatch = false;
    rt.awaitingBootstrapHistory = false;
    rt.pendingAckClientMessageId = null;
    rt.queuedPrompts.value = [];
    resetTurnPatchSummary();
    clearPendingPrompt(rt);
    clearStepLive(rt);
    finalizeCommandBlock(rt);

    if (!hasVisibleLocalContinuity) {
      rt.activeThreadId.value = null;
      return;
    }

    threadReset(rt, {
      notice: "共享上下文已在其他窗格中重置。为避免误导，当前聊天历史已清空。",
      warning: null,
      keepLatestTurn: false,
      clearBackendHistory: false,
      resetThreadId: true,
      source: "shared_session_reset",
    });
  };

  return (msg: unknown): void => {
    if (!isRecord(msg)) return;
    const typeValue = msg.type;
    if (typeof typeValue !== "string") return;
    const type = typeValue;

    if (type === "agents") {
      const rec = msg as Record<string, unknown>;
      const sequence = Number(rec.seq);
      if (Number.isFinite(sequence) && sequence > 0) {
        // Agent availability is current-state data supplied by the unsequenced
        // bootstrap/live snapshot. Older ADS versions persisted these snapshots,
        // so replaying one can remove newly added agents and strand the selector.
        return;
      }
      const activeAgentId = String((msg as { activeAgentId?: unknown }).activeAgentId ?? rec["active_agent_id"] ?? "").trim();
      const agentsRaw = (msg as { agents?: unknown }).agents ?? rec["agents"];
      const agents = (Array.isArray(agentsRaw) ? agentsRaw : [])
        .map((entry) => {
          const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
          if (!obj) return null;
          const id = String(obj.id ?? obj.agentId ?? obj.agent_id ?? "").trim();
          if (!id) return null;
          const name = String(obj.name ?? obj.agentName ?? obj.agent_name ?? id).trim() || id;
          const ready = Boolean(obj.ready);
          const error = typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : undefined;
          return { id, name, ready, error };
        })
        .filter(Boolean) as Array<{ id: string; name: string; ready: boolean; error?: string }>;

      rt.availableAgents.value = agents;
      if (activeAgentId) {
        rt.activeAgentId.value = activeAgentId;
      } else {
        const currentActiveAgentId = String(rt.activeAgentId.value ?? "").trim();
        const currentReady = Boolean(currentActiveAgentId) && agents.some((agent) => agent.id === currentActiveAgentId && agent.ready);
        const readyFallback = agents.find((agent) => agent.ready)?.id ?? "";
        if (readyFallback && !currentReady) {
          rt.activeAgentId.value = readyFallback;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rec, "threadId")) {
        const threadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
        clearThreadWarningIfCurrent(threadId);
        rt.activeThreadId.value = threadId || null;
      }
      return;
    }

    if (type === "goal:status") {
      const data = (msg as { data?: Record<string, unknown> }).data;
      if (!data || typeof data !== "object") return;
      const taskId = String(data.taskId ?? "").trim();
      if (!taskId) return;
      const list = Array.isArray(rt.tasks.value) ? rt.tasks.value : [];
      const idx = list.findIndex((t) => t.id === taskId);
      if (idx < 0) return;
      const status = String(data.status ?? "").trim() as
        | "active"
        | "paused"
        | "blocked"
        | "usageLimited"
        | "budgetLimited"
        | "complete"
        | "";
      const tokensUsed = typeof data.tokensUsed === "number" ? data.tokensUsed : null;
      const timeUsedSeconds = typeof data.timeUsedSeconds === "number" ? data.timeUsedSeconds : null;
      const tokenBudget =
        data.tokenBudget == null
          ? null
          : typeof data.tokenBudget === "number"
            ? data.tokenBudget
            : Number(data.tokenBudget);
      const objective = typeof data.objective === "string" ? data.objective : list[idx]?.goalObjective ?? null;
      const next = {
        ...list[idx]!,
        goalMode: true,
        goalStatus: status || null,
        goalTokensUsed: tokensUsed,
        goalTimeUsedSeconds: timeUsedSeconds,
        goalTokenBudget: Number.isFinite(tokenBudget as number) ? (tokenBudget as number) : null,
        goalObjective: objective,
      };
      rt.tasks.value = [...list.slice(0, idx), next, ...list.slice(idx + 1)];
      return;
    }

    if (type === "goal:cleared") {
      const data = (msg as { data?: Record<string, unknown> }).data;
      if (!data || typeof data !== "object") return;
      const taskId = String(data.taskId ?? "").trim();
      if (!taskId) return;
      const list = Array.isArray(rt.tasks.value) ? rt.tasks.value : [];
      const idx = list.findIndex((t) => t.id === taskId);
      if (idx < 0) return;
      const next = {
        ...list[idx]!,
        goalStatus: null,
        goalTokensUsed: null,
        goalTimeUsedSeconds: null,
      };
      rt.tasks.value = [...list.slice(0, idx), next, ...list.slice(idx + 1)];
      return;
    }

    if (type === "ack") {
      const id = String(msg.client_message_id ?? "").trim();
      if (id && rt.pendingAckClientMessageId === id) {
        rt.pendingAckClientMessageId = null;
        clearPendingPrompt(rt);
      }
      return;
    }

    if (type === "task_bundle_draft") {
      const action = String((msg as { action?: unknown }).action ?? "upsert").trim().toLowerCase();
      const rawDraft = (msg as { draft?: unknown }).draft;
      const draft = isRecord(rawDraft) ? (rawDraft as TaskBundleDraft) : null;
      const draftId = String(draft?.id ?? "").trim();
      if (!draft || !draftId) {
        return;
      }

      const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
      if (action === "delete") {
        const next = removeTaskBundleDraft(existing, draftId);
        if (next !== existing) {
          rt.taskBundleDrafts.value = next;
        }
        return;
      }

      const next = upsertTaskBundleDraft(existing, draft, { mergeExisting: true });
      if (next !== existing) {
        rt.taskBundleDrafts.value = next;
      }
      return;
    }

    if (type === "task_bundle_auto_approved") {
      const draftId = String((msg as { draftId?: unknown }).draftId ?? "").trim();
      if (draftId) {
        const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
        const next = removeTaskBundleDraft(existing, draftId);
        if (next !== existing) {
          rt.taskBundleDrafts.value = next;
        }
      }
      return;
    }

    if (type === "welcome") {
      let nextPath = "";
      let wsState: WorkspaceState | null = null;
      const maybeWorkspace = msg.workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        wsState = maybeWorkspace as WorkspaceState;
        nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;
      }

      const inFlight = (msg as { inFlight?: unknown }).inFlight;
      if (typeof inFlight === "boolean") {
        rt.busy.value = inFlight;
        rt.turnInFlight = inFlight;
        if (inFlight) {
          rt.inputLocked.value = true;
          rt.laneStatus.value = { kind: "progress", message: "上一轮仍在执行，正在等待后端结果…" };
        } else {
          if (!rt.resumeReplacePending) {
            rt.inputLocked.value = false;
            if (rt.laneStatus.value?.kind === "progress") {
              rt.laneStatus.value = null;
            }
          }
          rt.turnHasPatch = false;
        }
      }

      const rawServerThreadId = String(msg.threadId ?? "").trim();
      const serverChatSessionId = String(msg.chatSessionId ?? "").trim();
      if (serverChatSessionId) {
        rt.chatSessionId = serverChatSessionId;
      }
      applyEffectiveState(msg as Record<string, unknown>);
      const handshakeReset = Boolean(msg.reset);
      const contextMode = String(msg.contextMode ?? "").trim();
      const bootstrapHistory = (msg as { bootstrapHistory?: unknown }).bootstrapHistory === true;
      const completedClientMessageIds = new Set(
        (Array.isArray((msg as { completedClientMessageIds?: unknown }).completedClientMessageIds)
          ? (msg as { completedClientMessageIds: unknown[] }).completedClientMessageIds
          : [])
          .map((value) => String(value ?? "").trim())
          .filter(Boolean),
      );
      reconcilePendingPromptsByClientMessageIds(completedClientMessageIds);
      const resumeRequestWasLost =
        rt.resumeReplacePending &&
        inFlight === false &&
        contextMode === "fresh" &&
        !rawServerThreadId;
      if (resumeRequestWasLost) {
        cancelPendingResume(rt);
        rt.laneStatus.value = { kind: "error", message: "恢复请求未确认，请重试。" };
      }
      rt.awaitingBootstrapHistory =
        !handshakeReset &&
        (contextMode === "thread_resumed" ||
          contextMode === "history_injection" ||
          Boolean(rawServerThreadId) ||
          inFlight === true ||
          bootstrapHistory) &&
        rt.queuedPrompts.value.length > 0;
      if (rt.awaitingBootstrapHistory) {
        rt.inputLocked.value = true;
      }
      const serverThreadId = contextMode === "fresh" ? "" : rawServerThreadId;
      const prevThreadId = String(rt.activeThreadId.value ?? "").trim();
      const hasStaleLocalContinuity = Boolean(prevThreadId) || rt.messages.value.length > 0;
      const welcomeInFlight = inFlight === true;
      if (handshakeReset) {
        resetTurnPatchSummary();
        threadReset(rt, {
          notice: "上下文线程已重置。为避免误导，聊天历史已清空。",
          warning: null,
          keepLatestTurn: false,
          clearBackendHistory: false,
          resetThreadId: true,
          source: "welcome_reset",
        });
      } else if (contextMode === "fresh" && hasStaleLocalContinuity && !welcomeInFlight && !bootstrapHistory) {
        resetTurnPatchSummary();
        threadReset(rt, {
          notice: "后端已是全新上下文。为避免误导，旧的本地聊天历史已清空。",
          warning: null,
          keepLatestTurn: false,
          clearBackendHistory: false,
          resetThreadId: true,
          source: "welcome_fresh_context",
        });
      } else if (contextMode === "history_injection" && hasStaleLocalContinuity) {
        rt.threadWarning.value = HISTORY_INJECTION_NOTICE;
      } else if (prevThreadId && serverThreadId && prevThreadId !== serverThreadId) {
        rt.threadWarning.value =
          `后端线程已变化但没有显式重置标记（原=${prevThreadId}，现=${serverThreadId}）。` +
          "当前界面已保留，但模型上下文可能与聊天历史不一致。";
      } else {
        clearThreadWarningIfCurrent(serverThreadId);
      }
      rt.activeThreadId.value = serverThreadId || null;

      const current = projects.value.find((p) => p.id === pid) ?? null;
      if (current) {
        const desiredRoot = current.id !== "default" ? current.path.trim() : "";
        const shouldForceCd =
          Boolean(desiredRoot) &&
          rt.pendingCdRequestedPath == null &&
          (!current.initialized || (nextPath && nextPath !== desiredRoot));
        if (shouldForceCd) {
          rt.pendingCdRequestedPath = desiredRoot;
          wsInstance.send("command", { command: `/cd ${desiredRoot}`, silent: true });
          return;
        }
      }
      syncProjectFromWorkspaceState(current, nextPath, wsState);

      if (
        !rt.awaitingBootstrapHistory &&
        ((typeof inFlight === "boolean" && !inFlight) || (typeof inFlight !== "boolean" && !rt.turnInFlight))
      ) {
        void flushQueuedPrompts(rt);
      }
      return;
    }

    if (type === "workspace") {
      const data = msg.data;
      if (data && typeof data === "object") {
        const wsState = data as WorkspaceState;
        const nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;

        if (rt.pendingCdRequestedPath) {
          const current = projects.value.find((p) => p.id === pid) ?? null;
          syncProjectFromWorkspaceState(current, nextPath, wsState);
          rt.pendingCdRequestedPath = null;
          return;
        }
        const current = projects.value.find((p) => p.id === pid) ?? null;
        syncProjectFromWorkspaceState(current, nextPath, wsState);
      }
      return;
    }

    if (type === "thread_reset") {
      resetTurnPatchSummary();
      rt.awaitingBootstrapHistory = false;
      threadReset(rt, {
        notice: "上下文线程已重置。为避免误导，聊天历史已清空。",
        warning: null,
        keepLatestTurn: false,
        clearBackendHistory: false,
        resetThreadId: true,
        source: "thread_reset_signal",
      });
      return;
    }

    if (type === "session_list_result") {
      const rec = msg as Record<string, unknown>;
      rt.resumableSessionsBusy.value = false;
      const error = typeof rec.error === "string" ? rec.error : null;
      rt.resumableSessionsError.value = error;
      const items = Array.isArray(rec.items) ? (rec.items as ResumableSession[]) : [];
      // A cursor page extends the list; anything else replaces it. Dedupe by id
      // so a session that shifted between pages cannot appear twice.
      if (rec.appended === true) {
        const seen = new Set(rt.resumableSessions.value.map((entry) => entry.sessionId));
        rt.resumableSessions.value = [
          ...rt.resumableSessions.value,
          ...items.filter((entry) => !seen.has(entry.sessionId)),
        ];
      } else {
        rt.resumableSessions.value = items;
      }
      rt.resumableSessionsNextCursor.value =
        typeof rec.nextCursor === "string" && rec.nextCursor ? rec.nextCursor : null;
      const hidden = rec.hidden as
        | { singleTurn?: unknown; duplicates?: unknown; forks?: unknown }
        | undefined;
      rt.resumableSessionsHidden.value =
        hidden && typeof hidden === "object"
          ? {
              singleTurn: typeof hidden.singleTurn === "number" ? hidden.singleTurn : 0,
              duplicates: typeof hidden.duplicates === "number" ? hidden.duplicates : 0,
              forks: typeof hidden.forks === "number" ? hidden.forks : 0,
            }
          : null;
      if (!error && Array.isArray(rec.degraded) && rec.degraded.length > 0) {
        // A degraded source still returns rows; say so rather than implying the list is complete.
        rt.resumableSessionsError.value = "部分来源不可用，列表可能不完整";
      }
      return;
    }

    if (type === "session_reset") {
      handleSharedSessionReset(msg as Record<string, unknown>);
      return;
    }

    if (type === "session_fallback") {
      // The provider lost the session mid-turn: this turn already ran without
      // the old context, so say so instead of leaving the thread looking resumed.
      const rec = msg as Record<string, unknown>;
      const message = String(rec.message ?? "").trim();
      rt.laneStatus.value = {
        kind: "info",
        message: message || "原生会话已不存在，已改用新会话继续。",
      };
      rt.threadWarning.value = "原生会话已不存在，本轮已改用新会话；下一轮会带上最近聊天历史。";
      return;
    }

    if (type === "context_injection") {
      const rec = msg as Record<string, unknown>;
      const entryCount = Number(rec.entryCount);
      if (!Number.isFinite(entryCount) || entryCount <= 0) return;
      const earliestRaw = Number(rec.earliestTs);
      const earliestTs = Number.isFinite(earliestRaw) && earliestRaw > 0 ? earliestRaw : null;
      const sinceLabel = earliestTs ? ` (起自 ${new Date(earliestTs).toLocaleString()})` : "";
      const content = `已注入最近 ${Math.floor(entryCount)} 条聊天历史作为本轮上下文${sinceLabel}。`;
      rt.laneStatus.value = { kind: "info", message: content };
      return;
    }

    if (type === "status") {
      const content = String(msg.message ?? msg.output ?? msg.text ?? "").trim();
      if (!content) return;
      if (recoveredBackendActivitySeen && BACKEND_WAITING_STATUS_MESSAGES.has(content)) return;
      const kind = String(msg.kind ?? "").trim() === "error"
        ? "error"
        : BACKEND_WAITING_STATUS_MESSAGES.has(content)
          ? "progress"
          : "info";
      const chatContent = kind === "info" ? stripSelectionChangeNotices(content) : content;
      if (!chatContent) return;
      rt.laneStatus.value = { kind, message: chatContent };
      return;
    }

    if (type === "history") {
      const resumeReplacePending = rt.resumeReplacePending;
      const items = Array.isArray(msg.items) ? (msg.items as unknown[]) : [];
      const terminalHistoryTail = hasTerminalHistoryTail(items);
      reconcilePendingPromptsFromBootstrapHistory(items, terminalHistoryTail);
      if (!resumeReplacePending && rt.ignoreNextHistory) {
        rt.ignoreNextHistory = false;
        dropReconnectBusyMessage();
        if (!rt.busy.value && !rt.turnInFlight) {
          rt.inputLocked.value = false;
          if (rt.laneStatus.value?.kind === "progress") {
            rt.laneStatus.value = null;
          }
          void flushQueuedPrompts(rt);
        }
        return;
      }
      const historyThreadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
      const historyContextMode = String((msg as { contextMode?: unknown }).contextMode ?? "").trim();
      const restoreNotice = contextModeNotice(historyContextMode);
      const restoredContextStatus: LaneStatus | null = restoreNotice && !resumeReplacePending
        ? { kind: "info", message: restoreNotice }
        : null;
      let restoredHistoryStatus: LaneStatus | null = null;
      let replayedExecuteActivity = false;
      if (historyThreadId) {
        rt.activeThreadId.value = historyThreadId;
        if (historyContextMode === "thread_resumed" || historyContextMode === "history_injection") {
          rt.threadWarning.value = null;
        } else {
          clearThreadWarningIfCurrent(historyThreadId);
        }
      }
      rt.recentCommands.value = [];
      rt.seenCommandIds.clear();
      const next: ChatItem[] = [];
      for (let idx = 0; idx < items.length; idx++) {
        const entry = items[idx] as { role?: unknown; text?: unknown; kind?: unknown; ts?: unknown };
        const role = String(entry.role ?? "");
        const text = String(entry.text ?? "");
        const kind = String(entry.kind ?? "");
        const rawTs = entry.ts;
        const ts = typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 0 ? Math.floor(rawTs) : null;
        const trimmed = text.trim();
        if (!trimmed) continue;
        const historyText = role === "status" && kind !== "error" ? stripSelectionChangeNotices(trimmed) : trimmed;
        if (!historyText) continue;
        if (kind === "execute") {
          restoredHistoryStatus = null;
          replayedExecuteActivity = true;
          const lines = historyText.split("\n");
          const commandLine = String(lines[0] ?? "").trim();
          const command = commandLine.startsWith("$ ") ? commandLine.slice(2).trim() : commandLine;
          next.push(
            buildExecuteMessage({
              id: `h-x-${idx}`,
              command,
              output: lines.slice(1).join("\n"),
              ts: ts ?? undefined,
            }),
          );
          continue;
        }
        if (kind.startsWith("plan:") || kind === "plan") {
          restoredHistoryStatus = null;
          const planId = kind.startsWith("plan:") ? kind.slice("plan:".length).trim() || `plan-${idx}` : `plan-${idx}`;
          let parsed: { planId?: unknown; status?: unknown; items?: unknown } | null = null;
          try {
            parsed = JSON.parse(historyText) as { planId?: unknown; status?: unknown; items?: unknown };
          } catch {
            parsed = null;
          }
          if (!parsed || typeof parsed !== "object") continue;
          const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
          const planItems: ChatPlanItem[] = [];
          for (const planEntry of itemsRaw) {
            if (!planEntry || typeof planEntry !== "object" || Array.isArray(planEntry)) continue;
            const rec = planEntry as Record<string, unknown>;
            const text = String(rec.text ?? rec.content ?? "").trim();
            if (!text) continue;
            const itemStatusRaw = String(rec.status ?? "").trim().toLowerCase();
            const planStatus: ChatPlanItemStatus =
              itemStatusRaw === "completed"
                ? "completed"
                : itemStatusRaw === "in_progress"
                  ? "in_progress"
                  : "pending";
            planItems.push({ text, status: planStatus });
          }
          if (planItems.length === 0) continue;
          const planStatusRaw = String(parsed.status ?? "").trim().toLowerCase();
          const planStatus: ChatPlan["status"] =
            planStatusRaw === "completed"
              ? "completed"
              : planStatusRaw === "failed"
                ? "failed"
                : "in_progress";
          const persistedPlanId = String(parsed.planId ?? "").trim() || planId;
          next.push({
            id: `plan:${persistedPlanId}`,
            role: "system",
            kind: "plan",
            content: planItems
              .map((entry) => `${entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[~]" : "[ ]"} ${entry.text}`)
              .join("\n"),
            plan: { planId: persistedPlanId, status: planStatus, items: planItems },
            ts: ts ?? undefined,
          });
          continue;
        }
        if (role === "status") {
          restoredHistoryStatus = replayedLaneStatus(kind, historyText);
          continue;
        }
        if (role === "user") {
          restoredHistoryStatus = null;
          const execution = parseExecutionFromHistoryKind(kind);
          next.push({
            id: `h-u-${idx}`,
            role: "user",
            kind: "text",
            content: historyText,
            ts: ts ?? undefined,
            ...(execution ? { execution } : {}),
          });
        } else if (role === "ai") {
          restoredHistoryStatus = null;
          next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: historyText, ts: ts ?? undefined });
        }
      }
      dropReconnectBusyMessage();
      applyResumeHistory(next, rt);
      const canTreatHistoryAsTerminal = terminalHistoryTail && !rt.busy.value && !rt.turnInFlight;
      if (canTreatHistoryAsTerminal) {
        clearRecoveredBackendStatus();
        rt.busy.value = false;
        rt.turnInFlight = false;
        rt.inputLocked.value = false;
      } else if (replayedExecuteActivity) {
        clearRecoveredBackendStatus();
      }
      const restoredLaneStatus = restoredHistoryStatus ?? restoredContextStatus;
      if (!rt.busy.value && !rt.turnInFlight && restoredLaneStatus) {
        rt.laneStatus.value = restoredLaneStatus;
      }
      if (!rt.busy.value && !rt.turnInFlight) {
        rt.inputLocked.value = false;
        if (rt.laneStatus.value?.kind === "progress") {
          rt.laneStatus.value = null;
        }
      }
      if (!rt.busy.value && !rt.turnInFlight) {
        void flushQueuedPrompts(rt);
      }
      return;
    }

    if (type === "in_flight") {
      const inFlight = (msg as { inFlight?: unknown }).inFlight;
      if (typeof inFlight !== "boolean") return;
      rt.busy.value = inFlight;
      rt.turnInFlight = inFlight;
      if (inFlight) {
        rt.inputLocked.value = true;
        rt.laneStatus.value = { kind: "progress", message: "上一轮仍在执行，正在等待后端结果…" };
      } else if (!rt.resumeReplacePending) {
        rt.inputLocked.value = false;
        if (rt.laneStatus.value?.kind === "progress") {
          rt.laneStatus.value = null;
        }
      }
      if (!inFlight && !rt.awaitingBootstrapHistory) {
        void flushQueuedPrompts(rt);
      }
      return;
    }

    if (type === "delta") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      const source = String(msg.source ?? "").trim();
      if (source === "step") {
        const delta = String(msg.delta ?? "");
        if (shouldIgnoreStepDelta(delta)) return;
        upsertStepLiveDelta(delta, rt);
      } else {
        upsertStreamingDelta(String(msg.delta ?? ""), rt);
      }
      return;
    }

    if (type === "delta_snapshot") {
      // Catch-up only: the server never broadcasts this live. It carries the whole
      // assistant text accumulated so far, so a client that reconnected mid-turn
      // resumes the stream instead of losing everything emitted while it was gone.
      // Replaying it is idempotent — the streaming block is rewritten, not appended to.
      const text = String(msg.text ?? "");
      if (!text) return;
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      replaceStreamingText(text, rt);
      return;
    }

    if (type === "explored") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      const entry = msg.entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (category === "Execute") {
          return;
        }
        // Vector auto-context is an internal optimization. If it didn't inject any context,
        // the log line is pure noise for end users.
        if (category === "Search" && summary.startsWith("VectorSearch(auto)")) {
          const injected = summary.includes("injected=1") || summary.includes("injected chars=");
          if (!injected) {
            return;
          }
        }
        if (summary) {
          ingestExploredActivity(rt.liveActivity, category, summary);
          upsertLiveActivity(rt);
        }
      }
      return;
    }

    if (type === "plan") {
      clearRecoveredBackendStatus();
      const rec = msg as Record<string, unknown>;
      const planId = String(rec.planId ?? rec.plan_id ?? "").trim();
      if (!planId) return;
      const statusRaw = String(rec.status ?? "").trim().toLowerCase();
      const status: ChatPlan["status"] =
        statusRaw === "completed" ? "completed" : statusRaw === "failed" ? "failed" : "in_progress";
      const itemsRaw = Array.isArray(rec.items) ? rec.items : [];
      const items: ChatPlanItem[] = [];
      for (const entry of itemsRaw) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const obj = entry as Record<string, unknown>;
        const text = String(obj.text ?? obj.content ?? "").trim();
        if (!text) continue;
        const itemStatus = String(obj.status ?? "").trim().toLowerCase();
        const normalizedStatus: ChatPlanItemStatus =
          itemStatus === "completed"
            ? "completed"
            : itemStatus === "in_progress"
              ? "in_progress"
              : "pending";
        items.push({ text, status: normalizedStatus });
      }
      const plan: ChatPlan = { planId, status, items };
      const tsRaw = Number(rec.ts);
      const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : Date.now();
      const itemId = `plan:${planId}`;
      const existing = Array.isArray(rt.messages.value) ? rt.messages.value.slice() : [];
      const content = items.map((entry) => `${entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[~]" : "[ ]"} ${entry.text}`).join("\n");
      const matchingIndexes = existing
        .map((message, index) => String(message?.plan?.planId ?? "").trim() === planId ? index : -1)
        .filter((index) => index >= 0);
      const idx = matchingIndexes[0] ?? -1;
      if (idx >= 0) {
        existing[idx] = { ...existing[idx]!, content, plan, ts };
        const duplicates = new Set(matchingIndexes.slice(1));
        rt.messages.value = normalizeTurnSemanticOrder(existing.filter((_message, index) => !duplicates.has(index)));
      } else {
        pushMessageBeforeLive({ id: itemId, role: "system", kind: "plan", content, plan, ts }, rt);
      }
      return;
    }

    if (type === "patch") {
      const rec = msg as Record<string, unknown>;
      const terminalArtifactReplay = rec.syncReplayMode === "terminal-artifact";
      const terminalArtifactFinal = rec.syncReplayFinal === true;
      if (!terminalArtifactReplay) {
        rt.busy.value = true;
        rt.turnInFlight = true;
        clearRecoveredBackendStatus();
      }
      const patch = msg.patch;
      if (!patch || typeof patch !== "object") return;

      const typed = patch as { files?: unknown; diff?: unknown; truncated?: unknown };
      const diff = String(typed.diff ?? "").trimEnd();
      if (!diff.trim()) return;
      if (terminalArtifactReplay && turnPatchOrder.length === 0) {
        hydrateTurnPatchSummaryFromCurrentTurn();
      }

      if (!terminalArtifactReplay) {
        rt.turnHasPatch = true;
      }
      // If the agent also ran `git diff`, it can show up as an execute preview line.
      // Prefer the structured patch diff message to avoid showing two diffs at once.
      if (!terminalArtifactReplay) {
        dropRedundantDiffExecuteBlocks();
      }

      const files = Array.isArray(typed.files) ? (typed.files as Array<{ path?: unknown; added?: unknown; removed?: unknown }>) : [];

      for (const f of files) {
        const filePath = String(f.path ?? "").trim();
        if (!filePath) continue;
        const added = typeof f.added === "number" && Number.isFinite(f.added) ? Math.max(0, Math.floor(f.added)) : null;
        const removed = typeof f.removed === "number" && Number.isFinite(f.removed) ? Math.max(0, Math.floor(f.removed)) : null;
        if (!turnPatchFilesByPath.has(filePath)) {
          turnPatchOrder.push(filePath);
        }
        turnPatchFilesByPath.set(filePath, { added, removed });
      }

      const perFileDiff = splitUnifiedDiffByPath(diff);
      for (const [path, section] of perFileDiff.entries()) {
        if (!path || !section.trim()) continue;
        if (!turnPatchDiffByPath.has(path) && !turnPatchOrder.includes(path)) {
          turnPatchOrder.push(path);
        }
        turnPatchDiffByPath.set(path, section);
      }

      const truncated = Boolean(typed.truncated);
      if (truncated) {
        turnPatchSummaryTruncated = true;
      }

      const nextPatch = buildTurnPatchPayload();
      const tsRaw = Number(rec.ts);
      upsertTurnPatchMessage(nextPatch, {
        beforeTerminalAssistant: terminalArtifactReplay,
        ts: Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : undefined,
      });
      if (terminalArtifactReplay && terminalArtifactFinal) {
        rt.turnHasPatch = false;
        resetTurnPatchSummary();
      }
      return;
    }

    if (type === "result") {
      annotatePendingUserMessageExecution(msg as Record<string, unknown>);
      recoveredBackendActivitySeen = false;
      clearTransientRetryNotice();
      cancelPendingResume(rt);
      rt.inputLocked.value = false;
      rt.laneStatus.value = null;
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      resetTurnPatchSummary();
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      const output = String(msg.output ?? "");
      if (rt.suppressNextClearHistoryResult) {
        rt.suppressNextClearHistoryResult = false;
        const kind = String(msg.kind ?? "").trim();
        if (msg.ok === true && kind === "clear_history") {
          clearStepLive(rt);
          finalizeCommandBlock(rt);
          void flushQueuedPrompts(rt);
          return;
        }
      }
      const threadId = String(msg.threadId ?? "").trim();
      const expectedThreadId = String(msg.expectedThreadId ?? "").trim();
      const didThreadReset = Boolean(msg.threadReset);
      const resultContextMode = String(msg.contextMode ?? "").trim();
      if (threadId) {
        const prevThreadId = String(rt.activeThreadId.value ?? "").trim();
        if (!didThreadReset && prevThreadId && prevThreadId !== threadId) {
          rt.threadWarning.value =
            `后端线程已变化但没有显式重置标记（原=${prevThreadId}，现=${threadId}）。` +
            "当前界面已保留，但模型上下文可能与聊天历史不一致。";
        } else {
          clearThreadWarningIfCurrent(threadId);
        }
        rt.activeThreadId.value = threadId;
      }
      if (didThreadReset) {
        const detail = expectedThreadId && threadId ? `（预期=${expectedThreadId}，实际=${threadId}）` : "";
        if (resultContextMode === "history_injection") {
          rt.threadWarning.value = `上下文线程已重置${detail}。下一轮将注入聊天历史继续上下文。`;
        } else {
          rt.awaitingBootstrapHistory = false;
          threadReset(rt, {
            notice: "上下文线程已重置。聊天历史已清空，并从新的对话继续。",
            warning: detail ? `上下文线程已重置${detail}。` : null,
            keepLatestTurn: true,
            clearBackendHistory: false,
            resetThreadId: true,
            source: "result_thread_reset",
          });
        }
      }
      applyEffectiveState(msg as Record<string, unknown>);
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      const resultKind = String(msg.kind ?? "").trim();
      const resultCommand = String(msg.command ?? "").trim();
      if (resultKind === "execute" && resultCommand) {
        finalizeAssistant("", rt);
        const resultTsRaw = Number((msg as { ts?: unknown }).ts);
        const resultTs = Number.isFinite(resultTsRaw) && resultTsRaw > 0 ? Math.floor(resultTsRaw) : Date.now();
        pushMessageBeforeLive(
          buildExecuteMessage({ id: randomId("exec-result"), command: resultCommand, output, streaming: false, ts: resultTs }),
          rt,
        );
        void flushQueuedPrompts(rt);
        return;
      }
      if (rt.pendingCdRequestedPath && msg.ok === false) {
        if (output.includes("/cd") || output.includes("目录")) {
          rt.pendingCdRequestedPath = null;
        }
      }
      if (msg.ok === false) {
        finalizeAssistant("", rt);
        const content = output.trim();
        if (content) {
          rt.laneStatus.value = { kind: "error", message: content };
        }
        void flushQueuedPrompts(rt, { preserveErrorStatus: true });
        return;
      }
      if (resultKind === "status") {
        finalizeAssistant("", rt);
        const content = output.trim();
        if (content) {
          rt.laneStatus.value = { kind: "info", message: content };
        }
        void flushQueuedPrompts(rt);
        return;
      }
      finalizeAssistant(output, rt);
      void flushQueuedPrompts(rt);
      return;
    }

    if (type === "error") {
      const isTransientRetry = Boolean(msg.transient) && Boolean(msg.retryable);
      if (isTransientRetry) {
        upsertTransientRetryNotice(String(msg.message ?? ""), msg.retryCount);
        return;
      }

      clearTransientRetryNotice();
      recoveredBackendActivitySeen = false;
      cancelPendingResume(rt);
      rt.inputLocked.value = false;
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      resetTurnPatchSummary();
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      // Ensure the assistant placeholder created when the prompt was sent does not
      // linger across turns (which can make the next user prompt appear below an
      // unrelated assistant block).
      finalizeAssistant("", rt);

      const errorInfo = msg.errorInfo && typeof msg.errorInfo === "object"
        ? (msg.errorInfo as { code?: string; retryable?: boolean; needsReset?: boolean })
        : undefined;

      const userMessage = String(msg.message ?? "error");
      const errorContent = errorInfo
        ? `⚠️ ${userMessage}\n\n` +
          `错误类型: ${errorInfo.code ?? "unknown"}\n` +
          (errorInfo.retryable ? "💡 可以重试\n" : "") +
          (errorInfo.needsReset ? "⚠️ 建议使用 /reset 重置会话\n" : "")
        : userMessage;

      rt.laneStatus.value = { kind: "error", message: errorContent };
      void flushQueuedPrompts(rt, { preserveErrorStatus: true });
      return;
    }

    if (type === "command") {
      const payload = msg.command && typeof msg.command === "object" ? (msg.command as Record<string, unknown>) : null;
      const cmd = String(payload?.command ?? "").trim();
      const id = String(payload?.id ?? "").trim();
      const key = commandKeyForWsEvent(cmd, id || null);
      if (!key) return;
      let outputDelta = String(payload?.outputDelta ?? "");
      const rawExitCode = payload?.exit_code ?? payload?.exitCode;
      const exitCode = typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : null;
      if (exitCode !== null && exitCode !== 0) {
        const exitLine = `[exit code ${exitCode}]`;
        const existingExecute = rt.messages.value.find((m) => String(m?.id ?? "") === `exec:${key}`);
        const existingOutput = String(existingExecute?.content ?? "");
        if (!outputDelta.includes(exitLine) && !existingOutput.includes(exitLine)) {
          outputDelta = outputDelta.trimEnd() ? `${outputDelta.trimEnd()}\n${exitLine}\n` : `${exitLine}\n`;
        }
      }
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      ingestCommand(cmd, rt, id || null);
      if (rt.turnHasPatch && isGitDiffCommand(cmd) && looksLikeUnifiedDiff(outputDelta)) {
        dropExecuteBlockForKey(key);
      } else {
        upsertExecuteBlock(key, cmd, outputDelta, rt);
      }
      if (cmd) {
        ingestCommandActivity(rt.liveActivity, cmd);
        upsertLiveActivity(rt);
      }
      return;
    }
  };
}
