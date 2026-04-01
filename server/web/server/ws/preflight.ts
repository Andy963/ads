import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsMessage } from "./schema.js";

import { buildPromptHistoryText } from "./promptHistory.js";

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
  traceWsDuplication: boolean;
  warn: (message: string) => void;
  sessionId: string;
  userId: number;
}): { enqueue: boolean } {
  if (!args.clientMessageId) {
    return { enqueue: true };
  }
  const entryKind = `client_message_id:${args.clientMessageId}`;

  if (args.parsed.type === "prompt") {
    const textResult = buildPromptHistoryText(args.parsed.payload, args.sanitizeInput);
    if (!textResult.ok) {
      return { enqueue: true };
    }
    const inserted = args.historyStore.add(args.historyKey, {
      role: "user",
      text: textResult.text,
      ts: args.receivedAt,
      kind: entryKind,
    });
    args.sendJson({ type: "ack", client_message_id: args.clientMessageId, duplicate: !inserted });
    if (!inserted) {
      if (args.traceWsDuplication) {
        args.warn(
          `[WebSocket][Dedupe] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} client_message_id=${args.clientMessageId}`,
        );
      }
      return { enqueue: false };
    }
    return { enqueue: true };
  }

  if (args.parsed.type === "command") {
    const cmd = shouldPersistCommandMessage({
      sanitizeInput: args.sanitizeInput,
      payload: args.parsed.payload,
    });
    if (!cmd.ok || !cmd.shouldPersist) {
      return { enqueue: true };
    }
    const inserted = args.historyStore.add(args.historyKey, {
      role: "user",
      text: cmd.command,
      ts: args.receivedAt,
      kind: entryKind,
    });
    args.sendJson({ type: "ack", client_message_id: args.clientMessageId, duplicate: !inserted });
    if (!inserted) {
      if (args.traceWsDuplication) {
        args.warn(
          `[WebSocket][Dedupe] req=${args.requestId} session=${args.sessionId} user=${args.userId} history=${args.historyKey} client_message_id=${args.clientMessageId}`,
        );
      }
      return { enqueue: false };
    }
    return { enqueue: true };
  }

  return { enqueue: true };
}
