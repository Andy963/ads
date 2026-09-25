import type { ChatActions } from "../chat";
import type {
  ChatItem,
  ChatPatch,
  ChatPatchFile,
  LaneStatus,
  ProjectRuntime,
  ProjectTab,
  ResumableSession,
  WorkspaceState,
} from "../controllerTypes";
import {
  normalizeModelId,
  normalizeReasoningEffort,
} from "../../lib/chatPreferences";
import {
  readModelIdPreference,
  readReasoningEffortPreference,
  writeModelPreference,
} from "../../lib/preferencesStore";
import { splitUnifiedDiffByPath } from "../../lib/patchDiff";
import { normalizeTurnSemanticOrder } from "../../lib/chat_sync";
import { isUserAbortFailure, upsertTurnFailureCard } from "../../lib/turnFailure";
import { diagAlert } from "../../lib/diagAlert";
import { crumb } from "../../lib/diagBreadcrumbs";
import type { ExecuteBlockUpdate } from "../chatExecute";

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

function normalizeWirePrimitive(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeWireText(value: unknown): string {
  const primitive = normalizeWirePrimitive(value);
  if (primitive) return primitive;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "output"]) {
    const nested = normalizeWirePrimitive(record[key]);
    if (nested) return nested;
  }
  return "";
}

function firstWireText(...values: unknown[]): string {
  for (const value of values) {
    const text = normalizeWireText(value);
    if (text) return text;
  }
  return "";
}

function normalizeWireCommand(value: unknown): string {
  const primitive = normalizeWirePrimitive(value);
  if (primitive) return primitive;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const record = value as Record<string, unknown>;
  return normalizeWirePrimitive(record.command ?? record.commandLine ?? record.text);
}

function stripSelectionChangeNotices(content: string): string {
  return normalizeWireText(content)
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
    if (content.includes("codex app-server closed unexpectedly")) {
      return null;
    }
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
    const text = normalizeWireText(rec.text).trim();
    if (!text) continue;
    if (role === "status" && kind === "status" && !replayedLaneStatus(kind, text)) {
      continue;
    }
    return role === "ai" || role === "assistant" || (role === "status" && (kind === "execute" || kind === "error" || Boolean(replayedLaneStatus(kind, text))));
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
    if (role === "ai" || role === "assistant" || (role === "status" && (kind === "error" || kind === "execute"))) {
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
  consumeSessionReset?: (payload: Record<string, unknown>) => boolean;
  clearStepLive: ChatActions["clearStepLive"];
  sealActiveStreamingAssistant?: ChatActions["sealActiveStreamingAssistant"];
  commandKeyForWsEvent: ChatActions["commandKeyForWsEvent"];
  finalizeAssistant: ChatActions["finalizeAssistant"];
  finalizeCommandBlock: ChatActions["finalizeCommandBlock"];
  flushQueuedPrompts: ChatActions["flushQueuedPrompts"];
  ingestCommand: ChatActions["ingestCommand"];
  ingestCommandActivity: ChatActions["ingestCommandActivity"];
  ingestExploredActivity: ChatActions["ingestExploredActivity"];
  pushMessageBeforeLive: ChatActions["pushMessageBeforeLive"];
  threadReset: ChatActions["threadReset"];
  upsertExecuteBlock: ChatActions["upsertExecuteBlock"];
  upsertLiveActivity: ChatActions["upsertLiveActivity"];
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
    consumeSessionReset,
    clearStepLive,
    sealActiveStreamingAssistant,
    commandKeyForWsEvent,
    finalizeAssistant,
    finalizeCommandBlock,
    flushQueuedPrompts,
    ingestCommand,
    ingestCommandActivity,
    ingestExploredActivity,
    pushMessageBeforeLive,
    threadReset,
    upsertExecuteBlock,
    upsertLiveActivity,
    upsertStreamingDelta,
    replaceStreamingText,
  } = args;
  rt.inputLocked ??= { value: false };
  rt.laneStatus ??= { value: null };
  rt.retiredExecuteKeys ??= new Set<string>();
  let recoveredBackendActivitySeen = false;
  let terminalFenceActive = false;
  let terminalFenceSeq = 0;
  const legacyCommandTracks = new Map<string, {
    identity: string;
    terminal: boolean;
    sawOutput: boolean;
    endOffset: number;
    lastOutput: string;
  }>();
  const explicitCommandIdentities = new Map<string, string>();
  const seenCommandFrameIds = new Set<string>();
  let legacyCommandCounter = 0;

  const finiteOffset = (value: unknown): number | null => {
    const offset = Number(value);
    return Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : null;
  };

  const finiteTimestamp = (value: unknown): number | undefined => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : undefined;
  };

  const finiteSequence = (value: unknown): number | null => {
    const sequence = Number(value);
    return Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : null;
  };

  const markTurnActive = (payload: Record<string, unknown>): void => {
    const sequence = finiteSequence(payload.seq);
    if (terminalFenceActive && terminalFenceSeq > 0 && sequence !== null && sequence <= terminalFenceSeq) return;
    terminalFenceActive = false;
  };

  const markTurnTerminal = (payload: Record<string, unknown>): void => {
    terminalFenceActive = true;
    const sequence = finiteSequence(payload.seq);
    if (sequence !== null) terminalFenceSeq = Math.max(terminalFenceSeq, sequence);
  };

  const isStaleRuntimePayload = (payload: Record<string, unknown>): boolean => {
    if (!terminalFenceActive) return false;
    const barrier = finiteSequence(payload.afterSeq ?? payload.snapshotSeq ?? payload.seq);
    if (terminalFenceSeq > 0 && barrier !== null) return barrier <= terminalFenceSeq;
    return !rt.busy.value && !rt.turnInFlight;
  };

  const clearStreamTracking = (): void => {
    rt.streamEndOffsets?.clear();
    rt.streamSnapshotRevisions?.clear();
    legacyCommandTracks.clear();
    explicitCommandIdentities.clear();
    seenCommandFrameIds.clear();
    rt.latestExecuteKey = undefined;
    rt.latestExecuteSequence = undefined;
    rt.latestExecuteTimestamp = undefined;
    rt.retiredExecuteKeys.clear();
  };

  const resolveCommandIdentity = (payload: Record<string, unknown>, command: string, outputDelta: string): string => {
    const explicit = String(payload.identity ?? "").trim();
    if (explicit) return explicit;
    const id = String(payload.id ?? "").trim();
    if (id) {
      const key = `${id}\u0000${command}`;
      const known = explicitCommandIdentities.get(key);
      if (known) return known;
      const hasSameId = [...explicitCommandIdentities.keys()].some((entry) => entry.startsWith(`${id}\u0000`));
      const identity = hasSameId
        ? `${id}:${Array.from(command).reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381).toString(16)}`
        : id;
      explicitCommandIdentities.set(key, identity);
      return identity;
    }

    const key = command;
    const previous = legacyCommandTracks.get(key);
    const status = String(payload.status ?? "").trim().toLowerCase();
    const terminal = status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
    const header = outputDelta.replace(/^\s+/, "").startsWith(`$ ${command}\n`) || outputDelta.replace(/^\s+/, "").startsWith(`$ ${command}\r\n`);
    const startOffset = Number(payload.outputStartOffset ?? payload.output_start_offset);
    const endOffset = Number(payload.outputEndOffset ?? payload.output_end_offset);
    const offsetRollback = Number.isFinite(startOffset) && startOffset >= 0 && previous && startOffset < previous.endOffset;
    const duplicateTerminal = Boolean(
      previous?.terminal && terminal &&
      (!outputDelta || outputDelta === previous.lastOutput || (Number.isFinite(endOffset) && endOffset <= previous.endOffset)),
    );
    const startsNew = Boolean(
      !previous ||
      (!duplicateTerminal && previous.terminal) ||
      (!duplicateTerminal && offsetRollback) ||
      (!duplicateTerminal && header && (previous.sawOutput || previous.terminal)),
    );
    const identity = startsNew ? `legacy-command-${++legacyCommandCounter}` : previous.identity;
    legacyCommandTracks.set(key, {
      identity,
      terminal: previous?.terminal === true || terminal,
      sawOutput: previous?.sawOutput === true || Boolean(outputDelta),
      endOffset: Number.isFinite(endOffset) && endOffset >= 0
        ? Math.floor(endOffset)
        : (previous?.endOffset ?? 0) + outputDelta.length,
      lastOutput: outputDelta || previous?.lastOutput || "",
    });
    return identity;
  };

  const consumeAssistantDelta = (payload: Record<string, unknown>): void => {
    const delta = normalizeWireText(payload.delta);
    if (!delta) return;
    const streamId = String(payload.streamId ?? payload.stream_id ?? "").trim();
    const startOffset = finiteOffset(payload.startOffset ?? payload.start_offset);
    const endOffset = finiteOffset(payload.endOffset ?? payload.end_offset);
    let chunk = delta;
    if (streamId && startOffset !== null && endOffset !== null) {
      rt.streamEndOffsets ??= new Map<string, number>();
      const currentEnd = rt.streamEndOffsets.get(streamId) ?? 0;
      if (endOffset <= currentEnd) return;
      if (startOffset < currentEnd) {
        chunk = delta.slice(Math.min(delta.length, currentEnd - startOffset));
      }
      rt.streamEndOffsets.set(streamId, endOffset);
      if (!chunk) return;
    }
    const eventTs = finiteTimestamp(payload.ts);
    upsertStreamingDelta(
      chunk,
      rt,
      eventTs,
      streamId ? { preserveRepeatedText: true } : undefined,
    );
  };

  const consumeAssistantSnapshot = (payload: Record<string, unknown>): void => {
    const text = normalizeWireText(payload.text);
    if (!text || payload.active === false) return;
    if (isStaleRuntimePayload(payload)) return;
    const streamId = String(payload.streamId ?? payload.stream_id ?? "").trim();
    const revisionRaw = Number(payload.revision);
    const revision = Number.isFinite(revisionRaw) && revisionRaw > 0 ? Math.floor(revisionRaw) : 0;
    const startOffset = finiteOffset(payload.startOffset ?? payload.start_offset);
    const endOffset = finiteOffset(payload.endOffset ?? payload.end_offset);

    if (streamId) {
      rt.streamSnapshotRevisions ??= new Map<string, number>();
      rt.streamEndOffsets ??= new Map<string, number>();
      const previousRevision = rt.streamSnapshotRevisions.get(streamId) ?? 0;
      const previousEnd = rt.streamEndOffsets.get(streamId) ?? 0;
      if (revision > 0 && revision < previousRevision) return;
      if (revision > 0 && revision === previousRevision && endOffset !== null && endOffset <= previousEnd) return;
      if (revision === 0 && endOffset !== null && endOffset <= previousEnd) return;
      if (revision > 0) rt.streamSnapshotRevisions.set(streamId, Math.max(previousRevision, revision));
      if (endOffset !== null) rt.streamEndOffsets.set(streamId, Math.max(previousEnd, endOffset));
    }

    rt.busy.value = true;
    rt.turnInFlight = true;
    clearRecoveredBackendStatus();
    const eventTs = finiteTimestamp(payload.ts);
    replaceStreamingText(text, rt, eventTs);
    // `startOffset` is consumed by the ordering/dedup checks above. Keeping
    // the read here makes malformed snapshots explicit without changing the
    // backwards-compatible wire shape.
    void startOffset;
  };

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
    for (const clientMessageId of clientMessageIds) {
      clearPendingPrompt(rt, clientMessageId);
    }
    if (!pendingAckClientMessageId || matchedPendingAck) {
      rt.pendingAckClientMessageId = null;
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
      if (clientMessageId) serverUserClientMessageIds.add(clientMessageId);
      if (!newestServerUser) {
        newestServerUser = normalizeWireText(entry.text).trim();
      }
    }
    const completedClientMessageIds = collectCompletedClientMessageIdsFromHistoryItems(items);
    const backendStillRunning = rt.busy.value || rt.turnInFlight;
    if (completedClientMessageIds.size > 0) {
      reconcilePendingPromptsByClientMessageIds(completedClientMessageIds);
    } else if (backendStillRunning && serverUserClientMessageIds.size > 0) {
      const before = rt.queuedPrompts.value;
      const after = before.filter((prompt) => {
        const id = String(prompt.clientMessageId ?? "").trim();
        return !(
          id &&
          serverUserClientMessageIds.has(id) &&
          !prompt.serverQueueTracked &&
          (prompt.restoredFromStorage || prompt.replayIncomplete)
        );
      });
      if (after.length !== before.length) {
        const removedIds = new Set(
          before
            .filter((prompt) => !after.includes(prompt))
            .map((prompt) => String(prompt.clientMessageId ?? "").trim()),
        );
        rt.queuedPrompts.value = after;
        for (const clientMessageId of removedIds) {
          clearPendingPrompt(rt, clientMessageId);
        }
        const pendingAckClientMessageId = String(rt.pendingAckClientMessageId ?? "").trim();
        if (!pendingAckClientMessageId || removedIds.has(pendingAckClientMessageId)) {
          rt.pendingAckClientMessageId = null;
        }
      }
    } else if (newestServerUser && (terminalHistoryTail || backendStillRunning)) {
      const before = rt.queuedPrompts.value;
      const after = before.filter((prompt) =>
        prompt.serverQueueTracked || String(prompt.text ?? "").trim() !== newestServerUser,
      );
      if (after.length !== before.length) {
        const afterIds = new Set(after.map((prompt) => String(prompt.clientMessageId ?? "").trim()).filter(Boolean));
        const removedIds = before
          .map((prompt) => String(prompt.clientMessageId ?? "").trim())
          .filter((clientMessageId) => clientMessageId && !afterIds.has(clientMessageId));
        rt.queuedPrompts.value = after;
        for (const clientMessageId of removedIds) {
          clearPendingPrompt(rt, clientMessageId);
        }
        const pendingAckClientMessageId = String(rt.pendingAckClientMessageId ?? "").trim();
        if (!pendingAckClientMessageId || removedIds.includes(pendingAckClientMessageId)) {
          rt.pendingAckClientMessageId = null;
        }
      }
    }
    rt.awaitingBootstrapHistory = false;
  };

  const upsertTransientRetryNotice = (message: string, retryCount?: unknown): void => {
    const content = normalizeWireText(message).trim() || "Upstream model request failed temporarily; retrying.";
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
    if (rt.latestExecuteKey === normalizedKey) {
      rt.latestExecuteKey = undefined;
      rt.latestExecuteSequence = undefined;
      rt.latestExecuteTimestamp = undefined;
    }
  };

  const dropRedundantDiffExecuteBlocks = (): void => {
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    if (existing.length === 0) return;
    for (const msg of existing) {
      if (!msg || msg.kind !== "execute") continue;
      const cmd = normalizeWireCommand(msg.command).trim();
      const preview = normalizeWireText(msg.content);
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
      const filePath = normalizeWireText(file.path).trim();
      if (!filePath) continue;
      if (!turnPatchFilesByPath.has(filePath)) {
        turnPatchOrder.push(filePath);
      }
      turnPatchFilesByPath.set(filePath, {
        added: typeof file.added === "number" && Number.isFinite(file.added) ? file.added : null,
        removed: typeof file.removed === "number" && Number.isFinite(file.removed) ? file.removed : null,
      });
    }
    for (const [filePath, section] of splitUnifiedDiffByPath(normalizeWireText(patchMessage.patch.diff)).entries()) {
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
    const agentId = String(rt.activeAgentId.value ?? "").trim();
    writeModelPreference(sessionId, chatSessionId, agentId, {
      modelId: normalizeModelId(rt.modelId.value),
      effort: normalizeReasoningEffort(rt.modelReasoningEffort.value),
    });
  };

  const applyEffectiveState = (payload: Record<string, unknown>): void => {
    const activeAgentId = String(payload.activeAgentId ?? "").trim();
    if (activeAgentId) {
      rt.activeAgentId.value = activeAgentId;
    }
    // The payload's effective model/effort is the server's configured default
    // for this lane+agent. A selection already stored locally is the user's
    // explicit choice: handshake (welcome) and turn echo (result) frames must
    // not overwrite it, otherwise a reconnect silently reverts the selector.
    const sessionId = String(rt.projectSessionId ?? "").trim();
    const chatSessionId = String(rt.chatSessionId ?? "").trim() || "main";
    const preferenceAgentId = String(rt.activeAgentId.value ?? "").trim();
    const storedModelId = sessionId
      ? readModelIdPreference(sessionId, chatSessionId, preferenceAgentId)
      : null;
    const storedReasoningEffort = sessionId
      ? readReasoningEffortPreference(sessionId, chatSessionId, preferenceAgentId)
      : null;
    const effectiveModel = String(payload.effectiveModel ?? "").trim();
    if (effectiveModel) {
      rt.modelId.value = normalizeModelId(storedModelId ?? effectiveModel);
    }
    const effectiveReasoningEffort = String(payload.effectiveModelReasoningEffort ?? "").trim();
    if (effectiveReasoningEffort) {
      rt.modelReasoningEffort.value = normalizeReasoningEffort(storedReasoningEffort ?? effectiveReasoningEffort);
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
    const resetScope = String(payload.scope ?? "").trim().toLowerCase() || "lane";
    const sourceChatSessionId = String(payload.sourceChatSessionId ?? "").trim();
    if (resetScope === "shared" && effectiveChatSessionId === "advisor") {
      return;
    }
    if (resetScope !== "shared" && sourceChatSessionId !== effectiveChatSessionId) {
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
    clearStreamTracking();
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

  const applyMessage = (msg: unknown): void => {
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

    if (type === "ack") {
      const id = String(msg.client_message_id ?? "").trim();
      const acknowledged = id ? clearPendingPrompt(rt, id) : null;
      const existing = id
        ? rt.queuedPrompts.value.find((prompt) => prompt.clientMessageId === id)
        : undefined;
      const queued = existing ?? (id && acknowledged
        ? {
            id: `server-${id}`,
            clientMessageId: id,
            text: acknowledged.text,
            images: [],
            createdAt: acknowledged.createdAt,
            agentId: acknowledged.agentId,
            model: acknowledged.model,
            modelReasoningEffort: acknowledged.modelReasoningEffort,
          }
        : undefined);
      if (queued) {
        const rawStatus = String(msg.queue_status ?? "queued");
        if (rawStatus === "completed") {
          rt.queuedPrompts.value = rt.queuedPrompts.value.filter((prompt) => prompt.clientMessageId !== id);
        } else if (existing) {
          rt.queuedPrompts.value = rt.queuedPrompts.value.map((prompt) =>
              prompt.clientMessageId === id
                ? {
                    ...prompt,
                    deliveryStatus: rawStatus === "running" || rawStatus === "failed" ? rawStatus : "queued",
                    queueError: rawStatus === "failed" ? String(msg.error ?? prompt.queueError ?? "") : prompt.queueError,
                    serverQueueTracked: true,
                    restoredFromStorage: false,
                    replayIncomplete: false,
                  }
                : prompt,
            );
        } else {
          rt.queuedPrompts.value = [
            ...rt.queuedPrompts.value,
            {
              ...queued,
              deliveryStatus: rawStatus === "running" || rawStatus === "failed" ? rawStatus : "queued",
              queueError: rawStatus === "failed" ? String(msg.error ?? "") || undefined : undefined,
              serverQueueTracked: true,
            },
          ];
        }
      }
      if (id && rt.pendingAckClientMessageId === id) {
        rt.pendingAckClientMessageId = null;
      }
      return;
    }

    if (type === "prompt_queue_snapshot" || type === "prompt_queue") {
      const entries = type === "prompt_queue_snapshot"
        ? (Array.isArray(msg.entries) ? msg.entries : [])
        : (msg.entry && typeof msg.entry === "object" ? [msg.entry] : []);
      const activeIds = new Set<string>();
      for (const raw of entries) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        const clientMessageId = String(record.clientMessageId ?? "").trim();
        if (!clientMessageId) continue;
        clearPendingPrompt(rt, clientMessageId);
        const status = String(record.status ?? "queued") as "queued" | "running" | "failed" | "completed";
        activeIds.add(clientMessageId);
        const existing = rt.queuedPrompts.value.find((prompt) => prompt.clientMessageId === clientMessageId);
        if (status === "completed") {
          rt.queuedPrompts.value = rt.queuedPrompts.value.filter((prompt) => prompt.clientMessageId !== clientMessageId);
          continue;
        }
        const text = existing?.text
          || rt.messages.value.find((message) => message.id === clientMessageId)?.content
          || "Server queued request";
        rt.queuedPrompts.value = existing
          ? rt.queuedPrompts.value.map((prompt) => prompt.clientMessageId === clientMessageId
            ? {
                ...prompt,
                deliveryStatus: status,
                queuePosition: Number(record.position) || prompt.queuePosition,
                queueAttempts: Number(record.attempts) || prompt.queueAttempts,
                queueError: String(record.lastError ?? ""),
                serverQueueTracked: true,
                restoredFromStorage: false,
                replayIncomplete: false,
              }
            : prompt)
          : [...rt.queuedPrompts.value, {
              id: `server-${clientMessageId}`,
              clientMessageId,
              text,
              images: [],
              createdAt: Number(record.createdAt) || Date.now(),
              deliveryStatus: status,
              queuePosition: Number(record.position) || undefined,
              queueAttempts: Number(record.attempts) || undefined,
              queueError: String(record.lastError ?? "") || undefined,
              serverQueueTracked: true,
            }];
      }
      if (type === "prompt_queue_snapshot") {
        rt.queuedPrompts.value = rt.queuedPrompts.value.map((prompt) =>
          !activeIds.has(prompt.clientMessageId) &&
          !prompt.serverQueueTracked &&
          (prompt.deliveryStatus === undefined ||
            prompt.deliveryStatus === "awaiting_ack" ||
            prompt.deliveryStatus === "queued" ||
            prompt.restoredFromStorage ||
            prompt.replayIncomplete)
            ? { ...prompt, deliveryStatus: "offline", serverQueueTracked: false }
            : prompt,
        );
        rt.queuedPrompts.value = rt.queuedPrompts.value.filter(
          (prompt) => prompt.deliveryStatus === "offline" || activeIds.has(prompt.clientMessageId),
        );
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
          if (!rt.resumeReplacePending && !rt.awaitingBootstrapHistory) {
            rt.inputLocked.value = false;
          }
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
      if (handshakeReset) {
        terminalFenceActive = false;
        terminalFenceSeq = 0;
      }
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
        msg.historyMode !== "resume" &&
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
      terminalFenceActive = false;
      terminalFenceSeq = 0;
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
      if (consumeSessionReset && !consumeSessionReset(msg as Record<string, unknown>)) {
        return;
      }
      terminalFenceActive = false;
      terminalFenceSeq = 0;
      handleSharedSessionReset(msg as Record<string, unknown>);
      return;
    }

    if (type === "session_fallback") {
      // The provider lost the session mid-turn: this turn already ran without
      // the old context, so say so in the composer status surface.
      const rec = msg as Record<string, unknown>;
      const message = firstWireText(rec.message, rec.output, rec.text).trim();
      rt.laneStatus.value = {
        kind: "info",
        message: message || "原生会话已不存在，已改用新会话继续；下一轮会带上最近聊天历史。",
      };
      rt.threadWarning.value = null;
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
      const content = firstWireText(msg.message, msg.output, msg.text).trim();
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
        const historyGenerationRaw = Number((msg as Record<string, unknown>).laneGeneration);
        const historyGeneration = Number.isFinite(historyGenerationRaw) && historyGenerationRaw >= 1
          ? Math.floor(historyGenerationRaw)
          : null;
        const ignoredGenerationRaw = Number(rt.ignoreNextHistoryGeneration);
        const ignoredGeneration = Number.isFinite(ignoredGenerationRaw) && ignoredGenerationRaw >= 1
          ? Math.floor(ignoredGenerationRaw)
          : null;
        const isObsoleteGeneration =
          historyGeneration !== null && ignoredGeneration !== null && historyGeneration <= ignoredGeneration;
        const shouldDropHistory = items.length === 0 || isObsoleteGeneration;
        rt.ignoreNextHistory = false;
        rt.ignoreNextHistoryGeneration = undefined;
        if (shouldDropHistory) {
          dropReconnectBusyMessage();
          diagAlert("history帧被ignoreNextHistory吞掉", {
            chatSessionId: rt.chatSessionId,
            items: items.length,
            busy: rt.busy.value,
            terminalTail: terminalHistoryTail,
            historyGeneration,
            ignoredGeneration,
          });
          if (!rt.busy.value && !rt.turnInFlight) {
            rt.inputLocked.value = false;
            if (rt.laneStatus.value?.kind === "progress") {
              rt.laneStatus.value = null;
            }
            void flushQueuedPrompts(rt);
          }
          return;
        }
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
        const text = normalizeWireText(entry.text);
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
        // Intermediate reasoning and planning are intentionally not part of
        // the visible chat history. Older databases may still contain them;
        // skip them at the replay boundary instead of relying on the renderer.
        if (kind.startsWith("plan:") || kind === "plan" || kind === "thought" || role === "thought") {
          continue;
        }
        if (kind === "session_divider" || (role === "status" && kind === "session_divider") || (role === "system" && kind === "divider")) {
          restoredHistoryStatus = {
            kind: "info",
            message: "New session active: clean context (previous history is not included).",
          };
          next.push({
            id: `h-div-${idx}`,
            role: "system",
            kind: "divider",
            content: historyText || "Previous messages above are retained for review only and are NOT injected into model prompt context.",
            ts: ts ?? undefined,
          });
          continue;
        }
        if (role === "status") {
          restoredHistoryStatus = replayedLaneStatus(kind, historyText);
          if (kind === "error" && !isUserAbortFailure(historyText)) {
            // Anchor persisted turn failures to their user prompt so the
            // failed turn keeps a retry target after reconnects and reloads
            // instead of vanishing with the transient lane banner.
            next.splice(0, next.length, ...upsertTurnFailureCard(next, historyText, ts ?? undefined));
          }
          continue;
        }
        if (role === "user") {
          restoredHistoryStatus = null;
          const execution = parseExecutionFromHistoryKind(kind);
          const clientMessageId = parseClientMessageIdFromHistoryKind(kind);
          next.push({
            id: clientMessageId.includes("-") ? clientMessageId : `h-u-${idx}`,
            role: "user",
            kind: "text",
            content: historyText,
            ts: ts ?? undefined,
            ...(execution ? { execution } : {}),
          });
        } else if (role === "ai" || role === "assistant") {
          restoredHistoryStatus = null;
          next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: historyText, ts: ts ?? undefined });
        }
      }
      dropReconnectBusyMessage();
      applyResumeHistory(next, rt);
      const canTreatHistoryAsTerminal = terminalHistoryTail && !rt.busy.value && !rt.turnInFlight;
      if (canTreatHistoryAsTerminal) {
        terminalFenceActive = true;
        const historySequence = finiteSequence(msg.seq);
        if (historySequence !== null) terminalFenceSeq = Math.max(terminalFenceSeq, historySequence);
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

    if (type === "phase_complete") {
      sealActiveStreamingAssistant?.(rt);
      return;
    }

    if (type === "message") {
      const rec = msg as Record<string, unknown>;
      const role = String(rec.role ?? "").trim();
      const text = firstWireText(rec.text, rec.content).trim();
      const eventTsRaw = Number(rec.ts);
      const eventTs = Number.isFinite(eventTsRaw) && eventTsRaw > 0 ? Math.floor(eventTsRaw) : Date.now();
      if (role === "user") {
        markTurnActive(rec);
        const clientMessageId = String(rec.clientMessageId ?? rec.client_message_id ?? rec.jobId ?? "").trim();
        const existing = rt.messages.value;
        const lastUser = [...existing].reverse().find((m) => m.role === "user");
        const alreadyHas = clientMessageId
          ? existing.some((m) => m.id === clientMessageId)
          : Boolean(lastUser && lastUser.content === text && lastUser.ts === eventTs);
        if (!alreadyHas && text) {
          pushMessageBeforeLive({
            id: clientMessageId || randomId("u"),
            role: "user",
            kind: "text",
            content: text,
            ts: eventTs,
          }, rt);
        }
      } else if (role === "assistant" || role === "ai") {
        if (text) {
          sealActiveStreamingAssistant?.(rt);
          const existing = rt.messages.value;
          const alreadyHas = existing.some((m) => m.role === "assistant" && m.content === text);
          if (!alreadyHas) {
            pushMessageBeforeLive({
              id: String(rec.id ?? randomId("a")),
              role: "assistant",
              kind: "text",
              content: text,
              ts: eventTs,
            }, rt);
          }
        }
      } else if (role === "status") {
        if (text) {
          rt.laneStatus.value = { kind: "info", message: text };
        }
      }
      return;
    }

    if (
      type === "command"
      && typeof (msg as Record<string, unknown>).jobId === "string"
      && (msg as Record<string, unknown>).jobId.trim().length > 0
    ) {
      const rec = msg as Record<string, unknown>;
      const cmd = normalizeWireCommand(rec.command).trim();
      if (cmd) {
        const identity = String(rec.identity ?? rec.id ?? rec.jobId ?? "").trim() || null;
        const status = String(rec.status ?? "running").trim().toLowerCase();
        const terminal = status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
        const key = commandKeyForWsEvent(cmd, identity);
        if (key) {
          ingestCommand(cmd, rt, null);
          const output = normalizeWireText(rec.outputDelta ?? rec.output);
          upsertExecuteBlock(key, cmd, output, rt, {
            snapshot: true,
            terminal,
            eventId: String(rec.eventId ?? rec.id ?? `action-cmd:${identity ?? cmd}`).trim(),
            ts: Number(rec.ts) || Date.now(),
          } satisfies ExecuteBlockUpdate);
        }
      }
      return;
    }

    if (type === "assistant_done") {
      const rec = msg as Record<string, unknown>;
      const text = firstWireText(rec.text, rec.output, rec.content).trim();
      const jobId = String(rec.jobId ?? "").trim();
      const stableId = jobId ? `${jobId}:assistant_done` : "";
      const hadStreamingText = Boolean(text) && rt.messages.value.some((message) =>
        message.role === "assistant" && message.streaming && message.content === text,
      );
      sealActiveStreamingAssistant?.(rt);
      if (text && !hadStreamingText) {
        const existing = rt.messages.value;
        const alreadyHas = stableId
          ? existing.some((message) => message.id === stableId)
          : existing.some((message) => message.role === "assistant" && message.content === text);
        if (!alreadyHas) {
          pushMessageBeforeLive({
            id: stableId || randomId("action-assistant"),
            role: "assistant",
            kind: "text",
            content: text,
            ts: Number(rec.ts) || Date.now(),
          }, rt);
        }
      }
      return;
    }

    if (type === "action_job_updated") {
      const globalWindow = typeof window !== "undefined" ? (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: (payload: unknown) => void }) : null;
      if (typeof globalWindow?.__ADS_ON_ACTION_JOB_UPDATED__ === "function") {
        globalWindow.__ADS_ON_ACTION_JOB_UPDATED__(msg);
      }
      return;
    }

    if (type === "user") {
      markTurnActive(msg as Record<string, unknown>);
      const clientMessageId = String(msg.clientMessageId ?? msg.client_message_id ?? "").trim();
      if (clientMessageId) {
        rt.queuedPrompts.value = rt.queuedPrompts.value.filter(
          (prompt) => !prompt.serverQueueTracked || prompt.clientMessageId !== clientMessageId,
        );
      }
      const text = firstWireText(msg.text, msg.content).trim();
      const eventTsRaw = Number((msg as { ts?: unknown }).ts);
      const eventTs = Number.isFinite(eventTsRaw) && eventTsRaw > 0 ? Math.floor(eventTsRaw) : Date.now();
      const existing = rt.messages.value;
      const lastUser = [...existing].reverse().find((m) => m.role === "user");
      const alreadyHas = clientMessageId
        ? existing.some((m) => m.id === clientMessageId)
        : Boolean(lastUser && lastUser.content === text && lastUser.ts === eventTs);
      if (!alreadyHas && text) {
        const execution = parseExecutionFromHistoryKind(String(msg.kind ?? ""));
        pushMessageBeforeLive({
          id: clientMessageId || randomId("u"),
          role: "user",
          kind: "text",
          content: text,
          ts: eventTs,
          ...(execution ? { execution } : {}),
        }, rt);
      }
      return;
    }

    if (type === "in_flight") {
      const inFlight = (msg as { inFlight?: unknown }).inFlight;
      if (typeof inFlight !== "boolean") return;
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      if (inFlight) markTurnActive(msg as Record<string, unknown>);
      rt.busy.value = inFlight;
      rt.turnInFlight = inFlight;
      if (inFlight) {
        if (!rt.resumeReplacePending && !rt.awaitingBootstrapHistory) {
          rt.inputLocked.value = false;
        }
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
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      markTurnActive(msg as Record<string, unknown>);
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      const source = String(msg.source ?? "").trim();
      if (source === "thought" || source === "reasoning" || source === "step") {
        return;
      } else {
        consumeAssistantDelta(msg as Record<string, unknown>);
      }
      return;
    }

    if (type === "thought") {
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      markTurnActive(msg as Record<string, unknown>);
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      return;
    }

    if (type === "delta_snapshot") {
      // Catch-up only: the server never broadcasts this live. It carries the whole
      // assistant text accumulated so far, so a client that reconnected mid-turn
      // resumes the stream instead of losing everything emitted while it was gone.
      // Replaying it is idempotent — the streaming block is rewritten, not appended to.
      consumeAssistantSnapshot(msg as Record<string, unknown>);
      return;
    }

    if (type === "explored") {
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      rt.busy.value = true;
      rt.turnInFlight = true;
      clearRecoveredBackendStatus();
      const entry = msg.entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = normalizeWireText(typed.category).trim();
        const summary = normalizeWireText(typed.summary).trim();
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
      return;
    }

    if (type === "patch") {
      const rec = msg as Record<string, unknown>;
      const terminalArtifactReplay = rec.syncReplayMode === "terminal-artifact";
      const terminalArtifactFinal = rec.syncReplayFinal === true;
      if (!terminalArtifactReplay && isStaleRuntimePayload(rec)) return;
      if (!terminalArtifactReplay) {
        rt.busy.value = true;
        rt.turnInFlight = true;
        clearRecoveredBackendStatus();
      }
      const patch = msg.patch;
      if (!patch || typeof patch !== "object") return;

      const typed = patch as { files?: unknown; diff?: unknown; truncated?: unknown };
      const diff = normalizeWireText(typed.diff).trimEnd();
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
        const filePath = normalizeWireText(f.path).trim();
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

    if (type === "command_snapshot") {
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      const snapshot = msg.command && typeof msg.command === "object" && !Array.isArray(msg.command)
        ? (msg.command as Record<string, unknown>)
        : null;
      const cmd = normalizeWireCommand(snapshot?.command).trim();
      if (!cmd) return;
      const identity = firstWireText(snapshot?.identity, snapshot?.id, cmd).trim();
      const key = commandKeyForWsEvent(cmd, identity || null);
      if (!key) return;
      const status = String(snapshot?.status ?? "").trim().toLowerCase();
      const terminal = status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
      const eventTs = finiteTimestamp((msg as Record<string, unknown>).ts ?? snapshot?.ts);
      const revision = Number(snapshot?.revision);
      const snapshotSequence = Number((msg as Record<string, unknown>).seq ?? snapshot?.snapshotSeq ?? snapshot?.afterSeq);
      const isBootstrapSnapshot = (msg as Record<string, unknown>).bootstrap === true;
      if (!isBootstrapSnapshot && !terminal) {
        rt.busy.value = true;
        rt.turnInFlight = true;
      }
      clearRecoveredBackendStatus();
      ingestCommand(cmd, rt, identity || null);
      upsertExecuteBlock(key, cmd, normalizeWireText(snapshot?.output), rt, {
        snapshot: true,
        terminal,
        eventId: String(msg.eventId ?? msg.seq ?? `snapshot:${identity}:${revision || 0}`).trim(),
        revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : undefined,
        sequence: Number.isFinite(snapshotSequence) && snapshotSequence >= 0 ? Math.floor(snapshotSequence) : undefined,
        startOffset: finiteOffset(snapshot?.startOffset),
        endOffset: finiteOffset(snapshot?.endOffset),
        ts: eventTs,
      } satisfies ExecuteBlockUpdate);
      return;
    }

    if (type === "result") {
      const resultKind = String(msg.kind ?? "").trim();
      if (resultKind === "model_override") {
        const output = normalizeWireText(msg.output).trim();
        if (msg.ok === true) {
          const effectivePayload = {
            ...(msg as Record<string, unknown>),
            effectiveModel: msg.effectiveModel ?? msg.model,
            effectiveModelReasoningEffort:
              msg.effectiveModelReasoningEffort ?? msg.model_reasoning_effort,
          };
          applyEffectiveState(effectivePayload);
          const model = normalizeModelId(effectivePayload.effectiveModel);
          const effort = normalizeReasoningEffort(effectivePayload.effectiveModelReasoningEffort);
          rt.laneStatus.value = {
            kind: "info",
            message: model !== "auto"
              ? `Model switched to: ${model}${effort ? ` (${effort})` : ""}`
              : output || "Model switched.",
          };
        } else {
          rt.laneStatus.value = { kind: "error", message: output || "Model switch failed." };
        }
        return;
      }
      markTurnTerminal(msg as Record<string, unknown>);
      annotatePendingUserMessageExecution(msg as Record<string, unknown>);
      recoveredBackendActivitySeen = false;
      clearTransientRetryNotice();
      cancelPendingResume(rt);
      rt.inputLocked.value = false;
      rt.laneStatus.value = null;
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      clearStreamTracking();
      resetTurnPatchSummary();
      const terminalPromptId = String(rt.pendingAckClientMessageId ?? "").trim();
      rt.pendingAckClientMessageId = null;
      if (terminalPromptId) clearPendingPrompt(rt, terminalPromptId);
      const output = normalizeWireText(msg.output);
      if (msg.ok === true && resultKind === "clear_history") {
        rt.ignoreNextHistory = false;
        rt.ignoreNextHistoryGeneration = undefined;
      }
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
      finalizeCommandBlock(rt, { removeActiveExecuteBlocks: resultKind === "execute" });
      const resultCommand = normalizeWireCommand(msg.command).trim();
      if (resultKind === "execute" && resultCommand) {
        finalizeAssistant("", rt);
        const resultTsRaw = Number((msg as { ts?: unknown }).ts);
        const resultTs = Number.isFinite(resultTsRaw) && resultTsRaw > 0 ? Math.floor(resultTsRaw) : Date.now();
        pushMessageBeforeLive(
          buildExecuteMessage({ id: `exec:${randomId("result")}`, command: resultCommand, output, streaming: false, ts: resultTs }),
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
      const resultTsRaw = Number((msg as { ts?: unknown }).ts);
      const resultTs = Number.isFinite(resultTsRaw) && resultTsRaw > 0 ? Math.floor(resultTsRaw) : undefined;
      finalizeAssistant(output, rt, resultTs);
      void flushQueuedPrompts(rt);
      return;
    }

    if (type === "error") {
      const isTransientRetry = Boolean(msg.transient) && Boolean(msg.retryable);
      if (isTransientRetry) {
        upsertTransientRetryNotice(normalizeWireText(msg.message), msg.retryCount);
        return;
      }

      markTurnTerminal(msg as Record<string, unknown>);
      clearTransientRetryNotice();
      recoveredBackendActivitySeen = false;
      cancelPendingResume(rt);
      rt.inputLocked.value = false;
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      clearStreamTracking();
      resetTurnPatchSummary();
      const terminalPromptId = String(rt.pendingAckClientMessageId ?? "").trim();
      rt.pendingAckClientMessageId = null;
      if (terminalPromptId) clearPendingPrompt(rt, terminalPromptId);
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      // Ensure the assistant placeholder created when the prompt was sent does not
      // linger across turns (which can make the next user prompt appear below an
      // unrelated assistant block).
      finalizeAssistant("", rt);

      const errorInfo = msg.errorInfo && typeof msg.errorInfo === "object"
        ? (msg.errorInfo as { code?: string; retryable?: boolean; needsReset?: boolean })
        : undefined;

      const userMessage = normalizeWireText(msg.message) || "error";
      const isUserAbort = isUserAbortFailure(userMessage, (msg as { aborted?: unknown }).aborted);
      const errorContent = errorInfo
        ? `⚠️ ${userMessage}\n\n` +
          `错误类型: ${errorInfo.code ?? "unknown"}\n` +
          (errorInfo.retryable ? "💡 可以重试\n" : "") +
          (errorInfo.needsReset ? "⚠️ 建议使用 /reset 重置会话\n" : "")
        : userMessage;

      rt.laneStatus.value = { kind: "error", message: errorContent };
      // Persist genuine failures on the user turn so the error survives lane
      // status cleanup and page reloads, and so the turn can be retried in
      // place. Intentional user aborts remain lane status only. The record
      // content mirrors the history entry persisted by the server (`[code]
      // hint`) so replay and live events converge on one retry target.
      if (!isUserAbort) {
        const failureCardContent = errorInfo?.code ? `[${errorInfo.code}] ${userMessage}` : userMessage;
        rt.messages.value = upsertTurnFailureCard(
          rt.messages.value,
          failureCardContent,
          finiteTimestamp((msg as { ts?: unknown }).ts),
        );
      }
      void flushQueuedPrompts(rt, { preserveErrorStatus: true });
      return;
    }

    if (type === "command") {
      if (isStaleRuntimePayload(msg as Record<string, unknown>)) return;
      markTurnActive(msg as Record<string, unknown>);
      const payload = msg.command && typeof msg.command === "object" ? (msg.command as Record<string, unknown>) : null;
      const cmd = normalizeWireCommand(payload?.command).trim();
      const rawOutputDelta = normalizeWireText(payload?.outputDelta);
      const identity = resolveCommandIdentity(payload ?? {}, cmd, rawOutputDelta);
      const key = commandKeyForWsEvent(cmd, identity || null);
      if (!key) return;
      let outputDelta = rawOutputDelta;
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
      ingestCommand(cmd, rt, identity || null);
      const eventTsRaw = Number((msg as { ts?: unknown }).ts ?? payload?.ts);
      const eventTs = Number.isFinite(eventTsRaw) && eventTsRaw > 0 ? Math.floor(eventTsRaw) : undefined;
      const status = String(payload?.status ?? "").trim().toLowerCase();
      const terminal = status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
      const seq = Number((msg as { seq?: unknown }).seq);
      const eventId = String((msg as { eventId?: unknown }).eventId ?? (Number.isFinite(seq) && seq > 0 ? `seq:${Math.floor(seq)}` : "")).trim();
      const startOffset = finiteOffset(payload?.outputStartOffset ?? payload?.output_start_offset);
      const endOffset = finiteOffset(payload?.outputEndOffset ?? payload?.output_end_offset);
      if (rt.turnHasPatch && isGitDiffCommand(cmd) && looksLikeUnifiedDiff(outputDelta)) {
        dropExecuteBlockForKey(key);
      } else {
        upsertExecuteBlock(key, cmd, outputDelta, rt, {
          ts: eventTs,
          eventId: eventId || undefined,
          sequence: Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : undefined,
          terminal,
          startOffset,
          endOffset,
        });
      }
      if (cmd) {
        ingestCommandActivity(rt.liveActivity, cmd);
        upsertLiveActivity(rt);
      }
      return;
    }
  };

  return (msg: unknown): void => {
    crumb(`ws:${String((msg as { type?: unknown })?.type ?? "?")}`);
    applyMessage(msg);
    const current = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    const normalized = normalizeTurnSemanticOrder(current);
    if (normalized.length !== current.length || normalized.some((item, index) => item !== current[index])) {
      rt.messages.value = normalized;
    }
  };
}
