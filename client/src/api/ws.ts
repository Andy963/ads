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
  | {
      type: "welcome";
      sessionId?: string;
      chatSessionId?: string;
      workspace?: unknown;
      threadId?: string;
      laneGeneration?: number;
      reset?: boolean;
      inFlight?: boolean;
      bootstrapHistory?: boolean;
      historyMode?: "resume" | "snapshot";
      completedClientMessageIds?: string[];
    }
  | { type: "ack"; client_message_id?: string; duplicate?: boolean }
  | {
      type: "history";
      items: Array<{ role: string; text: string; ts: number; kind?: string }>;
      laneGeneration?: number;
    }
  | { type: "in_flight"; inFlight?: boolean }
  | { type: "delta"; delta?: string; source?: "chat" | "step" }
  | { type: "result"; ok: boolean; output: string; kind?: string }
  | { type: "error"; message?: string }
  | {
      type: "session_reset";
      source?: string;
      sourceChatSessionId?: string;
      scope?: "lane" | "shared";
      laneGeneration?: number;
      laneGenerations?: Record<string, number>;
    }
  | { type: "thread_reset" }
  | { type: "command"; detail?: string; command?: WsCommandPayload | null }
  | { type: "patch"; patch?: WsPatchPayload | null }
  | {
      type: "agents";
      activeAgentId?: string;
      agents?: Array<{ id?: string; name?: string; ready?: boolean; error?: string }>;
      threadId?: string | null;
    }
  | { type: string; seq?: number; [k: string]: unknown };

const SESSION_UNSCOPED_MESSAGES = new Set(["ping", "pong"]);

const PROBE_TIMEOUT_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export type WebSocketLane = "actions" | "acopilot";

export type WebSocketLaneConfig = {
  chatSessionId: string;
  resume?: { afterSeq: number; laneGeneration: number };
};

type SharedLane = { socket: AdsWebSocket; chatSessionId: string };

class ProjectWebSocketTransport {
  private socket: WebSocket | null = null;
  private probeTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private socketStartedAt = 0;
  private readonly lanes = new Map<WebSocketLane, SharedLane>();
  private readonly pendingMessages = new Map<WebSocketLane, WsMessage[]>();
  private readonly reattaching = new Set<WebSocketLane>();
  /** Sockets whose handshake was still in flight when they were retired. */
  private readonly deferredClose = new Set<WebSocket>();
  private readonly configs: Record<WebSocketLane, WebSocketLaneConfig>;

  constructor(
    private readonly sessionId: string,
    configs: Record<WebSocketLane, WebSocketLaneConfig>,
    private readonly onIdle: () => void,
  ) {
    this.configs = configs;
  }

  updateConfigs(configs: Record<WebSocketLane, WebSocketLaneConfig>): void {
    this.configs.actions = configs.actions;
    this.configs.acopilot = configs.acopilot;
  }

  attach(lane: WebSocketLane, socket: AdsWebSocket, chatSessionId: string): void {
    this.lanes.set(lane, { socket, chatSessionId });
    this.configs[lane] = { ...this.configs[lane], chatSessionId };
    const reattaching = this.reattaching.delete(lane);
    if (reattaching && this.socket?.readyState === WebSocket.OPEN) {
      // The server keeps the lane bound to the live socket, so re-attaching
      // alone would skip the handshake (no welcome, no bootstrap cursor).
      this.restart();
      return;
    }
    this.connectIfNeeded();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.startHeartbeat();
      socket.notifyOpen();
      const pending = this.pendingMessages.get(lane) ?? [];
      this.pendingMessages.delete(lane);
      for (const message of pending) socket.notifyMessage(message);
    }
  }

  detach(lane: WebSocketLane, socket: AdsWebSocket): void {
    if (this.lanes.get(lane)?.socket !== socket) return;
    this.lanes.delete(lane);
    this.reattaching.add(lane);
    if (this.lanes.size > 0) return;

    this.clearProbe();
    this.stopHeartbeat();
    const current = this.socket;
    this.socket = null;
    this.onIdle();
    this.closeSocket(current);
  }

  send(frame: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verifies the physical socket after the page returns to the foreground.
   * Backgrounded pages routinely resume with a half-open socket that still
   * reports `OPEN` and never fires `close`, so reconnect bookkeeping alone
   * cannot tell a live connection from a dead one.
   */
  probe(): void {
    const socket = this.socket;
    if (!socket) {
      this.stopHeartbeat();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState === WebSocket.CONNECTING && Date.now() - this.socketStartedAt < PROBE_TIMEOUT_MS) return;
      this.restartForUnhealthyTransport();
      return;
    }
    if (this.probeTimer !== null) return;
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      this.restartForUnhealthyTransport();
    }, PROBE_TIMEOUT_MS);
    this.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() } }));
  }

  setForeground(visible: boolean): void {
    if (!visible) {
      this.clearProbe();
      this.stopHeartbeat();
      return;
    }
    this.startHeartbeat();
    this.probe();
  }

  updateLaneChatSession(lane: WebSocketLane, socket: AdsWebSocket, chatSessionId: string): void {
    const current = this.lanes.get(lane);
    if (current?.socket === socket) current.chatSessionId = chatSessionId;
    this.configs[lane] = { ...this.configs[lane], chatSessionId };
  }

  /** True while the physical socket carrying this lane has not opened yet. */
  isLaneConnecting(lane: WebSocketLane, socket: AdsWebSocket): boolean {
    return this.lanes.get(lane)?.socket === socket && this.socket?.readyState === 0;
  }

  /**
   * Closing a handshake still in flight makes the browser drop the connection
   * without a close frame, which the server can only record as 1006. Retire
   * such a socket on open instead, so the server sees a normal close code.
   */
  private closeSocket(socket: WebSocket | null): void {
    if (!socket) return;
    if (socket.readyState === 0) {
      this.deferredClose.add(socket);
      return;
    }
    try {
      socket.close(1000, "client reconnect");
    } catch {
      // ignore
    }
  }

  private restart(): void {
    const current = this.socket;
    this.socket = null;
    this.pendingMessages.clear();
    this.clearProbe();
    this.closeSocket(current);
    this.connectIfNeeded();
  }

  private restartForUnhealthyTransport(): void {
    const lanes = [...this.lanes.values()];
    const current = this.socket;
    this.socket = null;
    this.pendingMessages.clear();
    this.clearProbe();
    this.closeSocket(current);
    const event = { code: 4000, reason: "transport unresponsive" } as CloseEvent;
    for (const { socket: laneSocket } of lanes) laneSocket.notifyClose(event);
    this.connectIfNeeded();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null || this.socket?.readyState !== WebSocket.OPEN) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    this.heartbeatTimer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      this.probe();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private connectIfNeeded(): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;

    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const params = new URLSearchParams();
    const protocols = ["ads-v1", `ads-session.${this.sessionId}`];
    for (const lane of ["actions", "acopilot"] as const) {
      const config = this.configs[lane];
      protocols.push(`ads-chat.${config.chatSessionId}`);
      if (config.resume) {
        params.set(`afterSeq.${config.chatSessionId}`, String(config.resume.afterSeq));
        params.set(`laneGeneration.${config.chatSessionId}`, String(config.resume.laneGeneration));
      }
    }
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : "";
    const socket = new WebSocket(proto + location.host + "/ws" + query, protocols);
    this.socket = socket;
    this.socketStartedAt = Date.now();
    socket.onopen = () => {
      if (this.deferredClose.delete(socket)) {
        try {
          socket.close(1000, "client reconnect");
        } catch {
          // ignore
        }
        return;
      }
      if (this.socket !== socket) return;
      for (const { socket: laneSocket } of this.lanes.values()) laneSocket.notifyOpen();
      this.startHeartbeat();
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      for (const { socket: laneSocket } of this.lanes.values()) laneSocket.notifyError();
    };
    socket.onclose = (event) => {
      this.deferredClose.delete(socket);
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearProbe();
      this.stopHeartbeat();
      const lanes = [...this.lanes.values()];
      this.lanes.clear();
      this.pendingMessages.clear();
      this.onIdle();
      for (const { socket: laneSocket } of lanes) laneSocket.notifyClose(event);
    };
    socket.onmessage = (event) => {
      this.clearProbe();
      let message: WsMessage;
      try {
        message = JSON.parse(String(event.data ?? "")) as WsMessage;
      } catch {
        return;
      }
      const targetLane = messageLane(message) ?? laneForChatSession(this.lanes, this.configs, message);
      if (!targetLane) return;
      const target = this.lanes.get(targetLane)?.socket;
      if (target) {
        target.notifyMessage(message);
      } else {
        const pending = this.pendingMessages.get(targetLane) ?? [];
        pending.push(message);
        if (pending.length > 200) pending.shift();
        this.pendingMessages.set(targetLane, pending);
      }
    };
  }

  private clearProbe(): void {
    if (this.probeTimer === null) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }
}

function messageLane(message: WsMessage): WebSocketLane | null {
  const lane = String((message as Record<string, unknown>).lane ?? "").trim();
  return lane === "actions" || lane === "acopilot" ? lane : null;
}

function laneForChatSession(
  lanes: Map<WebSocketLane, SharedLane>,
  configs: Record<WebSocketLane, WebSocketLaneConfig>,
  message: WsMessage,
): WebSocketLane | null {
  const chatSessionId = String(message.chatSessionId ?? "").trim();
  if (!chatSessionId) return "actions";
  for (const [lane, entry] of lanes) {
    if (entry.chatSessionId === chatSessionId) return lane;
  }
  for (const lane of ["actions", "acopilot"] as const) {
    if (configs[lane].chatSessionId === chatSessionId) return lane;
  }
  return null;
}

const projectTransports = new Map<string, ProjectWebSocketTransport>();

let probeListenerDocument: EventTarget | null = null;

function setProjectWebSocketForeground(visible: boolean): void {
  for (const transport of projectTransports.values()) transport.setForeground(visible);
}

function ensureProbeListener(): void {
  if (typeof document === "undefined" || probeListenerDocument === document) return;
  const target = document;
  probeListenerDocument = target;
  target.addEventListener("visibilitychange", () => {
    // Reconnect bookkeeping cannot see a socket the browser froze in the
    // background, so foreground resumes both restart the heartbeat and prove
    // liveness immediately.
    setProjectWebSocketForeground(target.visibilityState === "visible");
  });
}

export function getProjectWebSocketLane(args: {
  projectId: string;
  sessionId: string;
  lane: WebSocketLane;
  configs: Record<WebSocketLane, WebSocketLaneConfig>;
}): AdsWebSocket {
  const projectId = String(args.projectId ?? "").trim();
  let transport = projectTransports.get(projectId);
  if (!transport) {
    const created = new ProjectWebSocketTransport(args.sessionId, args.configs, () => {
      if (projectTransports.get(projectId) === created) projectTransports.delete(projectId);
    });
    transport = created;
    projectTransports.set(projectId, created);
    ensureProbeListener();
  } else {
    transport.updateConfigs(args.configs);
  }
  const config = args.configs[args.lane];
  return new AdsWebSocket({
    sessionId: args.sessionId,
    chatSessionId: config.chatSessionId,
    resume: config.resume,
    transport,
    lane: args.lane,
  });
}

export class AdsWebSocket {
  private ws: WebSocket | null = null;
  private readonly sessionId: string;
  private chatSessionId: string;
  private readonly resume?: { afterSeq: number; laneGeneration: number };
  private readonly transport?: ProjectWebSocketTransport;
  private readonly lane?: WebSocketLane;

  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: () => void;
  onMessage?: (msg: WsMessage) => void;

  constructor(options: {
    sessionId?: string;
    chatSessionId?: string;
    resume?: { afterSeq: number; laneGeneration: number };
    transport?: ProjectWebSocketTransport;
    lane?: WebSocketLane;
  }) {
    this.sessionId = options.sessionId ?? cryptoRandomId();
    this.chatSessionId = String(options.chatSessionId ?? "").trim() || "main";
    this.resume = options.resume;
    this.transport = options.transport;
    this.lane = options.lane;
  }

  send(type: string, payload?: unknown, options?: { clientMessageId?: string }): boolean {
    if (this.transport) {
      return this.transport.send(this.createFrame(type, payload, options));
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(this.createFrame(type, payload, options));
      return true;
    } catch {
      return false;
    }
  }

  sendPrompt(payload: unknown, clientMessageId?: string): boolean {
    const id = String(clientMessageId ?? "").trim() || cryptoRandomUuid();
    return this.send("prompt", payload, { clientMessageId: id });
  }

  cancelPrompt(clientMessageId: string): boolean {
    const id = String(clientMessageId ?? "").trim();
    if (!id) return false;
    return this.send("cancel_prompt", undefined, { clientMessageId: id });
  }

  /** Returns false when the socket is not open, so the caller can fall back to HTTP. */
  interrupt(): boolean {
    return this.send("interrupt");
  }

  switchChatSession(chatSessionId: string): boolean {
    const id = String(chatSessionId ?? "").trim();
    if (!id) return false;
    if (!this.send("switch_chat_session", { chatSessionId: id })) return false;
    this.chatSessionId = id;
    if (this.transport && this.lane) this.transport.updateLaneChatSession(this.lane, this, id);
    return true;
  }

  clearHistory(payload?: unknown): void {
    this.send("clear_history", payload);
  }

  connect(): void {
    if (this.transport && this.lane) {
      this.transport.attach(this.lane, this, this.chatSessionId);
      return;
    }
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const query = this.resume ? `?${new URLSearchParams({
      afterSeq: String(this.resume.afterSeq), laneGeneration: String(this.resume.laneGeneration),
    })}` : "";
    const url = proto + location.host + "/ws" + query;
    const protocols = ["ads-v1", `ads-session.${this.sessionId}`, `ads-chat.${this.chatSessionId}`].filter(Boolean);

    this.ws = new WebSocket(url, protocols);
    this.ws.onopen = () => {
      this.onOpen?.();
    };
    this.ws.onerror = () => {
      this.onError?.();
    };
    this.ws.onclose = (ev) => {
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
      if (msg.type === "welcome") {
        const chatSessionId = String(msg.chatSessionId ?? "").trim();
        if (chatSessionId) this.chatSessionId = chatSessionId;
      }
      this.onMessage?.(msg);
    };
  }

  close(): void {
    if (this.transport && this.lane) {
      this.transport.detach(this.lane, this);
      return;
    }
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === 0) {
      // Same reason as ProjectWebSocketTransport.closeSocket: a handshake that
      // is still in flight must open before it can report a normal close code.
      ws.onopen = () => {
        try {
          ws.close(1000, "client close");
        } catch {
          // ignore
        }
      };
      ws.onerror = null;
      ws.onmessage = null;
      ws.onclose = null;
      return;
    }
    try {
      ws.close(1000, "client close");
    } catch {
      // ignore
    }
  }

  /** True while this lane has not completed its handshake yet. */
  isConnecting(): boolean {
    if (this.transport && this.lane) return this.transport.isLaneConnecting(this.lane, this);
    return this.ws?.readyState === 0;
  }

  notifyOpen(): void { this.onOpen?.(); }

  notifyError(): void { this.onError?.(); }

  notifyClose(event: CloseEvent): void { this.onClose?.(event); }

  notifyMessage(message: WsMessage): void {
    if (message.type === "welcome") {
      const chatSessionId = String(message.chatSessionId ?? "").trim();
      if (chatSessionId) {
        this.chatSessionId = chatSessionId;
        if (this.transport && this.lane) this.transport.updateLaneChatSession(this.lane, this, chatSessionId);
      }
    }
    this.onMessage?.(message);
  }

  private createFrame(type: string, payload?: unknown, options?: { clientMessageId?: string }): string {
    const clientMessageId = String(options?.clientMessageId ?? "").trim();
    return JSON.stringify({
      type,
      payload,
      ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      ...(!SESSION_UNSCOPED_MESSAGES.has(type) ? { chat_session_id: this.chatSessionId } : {}),
    });
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
