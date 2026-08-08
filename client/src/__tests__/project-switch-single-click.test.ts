import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
const patchedUrls: string[] = [];
let projectsResponse: unknown;
let projectBValidationResponse: unknown;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      return {} as T;
    }

    async patch<T>(url: string): Promise<T> {
      patchedUrls.push(url);
      return { success: true } as T;
    }

    async delete<T>(): Promise<T> {
      throw new Error("not implemented");
    }
  }

  return { ApiClient };
});

const openedSockets: Array<{ sessionId: string; chatSessionId?: string; connected: boolean }> = [];

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;

    private record: { sessionId: string; chatSessionId?: string; connected: boolean };

    constructor(opts: { sessionId: string; chatSessionId?: string }) {
      this.record = { sessionId: opts.sessionId, chatSessionId: opts.chatSessionId, connected: false };
      openedSockets.push(this.record);
    }

    connect(): void {
      this.record.connected = true;
      queueMicrotask(() => this.onOpen?.());
    }

    close(): void {}

    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => {
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        // App's own onMounted runs after every child's mounted hook, and
        // handleLoggedIn drops the event while appMounted is still false.
        // A real user can only log in after the app is mounted, so defer.
        void nextTick(() => {
          this.$emit("logged-in", { id: "u-1", username: "admin" });
        });
      },
      template: "<div />",
    }),
  };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await wrapper.vm.$nextTick();
    await Promise.resolve();
  }
}

describe("Project switch with server-resolved project identity", () => {
  beforeEach(() => {
    localStorage.clear();
    openedSockets.length = 0;
    patchedUrls.length = 0;
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "sess-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "sess-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "sess-a");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) {
        const raw = decodeURIComponent(url.split("path=")[1] ?? "");
        // Production behaviour: the server answers with the canonical workspace root
        // and its derived project session id.
        const sessionId = raw.endsWith("project-a") ? "sess-a" : "sess-b";
        if (sessionId === "sess-b") return projectBValidationResponse;
        return { ok: true, resolvedPath: raw, workspaceRoot: raw, projectSessionId: sessionId };
      }
      if (url === "/api/projects") {
        return projectsResponse;
      }
      if (url.startsWith("/api/projects/subdirs")) return { dirs: [] };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("switches to another project on the first row click", async () => {
    projectBValidationResponse = {
      ok: true,
      resolvedPath: "/tmp/project-b",
      workspaceRoot: "/tmp/project-b",
      projectSessionId: "sess-b",
    };
    projectsResponse = {
      projects: [
        { id: "sess-a", workspaceRoot: "/tmp/project-a", name: "A", chatSessionId: "chat-a" },
        { id: "sess-b", workspaceRoot: "/tmp/project-b", name: "B", chatSessionId: "chat-b" },
      ],
      activeProjectId: "sess-a",
    };
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false } },
    });
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-a");
    expect(openedSockets.some((s) => s.sessionId === "sess-a" && s.connected)).toBe(true);

    const rowB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B")) ?? null;
    expect(rowB).toBeTruthy();

    await rowB!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(openedSockets.some((s) => s.sessionId === "sess-b" && s.connected)).toBe(true);

    wrapper.unmount();
  }, 30_000);

  it("keeps a first-click selection when an older project refresh resolves afterward", async () => {
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "local-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "local-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "local-a");
    let resolveProjects: ((value: unknown) => void) | null = null;
    let resolveProjectBValidation: ((value: unknown) => void) | null = null;
    projectsResponse = new Promise((resolve) => {
      resolveProjects = resolve;
    });
    projectBValidationResponse = new Promise((resolve) => {
      resolveProjectBValidation = resolve;
    });

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false } },
    });
    await wrapper.vm.$nextTick();
    await Promise.resolve();

    const rowB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B")) ?? null;
    expect(rowB).toBeTruthy();
    await rowB!.trigger("click");
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).activeProjectId).toBe("local-b");

    resolveProjects?.({
      projects: [
        { id: "sess-a", workspaceRoot: "/tmp/project-a", name: "A", chatSessionId: "chat-a" },
        { id: "sess-b", workspaceRoot: "/tmp/project-b", name: "B", chatSessionId: "chat-b" },
      ],
      activeProjectId: "sess-a",
    });
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    expect(wrapper.find(".projectNode.active .projectName").text()).toContain("B");
    resolveProjectBValidation?.({
      ok: true,
      resolvedPath: "/tmp/project-b",
      workspaceRoot: "/tmp/project-b",
      projectSessionId: "sess-b",
    });
    await settleUi(wrapper);
    wrapper.unmount();
  }, 30_000);
});
