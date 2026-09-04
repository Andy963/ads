import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsMessage } from "./schema.js";

import {
  buildClientMessageHistoryKind,
  getHistoryClientMessageId,
} from "../../../utils/historyKind.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { buildPromptHistoryText } from "./promptHistory.js";

export function isClientMessageCompleted(entries: HistoryEntry[], clientMessageId: string): boolean {
  let awaitingTerminal = false;
  for (const entry of entries) {
    if (entry.role === "user") {
      awaitingTerminal = getHistoryClientMessageId(entry.kind) === clientMessageId;
      continue;
    }
    if (awaitingTerminal && (entry.role === "ai" || (entry.role === "status" && entry.kind === "error"))) {
      return true;
    }
  }
  return false;
}

export function shouldPersistCommandMessage(args: {
  sanitizeInput: (payload: unknown) => string;
  payload: unknown;
}): { ok: boolean; command: string; shouldPersist: boolean } {
  const commandRaw = args.sanitizeInput(args.payload);
  if (!commandRaw) {
    return { ok: false, command: "", shouldPersist: false };
  }
  const command = commandRaw.trim();
  if (!command) {
    return { ok: false, command: "", shouldPersist: false };
  }
  const isSilent =
    args.payload !== null &&
    typeof args.payload === "object" &&
    !Array.isArray(args.payload) &&
    (args.payload as Record<string, unknown>).silent === true;
  const isCd = /^\/cd\b/i.test(command);
  return { ok: true, command, shouldPersist: !isSilent && !isCd };
}

export function preflightPersistAndAck(args: {
  parsed: WsMessage;
  requestId: string;
  clientMessageId: string | null;
  receivedAt: number;
  historyStore: HistoryStore;
  historyKey: string;
  sanitizeInput: (payload: unknown) => string;
  sendJson: (payload: unknown) => void;
  broadcastPersistedHistory?: () => void;
  broadcastInFlight?: () => void;
  inFlight?: boolean;
  isLaneCurrent?: () => boolean;
  traceWsDuplication: boolean;
  warn: (message: string) => void;
  sessionId: string;
  userId: number;
  onPersistedMessage?: (message: { clientMessageId: string; role: "user"; text: string }) => void;
  emitUserSyncEvent?: (event: { type: "user"; clientMessageId: string; text: string; ts: number; eventId?: string }) => { ok: boolean };
}): { enqueue: boolean } {
  if (args.isLaneCurrent && !args.isLaneCurrent() && args.parsed.type !== "clear_history") {
    return { enqueue: false };
  }
  if (!args.clientMessageId) {
    return { enqueue: true };
  }
  if (args.parsed.type === "prompt") {
    const textResult = buildPromptHistoryText(args.parsed.payload, args.sanitizeInput);
    if (!textResult.ok) {
      return { enqueue: true };
    }
    const payload = args.parsed.payload && typeof args.parsed.payload === "object" && !Array.isArray(args.parsed.payload)
      ? (args.parsed.payload as Record<string, unknown>)
      : {};
    const entryKind = buildClientMessageHistoryKind({
      clientMessageId: args.clientMessageId,
      metadata: {
        agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        modelReasoningEffort:
          typeof payload.modelReasoningEffort === "string"
            ? payload.modelReasoningEffort
            : typeof payload.model_reasoning_effort === "string"
              ? payload.model_reasoning_effort
              : undefined,
      },
    });
    const persistence = args.historyStore.addWithResult(args.historyKey, {
      role: "user",
      text: textResult.text,
      ts: args.receivedAt,
      kind: entryKind,
    });
    if (args.isLaneCurrent && !args.isLaneCurrent()) {
      return { enqueue: false };
    }
    if (persistence === "failed") {
      args.warn(
        `[WebSocket][Persist] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} failed to persist prompt`,
      );
      args.sendJson({ type: "error", message: "消息保存失败，请重试" });
      return { enqueue: false };
    }
    if (persistence === "duplicate") {
      args.sendJson({ type: "ack", client_message_id: args.clientMessageId, duplicate: true });
      const historyEntries = args.historyStore.get(args.historyKey);
      const persistedPrompt = historyEntries.find(
        (entry) =>
          entry.role === "user" &&
          getHistoryClientMessageId(entry.kind) === args.clientMessageId,
      );
      const replayIncomplete =
        payload.replay_incomplete === true &&
        !args.inFlight &&
        persistedPrompt?.text === textResult.text &&
        !isClientMessageCompleted(historyEntries, args.clientMessageId);
      if (args.traceWsDuplication) {
        args.warn(
          `[WebSocket][Dedupe] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} client_message_id=${args.clientMessageId} replay_incomplete=${replayIncomplete}`,
        );
      }
      if (replayIncomplete) {
        args.broadcastInFlight?.();
      }
      return { enqueue: replayIncomplete };
    }
    if (args.emitUserSyncEvent) {
      const syncRes = args.emitUserSyncEvent({
        type: "user",
        clientMessageId: args.clientMessageId,
        text: textResult.text,
        ts: args.receivedAt,
        eventId: "user:" + args.clientMessageId,
      });
      if (!syncRes.ok) {
        // Roll back only the prompt inserted by this attempt so a retry can succeed.
        const rolledBack = args.historyStore.removeByExactKind(args.historyKey, entryKind);
        if (!rolledBack) {
          args.warn("[WebSocket][Sync] failed to roll back prompt history entry");
        }
        args.warn("[WebSocket][Sync] failed to append user sync event; rolled back prompt entry");
        args.sendJson({ type: "error", message: "消息保存失败，请重试" });
        return { enqueue: false };
      }
    }
    args.sendJson({ type: "ack", client_message_id: args.clientMessageId, duplicate: false });
    args.onPersistedMessage?.({ clientMessageId: args.clientMessageId, role: "user", text: textResult.text });
    args.broadcastPersistedHistory?.();
    args.broadcastInFlight?.();
    return { enqueue: true };
  }

  if (args.parsed.type === "command") {
    const entryKind = buildClientMessageHistoryKind({ clientMessageId: args.clientMessageId });
    const cmd = shouldPersistCommandMessage({
      sanitizeInput: args.sanitizeInput,
      payload: args.parsed.payload,
    });
    if (!cmd.ok || !cmd.shouldPersist) {
      return { enqueue: true };
    }
    const persistence = args.historyStore.addWithResult(args.historyKey, {
      role: "user",
      text: cmd.command,
      ts: args.receivedAt,
      kind: entryKind,
    });
    if (args.isLaneCurrent && !args.isLaneCurrent()) {
      return { enqueue: false };
    }
    if (persistence === "failed") {
      args.warn(
        `[WebSocket][Persist] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} failed to persist command`,
      );
      args.sendJson({ type: "error", message: "消息保存失败，请重试" });
      return { enqueue: false };
    }
    args.sendJson({ type: "ack", client_message_id: args.clientMessageId, duplicate: persistence === "duplicate" });
    if (persistence === "duplicate") {
      if (args.traceWsDuplication) {
        args.warn(
          `[WebSocket][Dedupe] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} client_message_id=${args.clientMessageId}`,
        );
      }
      return { enqueue: false };
    }
    args.broadcastPersistedHistory?.();
    args.broadcastInFlight?.();
    return { enqueue: true };
  }

  return { enqueue: true };
}
