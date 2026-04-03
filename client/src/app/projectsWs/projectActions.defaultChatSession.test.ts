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

  it("preserves the locally active project when the server omits activeProjectId", async () => {
    localStorage.clear();

    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "p1", path: "/tmp/project-a", name: "Project A", initialized: true, chatSessionId: "main" },
        { sessionId: "p2", path: "/tmp/project-b", name: "Project B", initialized: true, chatSessionId: "main" },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "p2");
    projects.initializeProjects();

    expect(ctx.activeProjectId.value).toBe("p2");

    vi.spyOn(ctx.api, "get").mockResolvedValue({
      projects: [
        { id: "p1", workspaceRoot: "/tmp/project-a", name: "Project A", chatSessionId: "main" },
        { id: "p2", workspaceRoot: "/tmp/project-b", name: "Project B", chatSessionId: "main" },
      ],
      activeProjectId: null,
    });

    await projects.loadProjectsFromServer();

    expect(ctx.activeProjectId.value).toBe("p2");
  });

  it("preserves the locally visible active project when the server reports a different activeProjectId", async () => {
    localStorage.clear();

    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "p1", path: "/tmp/project-a", name: "Project A", initialized: true, chatSessionId: "main" },
        { sessionId: "p2", path: "/tmp/project-b", name: "Project B", initialized: true, chatSessionId: "main" },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "p2");
    projects.initializeProjects();

    expect(ctx.activeProjectId.value).toBe("p2");

    vi.spyOn(ctx.api, "get").mockResolvedValue({
      projects: [
        { id: "p1", workspaceRoot: "/tmp/project-a", name: "Project A", chatSessionId: "main" },
        { id: "p2", workspaceRoot: "/tmp/project-b", name: "Project B", chatSessionId: "main" },
      ],
      activeProjectId: "p1",
    });

    await projects.loadProjectsFromServer();

    expect(ctx.activeProjectId.value).toBe("p2");
  });

  it("still accepts the server active project when bootstrapping from only the synthetic default tab", async () => {
    localStorage.clear();

    const ctx = createAppContext();
    const chat = createChatActions(ctx as AppContext);
    const deps = {
      activateProject: vi.fn(async () => {}),
    };
    const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ReturnType<typeof createChatActions>, deps);

    ctx.loggedIn.value = true;
    projects.initializeProjects();

    expect(ctx.activeProjectId.value).toBe("default");

    vi.spyOn(ctx.api, "get").mockResolvedValue({
      projects: [
        { id: "p1", workspaceRoot: "/tmp/project-a", name: "Project A", chatSessionId: "main" },
        { id: "p2", workspaceRoot: "/tmp/project-b", name: "Project B", chatSessionId: "main" },
      ],
      activeProjectId: "p2",
    });

    await projects.loadProjectsFromServer();

    expect(ctx.activeProjectId.value).toBe("p2");
  });
});

