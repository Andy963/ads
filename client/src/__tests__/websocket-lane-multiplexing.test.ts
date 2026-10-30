import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectWebSocketLane } from "../api/ws";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  readonly protocols: string[];
  readonly url: string;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("project WebSocket lane multiplexing", () => {
  it("uses one physical socket and routes lane messages and cursors independently", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("window", { setInterval, clearInterval });
    const configs = {
      actions: { chatSessionId: "main", resume: { afterSeq: 12, laneGeneration: 4 } },
      acopilot: { chatSessionId: "acopilot", resume: { afterSeq: 8, laneGeneration: 2 } },
    };
    const actions = getProjectWebSocketLane({ projectId: "project-multiplex-test", sessionId: "session", lane: "actions", configs });
    const acopilot = getProjectWebSocketLane({ projectId: "project-multiplex-test", sessionId: "session", lane: "acopilot", configs });
    const actionsMessages: unknown[] = [];
    const acopilotMessages: unknown[] = [];
    actions.onMessage = (message) => actionsMessages.push(message);
    acopilot.onMessage = (message) => acopilotMessages.push(message);

    actions.connect();
    acopilot.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const physicalSocket = FakeWebSocket.instances[0]!;
    expect(physicalSocket.protocols).toContain("ads-chat.main");
    expect(physicalSocket.protocols).toContain("ads-chat.acopilot");
    const params = new URL(physicalSocket.url).searchParams;
    expect(params.get("afterSeq.main")).toBe("12");
    expect(params.get("laneGeneration.main")).toBe("4");
    expect(params.get("afterSeq.acopilot")).toBe("8");
    expect(params.get("laneGeneration.acopilot")).toBe("2");

    physicalSocket.readyState = FakeWebSocket.OPEN;
    physicalSocket.onopen?.();
    physicalSocket.onmessage?.({ data: JSON.stringify({ type: "delta", chatSessionId: "main", delta: "actions" }) } as MessageEvent);
    physicalSocket.onmessage?.({ data: JSON.stringify({ type: "delta", chatSessionId: "acopilot", delta: "acopilot" }) } as MessageEvent);
    expect(actionsMessages).toEqual([{ type: "delta", chatSessionId: "main", delta: "actions" }]);
    expect(acopilotMessages).toEqual([{ type: "delta", chatSessionId: "acopilot", delta: "acopilot" }]);

    actions.send("prompt", { command: "actions" });
    acopilot.send("prompt", { command: "acopilot" });
    expect(physicalSocket.sent.map((frame) => JSON.parse(frame).chat_session_id)).toEqual(["main", "acopilot"]);

    expect(actions.switchChatSession("work")).toBe(true);
    const switchFrame = JSON.parse(physicalSocket.sent[2]!);
    expect(switchFrame).toMatchObject({ type: "switch_chat_session", chat_session_id: "main", payload: { chatSessionId: "work" } });
    physicalSocket.onmessage?.({ data: JSON.stringify({ type: "welcome", chatSessionId: "work" }) } as MessageEvent);
    physicalSocket.onmessage?.({ data: JSON.stringify({ type: "delta", chatSessionId: "work", delta: "switched" }) } as MessageEvent);
    physicalSocket.onmessage?.({ data: JSON.stringify({ type: "delta", chatSessionId: "acopilot", delta: "still isolated" }) } as MessageEvent);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(actionsMessages.slice(-2)).toEqual([
      { type: "welcome", chatSessionId: "work" },
      { type: "delta", chatSessionId: "work", delta: "switched" },
    ]);
    expect(acopilotMessages.at(-1)).toEqual({ type: "delta", chatSessionId: "acopilot", delta: "still isolated" });

    expect(actions.send("prompt", { command: "after switch" })).toBe(true);
    expect(JSON.parse(physicalSocket.sent[3]!).chat_session_id).toBe("work");
    actions.close();
    acopilot.close();
  });

  it("accepts a server-initiated rebind that arrives on a lane", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("window", { setInterval, clearInterval });
    const configs = {
      actions: { chatSessionId: "main" },
      acopilot: { chatSessionId: "acopilot" },
    };
    const actions = getProjectWebSocketLane({ projectId: "project-rebind-test", sessionId: "session", lane: "actions", configs });
    const acopilot = getProjectWebSocketLane({ projectId: "project-rebind-test", sessionId: "session", lane: "acopilot", configs });
    const actionsMessages: unknown[] = [];
    const acopilotMessages: unknown[] = [];
    actions.onMessage = (message) => actionsMessages.push(message);
    acopilot.onMessage = (message) => acopilotMessages.push(message);
    actions.connect();
    acopilot.connect();
    const physicalSocket = FakeWebSocket.instances[0]!;
    physicalSocket.readyState = FakeWebSocket.OPEN;
    physicalSocket.onopen?.();

    physicalSocket.onmessage?.({
      data: JSON.stringify({ type: "welcome", lane: "actions", chatSessionId: "work" }),
    } as MessageEvent);
    physicalSocket.onmessage?.({
      data: JSON.stringify({ type: "delta", lane: "actions", chatSessionId: "work", delta: "after rebind" }),
    } as MessageEvent);

    expect(actionsMessages).toHaveLength(2);
    expect(acopilotMessages).toEqual([]);
    expect(actions.send("prompt", { text: "next" })).toBe(true);
    expect(JSON.parse(physicalSocket.sent.at(-1)!).chat_session_id).toBe("work");
  });

  it("opened a new socket when one lane re-attaches to a live transport", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("window", { setInterval, clearInterval });
    const configs = {
      actions: { chatSessionId: "main" },
      acopilot: { chatSessionId: "acopilot" },
    };
    const actions = getProjectWebSocketLane({ projectId: "project-reattach-test", sessionId: "session", lane: "actions", configs });
    const acopilot = getProjectWebSocketLane({ projectId: "project-reattach-test", sessionId: "session", lane: "acopilot", configs });
    actions.connect();
    acopilot.connect();
    const physicalSocket = FakeWebSocket.instances[0]!;
    physicalSocket.readyState = FakeWebSocket.OPEN;
    physicalSocket.onopen?.();

    actions.close();
    const reopened = getProjectWebSocketLane({
      projectId: "project-reattach-test",
      sessionId: "session",
      lane: "actions",
      configs,
    });
    reopened.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.protocols).toEqual(expect.arrayContaining(["ads-chat.main", "ads-chat.acopilot"]));
  });

  it("drops buffered frames when the physical socket disconnects", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("window", { setInterval, clearInterval });
    const configs = {
      actions: { chatSessionId: "main" },
      acopilot: { chatSessionId: "acopilot" },
    };
    const actions = getProjectWebSocketLane({ projectId: "project-disconnect-test", sessionId: "session", lane: "actions", configs });
    const staleMessages: unknown[] = [];
    actions.connect();
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.readyState = FakeWebSocket.OPEN;
    firstSocket.onopen?.();
    firstSocket.onmessage?.({
      data: JSON.stringify({ type: "delta", chatSessionId: "acopilot", delta: "stale" }),
    } as MessageEvent);
    firstSocket.onclose?.({ code: 1006 } as CloseEvent);

    const reconnectedActions = getProjectWebSocketLane({
      projectId: "project-disconnect-test",
      sessionId: "session",
      lane: "actions",
      configs,
    });
    reconnectedActions.connect();
    const reconnectSocket = FakeWebSocket.instances[1]!;
    reconnectSocket.readyState = FakeWebSocket.OPEN;
    reconnectSocket.onopen?.();

    const acopilot = getProjectWebSocketLane({
      projectId: "project-disconnect-test",
      sessionId: "session",
      lane: "acopilot",
      configs,
    });
    acopilot.onMessage = (message) => staleMessages.push(message);
    acopilot.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(staleMessages).toEqual([]);
    reconnectedActions.close();
    acopilot.close();
  });
});
