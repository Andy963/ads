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

export interface ModelOption {
  id: string;
  modelId: string;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson: Record<string, unknown> | null;
}

export interface ModelState {
  model?: string;
  reasoningEffort?: string;
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
  private connectPromise: Promise<void> | null = null;
  private welcomeReceived = false;
  private readonly welcomeWaiters = new Set<() => void>();
  private readonly eventListeners = new Set<(event: AdsEvent) => void>();
  private pendingPrompts = new Map<string, {
    resolve: (reply: string) => void;
    reject: (err: Error) => void;
    accumulatedText: string;
    timer: NodeJS.Timeout;
  }>();
  private pendingControls = new Map<string, {
    resolve: (state: ModelState) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private modelState: ModelState = {};

  constructor(private readonly options: AdsClientOptions) {}

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.closed = false;
    this.welcomeReceived = false;
    const connectionPromise = new Promise<void>((resolve, reject) => {
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
    this.connectPromise = connectionPromise;
    try {
      await connectionPromise;
    } finally {
      if (this.connectPromise === connectionPromise) this.connectPromise = null;
    }
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

      if (parsed.type === "welcome") {
        this.modelState = {
          model: typeof parsed.effectiveModel === "string" ? parsed.effectiveModel : undefined,
          reasoningEffort: typeof parsed.effectiveModelReasoningEffort === "string" ? parsed.effectiveModelReasoningEffort : undefined,
        };
        this.welcomeReceived = true;
        for (const resolve of this.welcomeWaiters) resolve();
        this.welcomeWaiters.clear();
      }
      if (parsed.type === "result" && parsed.kind === "model_override") {
        const controlId = typeof parsed.client_message_id === "string" ? parsed.client_message_id : "";
        const control = this.pendingControls.get(controlId);
        if (control) {
          clearTimeout(control.timer);
          this.pendingControls.delete(controlId);
          if (parsed.ok === false) {
            control.reject(new Error(String(parsed.output ?? "Model override failed")));
          } else {
            this.modelState = {
              model: typeof parsed.model === "string" ? parsed.model : undefined,
              reasoningEffort: typeof parsed.model_reasoning_effort === "string" ? parsed.model_reasoning_effort : undefined,
            };
            control.resolve({ ...this.modelState });
          }
        }
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

  async getModels(): Promise<ModelOption[]> {
    const headers: Record<string, string> = {};
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await fetch(`${this.options.coreUrl.replace(/\/$/, "")}/api/models`, { headers });
    if (!response.ok) throw new Error(`Failed to load models (${response.status})`);
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error("Invalid model list from ADS Core");
    return payload
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
      .map((value) => ({
        id: String(value.id ?? ""),
        modelId: String(value.modelId ?? "").trim(),
        displayName: String(value.displayName ?? value.modelId ?? "").trim(),
        provider: String(value.provider ?? "").trim(),
        isEnabled: value.isEnabled !== false,
        isDefault: value.isDefault === true,
        configJson: value.configJson && typeof value.configJson === "object" && !Array.isArray(value.configJson)
          ? value.configJson as Record<string, unknown>
          : null,
      }))
      .filter((model) => model.modelId && model.isEnabled);
  }

  getModelState(): ModelState {
    return { ...this.modelState };
  }

  async waitForWelcome(timeoutMs = 1_000): Promise<void> {
    if (this.welcomeReceived) return;
    await new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        this.welcomeWaiters.delete(waiter);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.welcomeWaiters.delete(waiter);
        resolve();
      }, Math.max(0, timeoutMs));
      this.welcomeWaiters.add(waiter);
    });
  }

  async setModel(model: string, reasoningEffort?: string): Promise<ModelState> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect();
    const clientMessageId = `tg-model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finalState = new Promise<ModelState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(clientMessageId);
        reject(new Error("Model switch timed out"));
      }, 15_000);
      this.pendingControls.set(clientMessageId, { resolve, reject, timer });
    });
    this.ws!.send(JSON.stringify({
      type: "model_override",
      client_message_id: clientMessageId,
      payload: { model, ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}) },
    }));
    return finalState;
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
    for (const [, pending] of this.pendingControls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client closed"));
    }
    this.pendingControls.clear();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.isConnected = false;
  }
}
