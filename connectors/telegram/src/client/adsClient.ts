import WebSocket from "ws";

export interface AdsClientOptions {
  coreUrl: string;
  coreWsUrl: string;
  token?: string;
  sessionId?: string;
  chatSessionId?: string;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
}

export interface PromptTurnOptions {
  text: string;
  images?: Array<{ type: string; data?: string; path?: string; mimeType?: string }>;
  channel?: "telegram";
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
  timeoutMs?: number;
}

export interface AdsEvent {
  type: string;
  [key: string]: unknown;
}

export class AdsCoreClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly eventListeners = new Set<(event: AdsEvent) => void>();
  private pendingPrompts = new Map<string, {
    resolve: (reply: string) => void;
    reject: (err: Error) => void;
    accumulatedText: string;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly options: AdsClientOptions) {}

  async connect(): Promise<void> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.options.token) {
        headers["Authorization"] = `Bearer ${this.options.token}`;
      }

      const protocols = [
        "ads-v1",
        `ads-session.${this.options.sessionId ?? "telegram"}`,
        `ads-chat.${this.options.chatSessionId ?? "main"}`,
      ];
      const ws = new WebSocket(this.options.coreWsUrl, protocols, { headers });
      this.ws = ws;

      let settled = false;
      const onOpen = () => {
        if (!settled) {
          settled = true;
          this.isConnected = true;
          resolve();
        }
      };

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.once("open", onOpen);
      ws.once("error", onError);

      ws.on("message", (data: WebSocket.RawData) => {
        this.handleIncomingMessage(data);
      });

      ws.on("close", () => {
        if (this.ws === ws) {
          this.isConnected = false;
          this.ws = null;
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.options.autoReconnect || this.reconnectTimer) {
      return;
    }
    const delay = this.options.reconnectIntervalMs ?? 5_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, Math.max(0, delay));
    this.reconnectTimer.unref?.();
  }

  private handleIncomingMessage(raw: WebSocket.RawData): void {
    try {
      const parsed = JSON.parse(String(raw)) as AdsEvent;
      for (const listener of this.eventListeners) {
        try { listener(parsed); } catch { /* ignore */ }
      }

      const clientMsgId = typeof parsed.clientMessageId === "string" ? parsed.clientMessageId : "";
      const fallbackPending = !clientMsgId && this.pendingPrompts.size === 1 ? this.pendingPrompts.entries().next().value : undefined;
      const resolvedId = clientMsgId || (Array.isArray(fallbackPending) ? String(fallbackPending[0]) : "");
      const pending = resolvedId ? this.pendingPrompts.get(resolvedId) : undefined;

      if (parsed.type === "delta" && pending) {
        const text = typeof parsed.delta === "string" ? parsed.delta : "";
        pending.accumulatedText += text;
      } else if (parsed.type === "result" && pending) {
        const text = typeof parsed.output === "string" ? parsed.output : pending.accumulatedText;
        clearTimeout(pending.timer);
        this.pendingPrompts.delete(resolvedId);
        pending.resolve(text);
      } else if (parsed.type === "error" && pending) {
        clearTimeout(pending.timer);
        this.pendingPrompts.delete(resolvedId);
        pending.reject(new Error(String(parsed.error ?? "ADS Core prompt failed")));
      }
    } catch {
      // ignore malformed frame
    }
  }

  async sendPrompt(options: PromptTurnOptions): Promise<{ finalResponse: Promise<string>; clientMessageId: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const clientMessageId = options.clientMessageId ?? `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      text: options.text,
      images: options.images,
      channel: options.channel ?? "telegram",
      metadata: options.metadata,
    };

    const timeoutMs = options.timeoutMs ?? 180_000;
    const finalResponse = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrompts.delete(clientMessageId);
        reject(new Error(`Prompt timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingPrompts.set(clientMessageId, {
        resolve,
        reject,
        accumulatedText: "",
        timer,
      });
    });

    const message = {
      type: "prompt",
      client_message_id: clientMessageId,
      payload,
    };

    this.ws!.send(JSON.stringify(message));
    return { finalResponse, clientMessageId };
  }

  async sendInterrupt(): Promise<void> {
    await this.sendControl("interrupt");
  }

  async clearHistory(): Promise<void> {
    await this.sendControl("clear_history");
  }

  private async sendControl(type: "interrupt" | "clear_history"): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    this.ws!.send(JSON.stringify({ type }));
  }

  onEvent(listener: (event: AdsEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client closed"));
    }
    this.pendingPrompts.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.isConnected = false;
  }
}
