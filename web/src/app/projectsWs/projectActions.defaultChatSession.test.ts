import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions } from "../chat";
import { createProjectActions } from "../projectsWs";

describe("projectActions.loadProjectsFromServer", () => {
  it("preserves default chatSessionId across server refresh", async () => {
    localStorage.clear();

    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    await projects.startNewChatSession();

    const before = ctx.projects.value.find((p) => p.id === "default")?.chatSessionId ?? null;
    expect(before).not.toBeNull();
    expect(before).not.toBe("main");

    vi.spyOn(ctx.api, "get").mockResolvedValue({
      projects: [],
      activeProjectId: null,
    });
    await projects.loadProjectsFromServer();

    const after = ctx.projects.value.find((p) => p.id === "default")?.chatSessionId ?? null;
    expect(after).toBe(before);
  });
});

