import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;

type RemoteProject = {
  id: string;
  workspaceRoot: string;
  name: string;
  chatSessionId: string;
  createdAt?: number;
  updatedAt?: number;
};

let projectsFromApi: RemoteProject[] = [];

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(url: string, body: unknown): Promise<T> {
      if (!postImpl) throw new Error("postImpl not set");
      return (await postImpl(url, body)) as T;
    }

    async patch<T>(): Promise<T> {
      throw new Error("not implemented");
    }

    async delete<T>(): Promise<T> {
      throw new Error("not implemented");
    }
  }

  return {
    ApiClient,
  };
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

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function idsFromVm(wrapper: { vm: { projects: Array<{ id: string }> } }): string[] {
  return wrapper.vm.projects.map((p) => p.id);
}

describe("App.reorderProjects optimistic update", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    projectsFromApi = [];
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") return { projects: projectsFromApi, activeProjectId: "p1" };
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
    postImpl = async () => {
      throw new Error("postImpl not overridden");
    };
  });

  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    projectsFromApi = [];
    getImpl = null;
    postImpl = null;
    vi.clearAllMocks();
  });

  it("reorders immediately and persists via /api/projects/reorder", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
      { id: "p3", workspaceRoot: "/w/p3", name: "P3", chatSessionId: "main", createdAt: 3, updatedAt: 3 },
    ];

    const d = defer<{ success: boolean }>();
    postImpl = async (url: string, body: unknown) => {
      expect(url).toBe("/api/projects/reorder");
      expect(body).toEqual({ ids: ["p3", "p1", "p2"] });
      projectsFromApi = [projectsFromApi[2]!, projectsFromApi[0]!, projectsFromApi[1]!];
      return d.promise;
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    const reorderPromise = (wrapper.vm as unknown as { reorderProjects: (ids: string[]) => Promise<void> }).reorderProjects([
      "p3",
      "p1",
      "p2",
    ]);
    await settleUi(wrapper);
    expect(idsFromVm(wrapper as any)).toEqual(["default", "p3", "p1", "p2"]);

    d.resolve({ success: true });
    await reorderPromise;
    await settleUi(wrapper);

    wrapper.unmount();

    const wrapper2 = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper2);
    expect(idsFromVm(wrapper2 as any)).toEqual(["default", "p3", "p1", "p2"]);
    wrapper2.unmount();
  });

  it("rolls back on API failure", async () => {
    projectsFromApi = [
      { id: "p1", workspaceRoot: "/w/p1", name: "P1", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
      { id: "p2", workspaceRoot: "/w/p2", name: "P2", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
      { id: "p3", workspaceRoot: "/w/p3", name: "P3", chatSessionId: "main", createdAt: 3, updatedAt: 3 },
    ];

    postImpl = async () => {
      throw new Error("boom");
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    await (wrapper.vm as unknown as { reorderProjects: (ids: string[]) => Promise<void> }).reorderProjects(["p3", "p1", "p2"]);
    await settleUi(wrapper);

    expect(idsFromVm(wrapper as any)).toEqual(["default", "p1", "p2", "p3"]);

    wrapper.unmount();
  });
});
