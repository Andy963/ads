import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;
let tasksFromApi: Task[] = [];

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

    constructor(_: { sessionId: string }) {}

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
        this.$emit("logged-in", { id: "u-1", username: "admin" });
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

async function waitForTasks(wrapper: { vm: { tasks: Task[]; $nextTick: () => Promise<void> } }, count: number): Promise<void> {
  const maxRounds = 25;
  for (let i = 0; i < maxRounds; i++) {
    if (Array.isArray(wrapper.vm.tasks) && wrapper.vm.tasks.length >= count) {
      return;
    }
    await settleUi(wrapper);
  }
  throw new Error(`tasks not loaded after ${maxRounds} rounds`);
}

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "",
    model: overrides.model ?? "mock",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 0,
    createdAt: overrides.createdAt ?? now,
    queuedAt: overrides.queuedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
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

describe("App.reorderPendingTasks optimistic update", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    tasksFromApi = [];
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return tasksFromApi;
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
    getImpl = null;
    postImpl = null;
    vi.clearAllMocks();
  });

  it("updates queueOrder immediately and then applies server response", async () => {
    const d = defer<{ success: boolean; tasks: Task[] }>();
    postImpl = async (url: string, body: unknown) => {
      expect(url).toContain("/api/tasks/reorder");
      expect(body).toEqual({ ids: ["c", "a", "b"] });
      return d.promise;
    };

    tasksFromApi = [
      makeTask({ id: "a", queueOrder: 10 }),
      makeTask({ id: "b", queueOrder: 20 }),
      makeTask({ id: "c", queueOrder: 30 }),
    ];

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await waitForTasks(wrapper, 3);

    const reorderPromise = (wrapper.vm as unknown as { reorderPendingTasks: (ids: string[]) => Promise<void> }).reorderPendingTasks([
      "c",
      "a",
      "b",
    ]);
    await settleUi(wrapper);

    const afterOptimistic = wrapper.vm.tasks.slice().sort((x: Task, y: Task) => x.queueOrder - y.queueOrder);
    expect(afterOptimistic.map((t: Task) => t.id)).toEqual(["c", "a", "b"]);

    d.resolve({
      success: true,
      tasks: [
        makeTask({ id: "c", queueOrder: 1 }),
        makeTask({ id: "a", queueOrder: 2 }),
        makeTask({ id: "b", queueOrder: 3 }),
      ],
    });
    await reorderPromise;
    await settleUi(wrapper);

    const afterServer = wrapper.vm.tasks.slice().sort((x: Task, y: Task) => x.queueOrder - y.queueOrder);
    expect(afterServer.map((t: Task) => t.id)).toEqual(["c", "a", "b"]);

    wrapper.unmount();
  });

  it("rolls back on API failure", async () => {
    postImpl = async () => {
      throw new Error("boom");
    };

    tasksFromApi = [
      makeTask({ id: "a", queueOrder: 10 }),
      makeTask({ id: "b", queueOrder: 20 }),
      makeTask({ id: "c", queueOrder: 30 }),
    ];

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await waitForTasks(wrapper, 3);

    await (wrapper.vm as unknown as { reorderPendingTasks: (ids: string[]) => Promise<void> }).reorderPendingTasks(["c", "a", "b"]);
    await settleUi(wrapper);

    const restored = wrapper.vm.tasks.slice().sort((x: Task, y: Task) => x.queueOrder - y.queueOrder);
    expect(restored.map((t: Task) => t.id)).toEqual(["a", "b", "c"]);

    wrapper.unmount();
  });
});
