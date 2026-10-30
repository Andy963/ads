import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions, type ChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createWebSocketActions } from "../app/projectsWs/webSocketActions";
import type { ProjectTab } from "../app/controllerTypes";

const closeCalls: string[] = [];
const connectCalls: string[] = [];

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
      connectCalls.push(`${this.sessionId}:${this.chatSessionId}`);
      this.onOpen?.();
    }

    close(): void {
      closeCalls.push(`${this.sessionId}:${this.chatSessionId}`);
    }

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

describe("Project switch WebSocket retention and dynamic connection pool (Issue #561)", () => {
  beforeEach(() => {
    closeCalls.length = 0;
    connectCalls.length = 0;
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setupHarness(serverMaxClients: number | null = null) {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    ctx.loggedIn.value = true;
    if (serverMaxClients !== null) {
      ctx.maxWsClients.value = serverMaxClients;
    }

    const projectDeps = {
      activateProject: async () => {},
    };

    const projectActions = createProjectActions({ ...ctx, ...chat } as AppContext & ChatActions, projectDeps);
    const wsActions = createWebSocketActions({ ...ctx, ...chat } as AppContext & ChatActions, {
      updateProject: projectActions.updateProject,
      persistProjects: projectActions.persistProjects,
    });

    const clearRuntimeTimers = (rt: { noticeTimer: number | null; liveActivityTtlTimer: number | null }) => {
      if (rt.noticeTimer !== null) clearTimeout(rt.noticeTimer);
      if (rt.liveActivityTtlTimer !== null) clearTimeout(rt.liveActivityTtlTimer);
    };

    const activateProject = async (projectId: string): Promise<void> => {
      const pid = ctx.normalizeProjectId(projectId);
      const nextOrder = ctx.projectAccessOrder.value.filter((id) => id !== pid);
      nextOrder.push(pid);
      ctx.projectAccessOrder.value = nextOrder;

      const serverLimit = ctx.maxWsClients.value ?? 32;
      const poolCapacity = Math.max(1, Math.floor(serverLimit));

      const openProjectIds = nextOrder.filter((id) => {
        const art = ctx.runtimeByProjectId.get(id);
        const crt = ctx.acopilotRuntimeByProjectId.get(id);
        return Boolean((art?.ws && art.connected.value) || (crt?.ws && crt.connected.value));
      });

      while (openProjectIds.length > poolCapacity) {
        const oldestId = openProjectIds.shift();
        if (oldestId && oldestId !== pid) {
          const art = ctx.runtimeByProjectId.get(oldestId);
          if (art) {
            wsActions.closeRuntimeConnection(art);
            clearRuntimeTimers(art);
          }
          const crt = ctx.acopilotRuntimeByProjectId.get(oldestId);
          if (crt) {
            wsActions.closeRuntimeConnection(crt);
            clearRuntimeTimers(crt);
          }
        }
      }

      const rt = ctx.getRuntime(pid);
      const acopilotRt = ctx.getAcopilotRuntime(pid);
      await Promise.all([
        (!rt.ws || !rt.connected.value) ? wsActions.connectWs(pid) : Promise.resolve(),
        (!acopilotRt.ws || !acopilotRt.connected.value) ? wsActions.connectAcopilotWs(pid) : Promise.resolve(),
      ]);
    };

    projectDeps.activateProject = activateProject;

    const createTab = (id: string, name: string): ProjectTab => ({
      id,
      sessionId: id,
      path: `/tmp/${id}`,
      name,
      initialized: true,
      createdAt: 1,
      updatedAt: 1,
    });

    return { ctx, projectActions, wsActions, activateProject, createTab };
  }

  it("retains project A's WebSockets when switching to project B", async () => {
    const { ctx, projectActions, activateProject, createTab } = setupHarness();
    const projA = createTab("proj-a", "Project A");
    const projB = createTab("proj-b", "Project B");
    ctx.projects.value = [projA, projB];
    ctx.activeProjectId.value = "proj-a";

    // Initial activation of Project A
    await activateProject("proj-a");
    const rtA = ctx.getRuntime("proj-a");
    const acopilotRtA = ctx.getAcopilotRuntime("proj-a");
    rtA.connected.value = true;
    acopilotRtA.connected.value = true;

    expect(closeCalls).toHaveLength(0);

    // Switch to Project B
    projectActions.performProjectSwitch("proj-b");
    await activateProject("proj-b");
    const rtB = ctx.getRuntime("proj-b");
    rtB.connected.value = true;

    // Project A's WebSockets must NOT be closed on switch
    expect(closeCalls).toHaveLength(0);
    expect(rtA.ws).not.toBeNull();
    expect(rtA.connected.value).toBe(true);
  });

  it("immediately reuses existing live WebSocket when switching back without reconnecting", async () => {
    const { ctx, projectActions, activateProject, createTab } = setupHarness();
    const projA = createTab("proj-a", "Project A");
    const projB = createTab("proj-b", "Project B");
    ctx.projects.value = [projA, projB];
    ctx.activeProjectId.value = "proj-a";

    await activateProject("proj-a");
    const rtA = ctx.getRuntime("proj-a");
    rtA.connected.value = true;
    const initialSocketA = rtA.ws;

    // Switch to B
    projectActions.performProjectSwitch("proj-b");
    await activateProject("proj-b");

    // Record connect calls up to B
    const connectsBeforeSwitchBack = connectCalls.length;

    // Switch back to A
    projectActions.performProjectSwitch("proj-a");
    await activateProject("proj-a");

    // Reuses initial socket without creating a new connection
    expect(rtA.ws).toBe(initialSocketA);
    expect(connectCalls.length).toBe(connectsBeforeSwitchBack);
    expect(closeCalls).toHaveLength(0);
  });

  it("harvests oldest background project when open projects exceed server-derived capacity", async () => {
    // One multiplexed socket per project fits the server's two-client budget.
    const { ctx, projectActions, activateProject, createTab } = setupHarness(2);
    const projA = createTab("proj-a", "Project A");
    const projB = createTab("proj-b", "Project B");
    const projC = createTab("proj-c", "Project C");
    ctx.projects.value = [projA, projB, projC];

    // 1. Activate Project A
    ctx.activeProjectId.value = "proj-a";
    await activateProject("proj-a");
    ctx.getRuntime("proj-a").connected.value = true;
    ctx.getAcopilotRuntime("proj-a").connected.value = true;

    // 2. Activate Project B (now open = 2, pool capacity = 2)
    projectActions.performProjectSwitch("proj-b");
    await activateProject("proj-b");
    ctx.getRuntime("proj-b").connected.value = true;
    ctx.getAcopilotRuntime("proj-b").connected.value = true;
    expect(closeCalls).toHaveLength(0);

    // 3. Activate Project C (now open = 3 > capacity 2): oldest (Project A) should be harvested
    projectActions.performProjectSwitch("proj-c");
    await activateProject("proj-c");
    ctx.getRuntime("proj-c").connected.value = true;
    ctx.getAcopilotRuntime("proj-c").connected.value = true;

    // Project A's connections must be cleanly harvested
    expect(closeCalls).toContain("proj-a:main");
    expect(closeCalls).toContain("proj-a:acopilot");
    // Project B and C remain active
    expect(ctx.getRuntime("proj-b").connected.value).toBe(true);
    expect(ctx.getRuntime("proj-c").connected.value).toBe(true);
  });

  it("dynamically expands pool capacity when server reports larger maxClients via welcome", async () => {
    const { ctx, activateProject, createTab } = setupHarness(null);
    // Default server capacity = 32 multiplexed project sockets
    const projA = createTab("proj-a", "Project A");
    ctx.projects.value = [projA];
    ctx.activeProjectId.value = "proj-a";
    await activateProject("proj-a");
    const rtA = ctx.getRuntime("proj-a");
    rtA.connected.value = true;

    // Welcome arrives with server maxClients = 60
    const socket = rtA.ws as any;
    socket.onMessage?.({ type: "welcome", maxClients: 60 });

    expect(ctx.maxWsClients.value).toBe(60);
  });
});
