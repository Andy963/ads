import type { RawData } from "ws";

import { wsMessageSchema, type WsMessage } from "./schema.js";

export type ParsedWsEnvelope =
  | {
      ok: true;
      parsed: WsMessage;
      receivedAt: number;
      nextReceivedAt: number;
      clientMessageId: string | null;
    }
  | {
      ok: false;
      nextReceivedAt: number;
      errorMessage: string;
    };

export function parseIncomingWsEnvelope(args: {
  data: RawData;
  lastReceivedAt: number;
  now?: number;
}): ParsedWsEnvelope {
  const now = args.now ?? Date.now();
  const receivedAt = now > args.lastReceivedAt ? now : args.lastReceivedAt + 1;

  try {
    const raw = JSON.parse(String(args.data)) as unknown;
    const result = wsMessageSchema.safeParse(raw);
    if (!result.success) {
      return { ok: false, nextReceivedAt: receivedAt, errorMessage: "Invalid message payload" };
    }
    const parsed = result.data;
    const clientMessageIdRaw = String(parsed.client_message_id ?? "").trim();
    return {
      ok: true,
      parsed,
      receivedAt,
      nextReceivedAt: receivedAt,
      clientMessageId: clientMessageIdRaw || null,
    };
  } catch {
    return { ok: false, nextReceivedAt: receivedAt, errorMessage: "Invalid JSON message" };
  }
}

export function handleImmediateWsMessage(args: {
  parsed: WsMessage;
  receivedAt: number;
  abortInFlight: () => boolean;
  sendJson: (payload: unknown) => void;
}): boolean {
  if (args.parsed.type === "ping") {
    args.sendJson({ type: "pong", ts: args.receivedAt });
    return true;
  }
  if (args.parsed.type === "pong") {
    return true;
  }
  if (args.parsed.type === "interrupt") {
    const found = args.abortInFlight();
    if (!found) {
      args.sendJson({ type: "error", message: "当前没有正在执行的任务" });
    }
    return true;
  }
  return false;
}
