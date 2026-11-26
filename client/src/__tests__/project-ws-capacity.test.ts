import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions, type ChatActions } from "../app/chat";
import { createWebSocketActions } from "../app/projectsWs/webSocketActions";
import type { ProjectTab } from "../app/controllerTypes";

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onMessage?: (msg: unknown) => void;
    sessionId: string;
    chatSessionId?: string;

    constructor(opts: { sessionId: string; chatSessionId?: string }) {
      this.sessionId = opts.sessionId;
      this.chatSessionId = opts.chatSessionId;
    }

    connect(): void {
      this.onOpen?.();
    }

    close(): void {}

    send = vi.fn();
    sendPrompt = vi.fn();
    interrupt = vi.fn();
    switchChatSession = vi.fn();
    clearHistory = vi.fn();
  }

  return {
    AdsWebSocket,
    getProjectWebSocketLane: (options: {
      sessionId: string;
      lane: "actions" | "acopilot";
      configs: Record<string, { chatSessionId: string }>;
    }) => new AdsWebSocket({
      sessionId: options.sessionId,
      chatSessionId: options.configs[options.lane]?.chatSessionId,
    }),
  };
});

describe("Project WebSocket capacity", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adopts the max client budget reported by the welcome frame", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    ctx.loggedIn.value = true;
    const wsActions = createWebSocketActions({ ...ctx, ...chat } as AppContext & ChatActions, {
      updateProject: vi.fn(),
      persistProjects: vi.fn(),
    });

    const project: ProjectTab = {
      id: "proj-a",
      sessionId: "proj-a",
      path: "/tmp/proj-a",
      name: "Project A",
      initialized: true,
      createdAt: 1,
      updatedAt: 1,
    };
    ctx.projects.value = [project];
    ctx.activeProjectId.value = "proj-a";

    const activateProject = async (projectId: string): Promise<void> => {
      const rt = ctx.getRuntime(projectId);
      const acopilotRt = ctx.getAcopilotRuntime(projectId);
      await Promise.all([
        (!rt.ws || !rt.connected.value) ? wsActions.connectWs(projectId) : Promise.resolve(),
        (!acopilotRt.ws || !acopilotRt.connected.value) ? wsActions.connectAcopilotWs(projectId) : Promise.resolve(),
      ]);
    };

    await activateProject("proj-a");
    const rt = ctx.getRuntime("proj-a");
    rt.connected.value = true;

    const socket = rt.ws as { onMessage?: (msg: unknown) => void } | null;
    socket?.onMessage?.({ type: "welcome", maxClients: 60 });

    expect(ctx.maxWsClients.value).toBe(60);
  });
});
