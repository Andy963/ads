import crypto from "node:crypto";

import { deriveProjectSessionId } from "../projectSessionId.js";

export function parseWsSessionFromProtocols(protocols: string[]): string | null {
  for (let i = 0; i < protocols.length; i++) {
    const entry = protocols[i] ?? "";
    if (entry.startsWith("ads-session.")) {
      return entry.slice("ads-session.".length).trim() || null;
    }
    if (entry.startsWith("ads-session:")) {
      return entry.split(":").slice(1).join(":").trim() || null;
    }
    if (entry === "ads-session" && i + 1 < protocols.length) {
      const next = protocols[i + 1] ?? "";
      return String(next).trim() || null;
    }
  }
  return null;
}

export function parseWsChatSessionFromProtocols(protocols: string[]): string | null {
  for (let i = 0; i < protocols.length; i++) {
    const entry = protocols[i] ?? "";
    if (entry.startsWith("ads-chat.")) {
      return entry.slice("ads-chat.".length).trim() || null;
    }
    if (entry.startsWith("ads-chat:")) {
      return entry.split(":").slice(1).join(":").trim() || null;
    }
    if (entry === "ads-chat" && i + 1 < protocols.length) {
      const next = protocols[i + 1] ?? "";
      return String(next).trim() || null;
    }
  }
  return null;
}

export function resolveWebSocketSessionId(args: { protocols: string[]; workspaceRoot: string }): string {
  const requested = parseWsSessionFromProtocols(args.protocols);
  if (requested && requested !== "default") {
    return requested;
  }
  if (requested === "default") {
    return deriveProjectSessionId(args.workspaceRoot);
  }
  return crypto.randomBytes(4).toString("hex");
}

export function resolveWebSocketChatSessionId(args: { protocols: string[] }): string {
  const requested = parseWsChatSessionFromProtocols(args.protocols);
  const normalized = String(requested ?? "").trim();
  return normalized || "main";
}

export function matchesBroadcastSessionId(args: {
  broadcastSessionId: string;
  connectionSessionId: string;
  connectionWorkspaceRoot?: string | null;
}): boolean {
  const broadcastSessionId = String(args.broadcastSessionId ?? "").trim();
  if (!broadcastSessionId) return false;

  const connectionSessionId = String(args.connectionSessionId ?? "").trim();
  if (connectionSessionId === broadcastSessionId) return true;

  const workspaceRoot = String(args.connectionWorkspaceRoot ?? "").trim();
  if (!workspaceRoot) return false;
  return deriveProjectSessionId(workspaceRoot) === broadcastSessionId;
}
