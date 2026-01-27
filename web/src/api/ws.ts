import { encodeBase64Url } from "../lib/base64url";
import type { TaskEventPayload } from "./types";

type WsCommandPayload = {
  id?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  outputDelta?: string;
};

type WsMessage =
  | { type: "welcome"; sessionId?: string; workspace?: unknown; threadId?: string }
  | { type: "history"; items: Array<{ role: string; text: string; ts: number; kind?: string }> }
  | { type: "delta"; delta?: string }
  | { type: "result"; ok: boolean; output: string }
  | { type: "error"; message?: string }
  | { type: "command"; detail?: string; command?: WsCommandPayload | null }
  | { type: "task:event"; event: TaskEventPayload["event"]; data: unknown; ts?: number }
  | { type: string; [k: string]: unknown };

export class AdsWebSocket {
  private ws: WebSocket | null = null;
  private readonly token: string;
  private readonly sessionId: string;
  private pingTimer: number | null = null;

  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: () => void;
  onTaskEvent?: (payload: { event: TaskEventPayload["event"]; data: unknown }) => void;
  onMessage?: (msg: WsMessage) => void;

  constructor(options: { token: string; sessionId?: string }) {
    this.token = options.token;
    this.sessionId = options.sessionId ?? cryptoRandomId();
  }

  send(type: string, payload?: unknown): void {
    try {
      this.ws?.send(JSON.stringify({ type, payload }));
    } catch {
      // ignore
    }
  }

  sendPrompt(payload: unknown): void {
    this.send("prompt", payload);
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
    const tokenProto = this.token ? `ads-token.${encodeBase64Url(this.token)}` : "";
    const protocols = ["ads-v1", tokenProto, `ads-session.${this.sessionId}`].filter(Boolean);

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
