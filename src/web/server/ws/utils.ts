import type { WebSocket } from "ws";

import type { CommandExecutionItem } from "../../../agents/protocol/types.js";

import type { AgentEvent } from "../../../codex/events.js";
import { truncateForLog } from "../../utils.js";

const WS_READY_OPEN = 1;

export function summarizeWsPayloadForLog(payload: unknown): string {
  if (payload === undefined) {
    return "";
  }
  if (typeof payload === "string") {
    return truncateForLog(payload, 160);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return truncateForLog(String(payload), 160);
  }
  const rec = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.command === "string") {
    parts.push(`command=${truncateForLog(rec.command, 160)}`);
  }
  if (typeof rec.text === "string") {
    parts.push(`text=${truncateForLog(rec.text, 160)}`);
  }
  if (Array.isArray(rec.images)) {
    parts.push(`images=${rec.images.length}`);
  }
  if (parts.length > 0) {
    return `{${parts.join(" ")}}`;
  }
  const keys = Object.keys(rec).slice(0, 8).join(",");
  return keys ? `{keys=${keys}}` : "{object}";
}

export function createSafeJsonSend(logger: { warn: (message: string, ...args: unknown[]) => void }): (ws: WebSocket, payload: unknown) => void {
  return (ws, payload) => {
    if (ws.readyState !== WS_READY_OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[WebSocket] Failed to send message: ${message}`);
    }
  };
}

export function formatCloseReason(reason: unknown): string {
  if (!reason) {
    return "";
  }
  if (typeof reason === "string") {
    return reason.trim();
  }
  if (Buffer.isBuffer(reason)) {
    return reason.toString("utf8").trim();
  }
  if (Array.isArray(reason)) {
    try {
      const chunks = reason.filter((entry) => Buffer.isBuffer(entry)) as Buffer[];
      if (chunks.length === 0) {
        return "";
      }
      return Buffer.concat(chunks).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  if (reason instanceof ArrayBuffer) {
    try {
      return Buffer.from(reason).toString("utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

export function extractCommandPayload(
  event: AgentEvent,
): { id?: string; command?: string; status?: string; exit_code?: number; aggregated_output?: string } | null {
  const raw = event.raw as { type?: string; item?: CommandExecutionItem };
  if (!raw || typeof raw !== "object") return null;
  if (!["item.started", "item.updated", "item.completed"].includes(raw.type ?? "")) {
    return null;
  }
  const item = raw.item;
  if (!item || (item as CommandExecutionItem).type !== "command_execution") {
    return null;
  }
  const cmd = item as CommandExecutionItem;
  return {
    id: cmd.id,
    command: cmd.command,
    status: cmd.status,
    exit_code: cmd.exit_code,
    aggregated_output: cmd.aggregated_output,
  };
}
