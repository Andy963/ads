import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createTaskActions } from "../app/tasks";

describe("composer draft preservation on session reset", () => {
  it("preserves composerDraft text when clearChatState is executed", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    const rt = ctx.activeRuntime.value;
    rt.composerDraft.value = "Unfinished prompt drafted by user";
    rt.messages.value = [
      { id: "m1", role: "user", kind: "text", content: "Old message" },
      { id: "m2", role: "assistant", kind: "text", content: "Old response" },
    ];
    rt.queuedPrompts.value = [
      { id: "q1", clientMessageId: "c1", text: "Queued", images: [], createdAt: Date.now() },
    ];

    projects.clearChatState();

    // History and queues must be cleared
    expect(rt.messages.value).toHaveLength(0);
    expect(rt.queuedPrompts.value).toHaveLength(0);

    // Composer draft must remain intact
    expect(rt.composerDraft.value).toBe("Unfinished prompt drafted by user");
  });

  it("preserves composerDraft when starting a new chat session", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const rt = ctx.activeRuntime.value;
    rt.composerDraft.value = "Draft for a new clean session";
    const initialSessionId = rt.chatSessionId;

    await projects.startNewChatSession();

    // Session ID should be changed
    expect(rt.chatSessionId).not.toBe(initialSessionId);

    // Composer draft text must be preserved
    expect(rt.composerDraft.value).toBe("Draft for a new clean session");
  });

  it("preserves drafts when resetting worker and planner chat state", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    const tasks = createTaskActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectPlannerWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const workerRt = ctx.activeRuntime.value;
    const plannerRt = ctx.activePlannerRuntime.value;
    workerRt.composerDraft.value = "Worker reset draft";
    plannerRt.composerDraft.value = "Planner reset draft";

    tasks.clearActiveChat();
    tasks.clearPlannerChat();

    expect(workerRt.composerDraft.value).toBe("Worker reset draft");
    expect(plannerRt.composerDraft.value).toBe("Planner reset draft");
  });

  it("scopes worker and planner backend clears to their originating lanes", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    const tasks = createTaskActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectPlannerWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const workerRt = ctx.activeRuntime.value;
    const plannerRt = ctx.activePlannerRuntime.value;
    workerRt.ws = { clearHistory: vi.fn() } as any;
    plannerRt.ws = { clearHistory: vi.fn() } as any;

    tasks.clearActiveChat();
    tasks.clearPlannerChat();

    expect(workerRt.ws?.clearHistory).toHaveBeenCalledWith({ scope: "lane", sourceChatSessionId: "main" });
    expect(plannerRt.ws?.clearHistory).toHaveBeenCalledWith({ scope: "lane", sourceChatSessionId: "planner" });
  });
});
