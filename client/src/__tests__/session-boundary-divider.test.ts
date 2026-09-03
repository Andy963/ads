import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createLaneActions } from "../app/laneActions";
import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

describe("session boundary divider and status feedback", () => {
  it("inserts a session boundary divider and retains prior messages when starting a new session", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const rt = ctx.activeRuntime.value;
    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Previous user request" },
      { id: "a1", role: "assistant", kind: "text", content: "Previous model response" },
    ];

    await projects.startNewChatSession();

    // Messages should be retained with divider appended
    expect(rt.messages.value).toHaveLength(3);
    expect(rt.messages.value[0]?.content).toBe("Previous user request");
    expect(rt.messages.value[1]?.content).toBe("Previous model response");

    const divider = rt.messages.value[2]!;
    expect(divider.role).toBe("system");
    expect(divider.kind).toBe("divider");
    expect(divider.content).toBe(
      "Previous messages above are retained for review only and are NOT injected into model prompt context.",
    );

    // Composer status feedback
    expect(rt.laneStatus.value).toEqual({
      kind: "info",
      message: "New session active: clean context (previous history is not included).",
    });
  });

  it("does not insert duplicate consecutive dividers on repeated new session calls", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const rt = ctx.activeRuntime.value;
    rt.messages.value = [
      { id: "u1", role: "user", kind: "text", content: "Initial prompt" },
    ];

    await projects.startNewChatSession();
    expect(rt.messages.value).toHaveLength(2);
    expect(rt.messages.value[1]?.kind).toBe("divider");

    await projects.startNewChatSession();
    expect(rt.messages.value).toHaveLength(2);
    expect(rt.messages.value[1]?.kind).toBe("divider");
  });

  it("does not insert a divider if messages are empty", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const rt = ctx.activeRuntime.value;
    rt.messages.value = [];

    await projects.startNewChatSession();
    expect(rt.messages.value).toHaveLength(0);
    expect(rt.laneStatus.value).toEqual({
      kind: "info",
      message: "New session active: clean context (previous history is not included).",
    });
  });

  it("replays session_divider from history bootstrap and sets fresh session status", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    ctx.loggedIn.value = true;
    projects.initializeProjects();
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      rt,
      project: { id: "default", sessionId: "default", chatSessionId: "main" } as any,
      projects: ctx.projects,
      activeProjectId: ctx.activeProjectId,
      activeProject: ctx.activeProject,
      cancelPendingResume: chat.cancelPendingResume,
      clearPendingPrompt: vi.fn(),
      clearStepLive: vi.fn(),
      finalizeAssistant: vi.fn(),
      finalizeCommandBlock: vi.fn(),
      flushQueuedPrompts: vi.fn(),
      pushMessageBeforeLive: vi.fn(),
      threadReset: vi.fn(),
      updateProject: vi.fn(),
      applyResumeHistory: chat.applyResumeHistory,
      randomId: (p) => `${p}-1`,
    });

    handler({
      type: "history",
      items: [
        { role: "user", text: "past prompt", ts: 100 },
        { role: "ai", text: "past reply", ts: 101 },
        {
          role: "status",
          kind: "session_divider",
          text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
          ts: 102,
        },
      ],
    });

    expect(rt.messages.value).toHaveLength(3);
    expect(rt.messages.value[0]?.content).toBe("past prompt");
    expect(rt.messages.value[1]?.content).toBe("past reply");
    expect(rt.messages.value[2]?.kind).toBe("divider");
    expect(rt.laneStatus.value).toEqual({
      kind: "info",
      message: "New session active: clean context (previous history is not included).",
    });
  });

  it("positions divider correctly when history includes both past and new turns on reload", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    ctx.loggedIn.value = true;
    projects.initializeProjects();
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      rt,
      project: { id: "default", sessionId: "default", chatSessionId: "main" } as any,
      projects: ctx.projects,
      activeProjectId: ctx.activeProjectId,
      activeProject: ctx.activeProject,
      cancelPendingResume: chat.cancelPendingResume,
      clearPendingPrompt: vi.fn(),
      clearStepLive: vi.fn(),
      finalizeAssistant: vi.fn(),
      finalizeCommandBlock: vi.fn(),
      flushQueuedPrompts: vi.fn(),
      pushMessageBeforeLive: vi.fn(),
      threadReset: vi.fn(),
      updateProject: vi.fn(),
      applyResumeHistory: chat.applyResumeHistory,
      randomId: (p) => `${p}-1`,
    });

    handler({
      type: "history",
      items: [
        { role: "user", text: "past prompt", ts: 100 },
        { role: "ai", text: "past reply", ts: 101 },
        {
          role: "status",
          kind: "session_divider",
          text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
          ts: 102,
        },
        { role: "user", text: "new turn prompt", ts: 103 },
        { role: "ai", text: "new turn reply", ts: 104 },
      ],
    });

    expect(rt.messages.value).toHaveLength(5);
    expect(rt.messages.value[0]?.content).toBe("past prompt");
    expect(rt.messages.value[1]?.content).toBe("past reply");
    expect(rt.messages.value[2]?.kind).toBe("divider");
    expect(rt.messages.value[3]?.content).toBe("new turn prompt");
    expect(rt.messages.value[4]?.content).toBe("new turn reply");

    // Since turns ran in the new session, laneStatus fresh session notice should be cleared
    expect(rt.laneStatus.value).toBeNull();
  });

  it("clears laneStatus fresh session notice when first turn completes with result", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    ctx.loggedIn.value = true;
    projects.initializeProjects();
    const rt = ctx.activeRuntime.value;

    const handler = createWsMessageHandler({
      rt,
      project: { id: "default", sessionId: "default", chatSessionId: "main" } as any,
      projects: ctx.projects,
      activeProjectId: ctx.activeProjectId,
      activeProject: ctx.activeProject,
      cancelPendingResume: chat.cancelPendingResume,
      clearPendingPrompt: vi.fn(),
      clearStepLive: vi.fn(),
      finalizeAssistant: vi.fn(),
      finalizeCommandBlock: vi.fn(),
      flushQueuedPrompts: vi.fn(),
      pushMessageBeforeLive: vi.fn(),
      threadReset: vi.fn(),
      updateProject: vi.fn(),
      applyResumeHistory: chat.applyResumeHistory,
      randomId: (p) => `${p}-1`,
    });

    rt.laneStatus.value = {
      kind: "info",
      message: "New session active: clean context (previous history is not included).",
    };

    handler({
      type: "result",
      output: "Completed turn output",
    });

    expect(rt.laneStatus.value).toBeNull();
  });

  it("handles /clear slash command in sendMainPrompt and sendPlannerPrompt by executing full clear", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    const tasks = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectPlannerWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const workerRt = ctx.activeRuntime.value;
    const plannerRt = ctx.activePlannerRuntime.value;
    workerRt.ws = { clearHistory: vi.fn() } as any;
    plannerRt.ws = { clearHistory: vi.fn() } as any;

    workerRt.messages.value = [
      { id: "m1", role: "user", kind: "text", content: "something" },
    ];
    plannerRt.messages.value = [
      { id: "p1", role: "user", kind: "text", content: "planner something" },
    ];

    tasks.sendMainPrompt("/clear");
    expect(workerRt.messages.value).toHaveLength(0);
    expect(workerRt.ws?.clearHistory).toHaveBeenCalled();

    tasks.sendPlannerPrompt("  /CLEAR  ");
    expect(plannerRt.messages.value).toHaveLength(0);
    expect(plannerRt.ws?.clearHistory).toHaveBeenCalled();
  });
});
