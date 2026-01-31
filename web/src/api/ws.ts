import type { TaskEventPayload } from "./types";

type WsCommandPayload = {
  id?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  outputDelta?: string;
};

type WsPatchFile = {
  path: string;
  added: number | null;
  removed: number | null;
};

type WsPatchPayload = {
  files: WsPatchFile[];
  diff: string;
  truncated?: boolean;
};

type WsMessage =
  | { type: "welcome"; sessionId?: string; chatSessionId?: string; workspace?: unknown; threadId?: string; reset?: boolean }
  | { type: "ack"; client_message_id?: string; duplicate?: boolean }
  | { type: "history"; items: Array<{ role: string; text: string; ts: number; kind?: string }> }
  | { type: "delta"; delta?: string; source?: "chat" | "step" }
  | { type: "result"; ok: boolean; output: string; kind?: string }
  | { type: "error"; message?: string }
  | { type: "thread_reset" }
  | { type: "command"; detail?: string; command?: WsCommandPayload | null }
  | { type: "patch"; patch?: WsPatchPayload | null }
  | { type: "task:event"; event: TaskEventPayload["event"]; data: unknown; ts?: number }
  | { type: string; [k: string]: unknown };

export class AdsWebSocket {
  private ws: WebSocket | null = null;
  private readonly sessionId: string;
  private readonly chatSessionId: string;
  private pingTimer: number | null = null;

  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: () => void;
  onTaskEvent?: (payload: { event: TaskEventPayload["event"]; data: unknown }) => void;
  onMessage?: (msg: WsMessage) => void;

  constructor(options: { sessionId?: string; chatSessionId?: string }) {
    this.sessionId = options.sessionId ?? cryptoRandomId();
    this.chatSessionId = String(options.chatSessionId ?? "").trim() || "main";
  }

  send(type: string, payload?: unknown, options?: { clientMessageId?: string }): void {
    try {
      const clientMessageId = String(options?.clientMessageId ?? "").trim();
      const msg =
        clientMessageId
          ? { type, payload, client_message_id: clientMessageId }
          : { type, payload };
      this.ws?.send(JSON.stringify(msg));
    } catch {
      // ignore
    }
  }

  sendPrompt(payload: unknown, clientMessageId?: string): void {
    const id = String(clientMessageId ?? "").trim() || cryptoRandomUuid();
    this.send("prompt", payload, { clientMessageId: id });
  }

  interrupt(): void {
    this.send("interrupt");
  }

  clearHistory(): void {
    this.send("clear_history");
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const url = proto + location.host + "/ws";
    const protocols = ["ads-v1", `ads-session.${this.sessionId}`, `ads-chat.${this.chatSessionId}`].filter(Boolean);

    this.ws = new WebSocket(url, protocols);
    this.ws.onopen = () => {
      this.startPing();
      this.onOpen?.();
    };
    this.ws.onerror = () => {
      this.stopPing();
      this.onError?.();
    };
    this.ws.onclose = (ev) => {
      this.stopPing();
      this.onClose?.(ev);
    };
    this.ws.onmessage = (ev) => {
      const raw = String(ev.data ?? "");
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw) as WsMessage;
      } catch {
        return;
      }
      if (msg.type === "task:event") {
        this.onTaskEvent?.({ event: msg.event, data: msg.data });
        return;
      }
      this.onMessage?.(msg);
    };
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    } finally {
      this.stopPing();
      this.ws = null;
    }
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    // Keep the backend connection alive through intermediaries (dev proxies, NAT, etc).
    this.pingTimer = window.setInterval(() => {
      try {
        this.send("ping", { ts: Date.now() });
      } catch {
        // ignore
      }
    }, 10_000);
  }

  private stopPing(): void {
    if (this.pingTimer === null) return;
    try {
      clearInterval(this.pingTimer);
    } catch {
      // ignore
    }
    this.pingTimer = null;
  }
}

function cryptoRandomId(): string {
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return String(Date.now());
  }
}

function cryptoRandomUuid(): string {
  try {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  // RFC 4122 v4 fallback
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  } catch {
    return `${Date.now()}-${cryptoRandomId()}`;
  }
}
