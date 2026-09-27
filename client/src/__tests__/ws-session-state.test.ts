import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

describe("ws session state", () => {
  describe("ws agents snapshot", () => {
    type Ref<T> = { value: T };

    function createRuntime(): any {
      return {
        busy: { value: false } satisfies Ref<boolean>,
        turnInFlight: false,
        turnHasPatch: false,
        pendingAckClientMessageId: null,
        suppressNextClearHistoryResult: false,
        pendingCdRequestedPath: null,
        messages: { value: [] } satisfies Ref<any[]>,
        turnCommands: [],
        recentCommands: { value: [] } satisfies Ref<string[]>,
        executePreviewByKey: new Map(),
        executeOrder: [],
        seenCommandIds: new Set<string>(),
        liveActivity: {},
        activeThreadId: { value: null } satisfies Ref<string | null>,
        threadWarning: { value: null } satisfies Ref<string | null>,
        workspacePath: { value: "" } satisfies Ref<string>,
        availableAgents: { value: [] } satisfies Ref<any[]>,
        activeAgentId: { value: "" } satisfies Ref<string>,
        resumeReplacePending: false,
      };
    }

    function createHandler(rt: any) {
      const randomId = (() => {
        let n = 0;
        return (prefix: string) => `${prefix}-${++n}`;
      })();

      return createWsMessageHandler({
        projects: { value: [] },
        pid: "default",
        rt,
        wsInstance: { send: vi.fn() },
        maxTurnCommands: 64,
        randomId,

        updateProject: vi.fn(),
        applyResumeHistory: vi.fn(),
        cancelPendingResume: vi.fn(),
        clearPendingPrompt: vi.fn(),
        clearStepLive: vi.fn(),
        commandKeyForWsEvent: () => null,
        finalizeAssistant: vi.fn(),
        finalizeCommandBlock: vi.fn(),
        flushQueuedPrompts: vi.fn(),
        ingestCommand: vi.fn(),
        ingestCommandActivity: vi.fn(),
        ingestExploredActivity: vi.fn(),
        pushMessageBeforeLive: vi.fn(),
        threadReset: vi.fn(),
        upsertExecuteBlock: vi.fn(),
        upsertLiveActivity: vi.fn(),
        upsertStreamingDelta: vi.fn(),
      });
    }

    it("updates active agent + available agents list", () => {
      const rt = createRuntime();
      const handler = createHandler(rt);

      handler({
        type: "agents",
        activeAgentId: "claude",
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude", ready: false, error: "missing api key" },
        ],
        threadId: "thread-123",
      });

      expect(rt.activeAgentId.value).toBe("claude");
      expect(rt.availableAgents.value.length).toBe(2);
      expect(rt.availableAgents.value[0].id).toBe("codex");
      expect(rt.availableAgents.value[1].ready).toBe(false);
      expect(rt.activeThreadId.value).toBe("thread-123");
    });

    it("falls back to the first ready agent when the active agent is omitted or unavailable", () => {
      const rt = createRuntime();
      const handler = createHandler(rt);

      handler({
        type: "agents",
        agents: [
          { id: "codex", name: "Codex", ready: false, error: "missing api key" },
          { id: "claude", name: "Claude", ready: true },
        ],
      });

      expect(rt.activeAgentId.value).toBe("claude");

      rt.activeAgentId.value = "codex";
      handler({
        type: "agents",
        agents: [
          { id: "codex", name: "Codex", ready: false, error: "missing api key" },
          { id: "claude", name: "Claude", ready: true },
        ],
      });

      expect(rt.activeAgentId.value).toBe("claude");
    });

    it("ignores persisted agent snapshots replayed from the sync log", () => {
      const rt = createRuntime();
      const handler = createHandler(rt);

      handler({
        type: "agents",
        activeAgentId: "claude",
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude", ready: true },
        ],
      });
      handler({
        type: "agents",
        seq: 42,
        activeAgentId: "codex",
        agents: [{ id: "codex", name: "Codex", ready: true }],
      });

      expect(rt.activeAgentId.value).toBe("claude");
      expect(rt.availableAgents.value.map((agent: { id: string }) => agent.id)).toEqual(["codex", "claude"]);
    });
  });

  describe("in-band chat session switching", () => {
    it("switches session via switchChatSession without closing WebSocket when connected", async () => {
      const ctx = createAppContext();
      const chat = createChatActions(ctx as AppContext);
      const deps = {
        activateProject: vi.fn(async () => {}),
      };
      const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

      ctx.loggedIn.value = true;
      projects.initializeProjects();

      const rt = ctx.activeRuntime.value;
      rt.connected.value = true;

      const mockWs = {
        switchChatSession: vi.fn().mockReturnValue(true),
        close: vi.fn(),
        clearHistory: vi.fn(),
      };
      rt.ws = mockWs as unknown as typeof rt.ws;

      const initialChatSessionId = rt.chatSessionId;
      await projects.startNewChatSession();

      // Must call in-band switch
      expect(mockWs.switchChatSession).toHaveBeenCalledTimes(1);
      const newChatSessionId = mockWs.switchChatSession.mock.calls[0]![0];
      expect(newChatSessionId).toBeTruthy();
      expect(newChatSessionId).not.toBe(initialChatSessionId);

      // Must NOT close the connection
      expect(mockWs.close).not.toHaveBeenCalled();

      // Must keep connected status alive
      expect(rt.connected.value).toBe(true);

      // Must NOT trigger full project reactivation
      expect(deps.activateProject).not.toHaveBeenCalled();

      // Runtime state must reflect new chatSessionId
      expect(rt.chatSessionId).toBe(newChatSessionId);
    });

    it("falls back to full project reactivation when disconnected", async () => {
      const ctx = createAppContext();
      const chat = createChatActions(ctx as AppContext);
      const deps = {
        activateProject: vi.fn(async () => {}),
      };
      const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

      ctx.loggedIn.value = true;
      projects.initializeProjects();

      const rt = ctx.activeRuntime.value;
      rt.connected.value = false;

      const mockWs = {
        switchChatSession: vi.fn().mockReturnValue(false),
        close: vi.fn(),
        clearHistory: vi.fn(),
      };
      rt.ws = mockWs as unknown as typeof rt.ws;

      await projects.startNewChatSession();

      // When disconnected, it should fall back to activateProject
      expect(deps.activateProject).toHaveBeenCalledTimes(1);
    });
  });
});
