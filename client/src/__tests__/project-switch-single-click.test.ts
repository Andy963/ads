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

// vue-test-utils builds a MouseEvent whose `button` is read-only, so pointer
// events are dispatched directly with the fields the handlers actually read.
function dispatchPointer(
  element: Element,
  type: "pointerdown" | "pointerup" | "pointercancel",
  init: { pointerId: number; pointerType?: string; clientX?: number; clientY?: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  element.dispatchEvent(event);
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
      // The real endpoint is /api/paths/subdirs; mocking the wrong path left
      // allowedDirs undefined, so the default project's path was always empty
      // in tests and never matched production.
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: ["/tmp"] };
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

  it("keeps the same row element when the server hands back canonical ids", async () => {
    // Locally stored ids predate the server's canonical session ids, but both
    // describe the same workspace paths. Keying rows by id tore every row down
    // when /api/projects resolved, and a click whose press landed before that
    // teardown never produced a click event at all.
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "local-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "local-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "local-a");
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
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await wrapper.vm.$nextTick();
    await Promise.resolve();

    const rowBefore = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(rowBefore).toBeTruthy();
    const elementBefore = rowBefore!.element;
    // The default row is a fixed slot whose path is only filled in once
    // /api/paths/subdirs answers, so it must not be keyed by that path either.
    const defaultRowBefore = wrapper.findAll("button.projectRow")[0]!.element;

    await settleUi(wrapper);

    const rowAfter = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(rowAfter).toBeTruthy();
    expect((wrapper.vm as any).activeProjectId).toBe("sess-a");
    // Same DOM node across the id rewrite: nothing was unmounted mid-interaction.
    expect(rowAfter!.element).toBe(elementBefore);
    expect(wrapper.findAll("button.projectRow")[0]!.element).toBe(defaultRowBefore);

    wrapper.unmount();
  }, 30_000);

  it("switches on a pointerdown/pointerup pair even when no click follows", async () => {
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
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    expect((wrapper.vm as any).activeProjectId).toBe("sess-a");

    const rowB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    expect(rowB).toBeTruthy();

    // A row rebuilt between press and release yields no click; the pointer pair
    // must still switch.
    dispatchPointer(rowB!.element, "pointerdown", { pointerId: 1, clientX: 40, clientY: 40 });
    dispatchPointer(rowB!.element, "pointerup", { pointerId: 1, clientX: 41, clientY: 42 });
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    wrapper.unmount();
  }, 30_000);

  it("does not double-toggle when the browser also delivers the click", async () => {
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
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const rowB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    dispatchPointer(rowB!.element, "pointerdown", { pointerId: 1, clientX: 40, clientY: 40 });
    dispatchPointer(rowB!.element, "pointerup", { pointerId: 1, clientX: 40, clientY: 40 });
    await rowB!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");
    // The follow-up click must not collapse the row it just expanded.
    const projects = (wrapper.vm as any).projects as Array<{ id: string; expanded: boolean }>;
    expect(projects.find((p) => p.id === "sess-b")?.expanded).toBe(true);
    wrapper.unmount();
  }, 30_000);

  it("ignores a pointer release that drifted away from the press", async () => {
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
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const rowB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("B"));
    // A touch scroll: press and release on the row, but the finger moved far.
    dispatchPointer(rowB!.element, "pointerdown", { pointerId: 2, pointerType: "touch", clientX: 40, clientY: 200 });
    dispatchPointer(rowB!.element, "pointerup", { pointerId: 2, pointerType: "touch", clientX: 40, clientY: 60 });
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-a");
    wrapper.unmount();
  }, 30_000);
});
