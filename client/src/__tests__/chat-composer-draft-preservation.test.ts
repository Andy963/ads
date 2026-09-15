import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";
import { createLaneActions } from "../app/laneActions";

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

  it("preserves drafts when resetting worker and advisor chat state", async () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    const tasks = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectAdvisorWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const workerRt = ctx.activeRuntime.value;
    const advisorRt = ctx.activeAdvisorRuntime.value;
    workerRt.composerDraft.value = "Worker reset draft";
    advisorRt.composerDraft.value = "Advisor reset draft";

    tasks.clearActiveChat();
    tasks.clearAdvisorChat();

    expect(workerRt.composerDraft.value).toBe("Worker reset draft");
    expect(advisorRt.composerDraft.value).toBe("Advisor reset draft");
  });

  it("clears worker and advisor drafts after their prompts are queued", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const tasks = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectAdvisorWs: vi.fn(async () => {}),
    });

    const workerRt = ctx.activeRuntime.value;
    const advisorRt = ctx.activeAdvisorRuntime.value;
    workerRt.composerDraft.value = "Worker prompt";
    advisorRt.composerDraft.value = "Advisor prompt";

    tasks.sendMainPrompt("Worker prompt");
    tasks.sendAdvisorPrompt("Advisor prompt");

    expect(workerRt.composerDraft.value).toBe("");
    expect(advisorRt.composerDraft.value).toBe("");
    expect(workerRt.queuedPrompts.value[0]?.text).toBe("Worker prompt");
    expect(advisorRt.queuedPrompts.value[0]?.text).toBe("Advisor prompt");
  });

  it("preserves drafts when prompt enqueue fails before dispatch", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const enqueueMainPrompt = vi.fn(() => {
      throw new Error("dispatch unavailable");
    });
    const tasks = createLaneActions(
      { ...ctx, ...chat, enqueueMainPrompt } as AppContext & ReturnType<typeof createChatActions>,
      {
        connectWs: vi.fn(async () => {}),
        connectAdvisorWs: vi.fn(async () => {}),
      },
    );

    const workerRt = ctx.activeRuntime.value;
    workerRt.composerDraft.value = "Retry this prompt";

    expect(() => tasks.sendMainPrompt("Retry this prompt")).toThrow("dispatch unavailable");
    expect(workerRt.composerDraft.value).toBe("Retry this prompt");
  });

  it("scopes worker and advisor backend clears to their originating lanes", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      activateProject: vi.fn(async () => {}),
    });
    const tasks = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectAdvisorWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    const workerRt = ctx.activeRuntime.value;
    const advisorRt = ctx.activeAdvisorRuntime.value;
    workerRt.ws = { clearHistory: vi.fn() } as any;
    advisorRt.ws = { clearHistory: vi.fn() } as any;

    tasks.clearActiveChat();
    tasks.clearAdvisorChat();

    expect(workerRt.ws?.clearHistory).toHaveBeenCalledWith({ scope: "lane", sourceChatSessionId: "main" });
    expect(advisorRt.ws?.clearHistory).toHaveBeenCalledWith({ scope: "lane", sourceChatSessionId: "advisor" });
  });

  it("uses an in-band new-session reset for the advisor lane", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const tasks = createLaneActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, {
      connectWs: vi.fn(async () => {}),
      connectAdvisorWs: vi.fn(async () => {}),
    });

    ctx.loggedIn.value = true;
    ctx.activeAdvisorRuntime.value.ws = { clearHistory: vi.fn() } as any;

    tasks.startNewAdvisorSession();

    expect(ctx.activeAdvisorRuntime.value.ws?.clearHistory).toHaveBeenCalledWith({
      scope: "lane",
      sourceChatSessionId: "advisor",
      mode: "new_session",
    });
  });

  it("downgrades a advisor shared clear request to the advisor lane", () => {
    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const advisorRt = ctx.activeAdvisorRuntime.value;
    advisorRt.ws = { clearHistory: vi.fn() } as any;

    chat.threadReset(advisorRt, {
      notice: "",
      clearBackendHistory: true,
      clearHistoryPayload: { scope: "shared" },
      resetThreadId: true,
    });

    expect(advisorRt.ws?.clearHistory).toHaveBeenCalledWith({
      scope: "lane",
      sourceChatSessionId: "advisor",
    });
  });
});
