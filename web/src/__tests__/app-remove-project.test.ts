import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type DeleteImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let deleteImpl: DeleteImpl | null = null;
let deleteCalls: string[] = [];

type RemoteProject = {
  id: string;
  workspaceRoot: string;
  name: string;
  chatSessionId: string;
  createdAt?: number;
  updatedAt?: number;
};

let projectsFromApi: RemoteProject[] = [];
let activeProjectIdFromApi: string | null = null;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async patch<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async delete<T>(url: string): Promise<T> {
      deleteCalls.push(url);
      if (!deleteImpl) throw new Error("deleteImpl not set");
      return (await deleteImpl(url)) as T;
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

    connect(): void {
      queueMicrotask(() => this.onOpen?.());
    }

    close(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => {
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        queueMicrotask(() => {
          this.$emit("logged-in", { id: "u-1", username: "admin" });
        });
      },
      template: "<div />",
    }),
  };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

function idsFromVm(wrapper: { vm: { projects: Array<{ id: string }> } }): string[] {
  return wrapper.vm.projects.map((p) => p.id);
}

describe("App.removeProject", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }

    deleteCalls = [];
    projectsFromApi = [];
    activeProjectIdFromApi = null;

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") return { projects: projectsFromApi, activeProjectId: activeProjectIdFromApi };
      if (url.includes("/api/task-queue/status")) {
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };

    deleteImpl = async () => {
      throw new Error("deleteImpl not overridden");
    };
  });

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    getImpl = null;
    deleteImpl = null;
    deleteCalls = [];
    projectsFromApi = [];
    activeProjectIdFromApi = null;
    vi.clearAllMocks();
  });

  it("removes an active project and switches to a fallback project", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
      { id: "p3", workspaceRoot: "/w/p3", name: "P3", chatSessionId: "main", createdAt: 3, updatedAt: 3 },
    ];
    activeProjectIdFromApi = "p2";

    deleteImpl = async (url: string) => {
      expect(url).toBe("/api/projects/p2");
      projectsFromApi = projectsFromApi.filter((p) => p.id !== "p2");
      activeProjectIdFromApi = "p1";
      return { success: true, activeProjectId: "p1" };
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);
    expect((wrapper.vm as any).activeProjectId).toBe("p2");

    await (wrapper.vm as unknown as { removeProject: (id: string) => Promise<void> }).removeProject("p2");
    await settleUi(wrapper);

    expect(deleteCalls).toEqual(["/api/projects/p2"]);
    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p3"]);
    expect((wrapper.vm as any).activeProjectId).toBe("p1");

    wrapper.unmount();
  });

  it("rolls back on API failure", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
    ];
    activeProjectIdFromApi = "p1";

    deleteImpl = async () => {
      throw new Error("boom");
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2"]);

    await (wrapper.vm as unknown as { removeProject: (id: string) => Promise<void> }).removeProject("p2");
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2"]);
    wrapper.unmount();
  });
});

