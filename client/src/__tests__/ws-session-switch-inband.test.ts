import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createProjectActions } from "../app/projectsWs/projectActions";

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
