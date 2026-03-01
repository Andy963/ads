import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;
type PatchImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;
let patchImpl: PatchImpl | null = null;
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

    async patch<T>(url: string, body: unknown): Promise<T> {
      if (!patchImpl) throw new Error("patchImpl not set");
      return (await patchImpl(url, body)) as T;
    }

    async delete<T>(): Promise<T> {
      throw new Error("not implemented");
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
    prompt: overrides.prompt ?? "P",
    model: overrides.model ?? "mock",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    agentId: overrides.agentId ?? null,
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

describe("App.updateQueuedTaskAndRun", () => {
  beforeEach(() => {
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
    patchImpl = async () => {
      throw new Error("patchImpl not overridden");
    };
  });

  afterEach(() => {
    getImpl = null;
    postImpl = null;
    patchImpl = null;
    vi.clearAllMocks();
  });

  it("patches the task, moves it to the end of the pending queue, and starts the queue", async () => {
    const calls: Array<{ method: "PATCH" | "POST"; url: string; body: unknown }> = [];

    tasksFromApi = [
      makeTask({ id: "t-1", queueOrder: 1, status: "pending" }),
      makeTask({ id: "t-2", queueOrder: 2, status: "pending" }),
      makeTask({ id: "t-3", queueOrder: 3, status: "pending" }),
    ];

    patchImpl = async (url: string, body: unknown) => {
      calls.push({ method: "PATCH", url, body });
      expect(url).toContain("/api/tasks/t-2");
      expect(body).toEqual({ title: "Updated", prompt: "Updated prompt" });
      const updated = makeTask({ id: "t-2", title: "Updated", prompt: "Updated prompt", queueOrder: 2, status: "pending" });
      return { success: true, task: updated };
    };

    postImpl = async (url: string, body: unknown) => {
      calls.push({ method: "POST", url, body });
      if (url.includes("/api/tasks/reorder")) {
        expect(body).toEqual({ ids: ["t-1", "t-3", "t-2"] });
        return {
          success: true,
          tasks: [
            makeTask({ id: "t-1", queueOrder: 1, status: "pending" }),
            makeTask({ id: "t-3", queueOrder: 2, status: "pending" }),
            makeTask({ id: "t-2", queueOrder: 3, status: "pending" }),
          ],
        };
      }
      if (url.includes("/api/task-queue/run")) {
        return { enabled: true, running: true, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await waitForTasks(wrapper, 3);

    await (wrapper.vm as unknown as { updateQueuedTaskAndRun: (id: string, updates: unknown) => Promise<void> }).updateQueuedTaskAndRun(
      "t-2",
      { title: "Updated", prompt: "Updated prompt" },
    );
    await settleUi(wrapper);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringContaining("PATCH /api/tasks/t-2"),
      expect.stringContaining("POST /api/tasks/reorder"),
      expect.stringContaining("POST /api/task-queue/run"),
    ]);

    wrapper.unmount();
  }, 10_000);

  it("patches a cancelled task and runs it via single-task run", async () => {
    const calls: Array<{ method: "PATCH" | "POST"; url: string; body: unknown }> = [];

    const cancelled = makeTask({ id: "t-1", status: "cancelled" });
    tasksFromApi = [cancelled];

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.includes("/api/tasks/t-1") && !url.includes("?limit=")) {
        return { ...cancelled, messages: [] };
      }
      if (url.startsWith("/api/tasks")) return tasksFromApi;
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };

    patchImpl = async (url: string, body: unknown) => {
      calls.push({ method: "PATCH", url, body });
      expect(url).toContain("/api/tasks/t-1");
      expect(body).toEqual({ title: "Updated", prompt: "Updated prompt" });
      return { success: true, task: { ...cancelled, title: "Updated", prompt: "Updated prompt" } };
    };

    postImpl = async (url: string, body: unknown) => {
      calls.push({ method: "POST", url, body });
      if (url.includes("/api/tasks/t-1/run")) {
        expect(body).toEqual({});
        return { success: true, taskId: "t-1", mode: "single", state: "scheduled" };
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await waitForTasks(wrapper, 1);

    await (wrapper.vm as unknown as { updateQueuedTaskAndRun: (id: string, updates: unknown) => Promise<void> }).updateQueuedTaskAndRun(
      "t-1",
      { title: "Updated", prompt: "Updated prompt" },
    );
    await settleUi(wrapper);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringContaining("PATCH /api/tasks/t-1"),
      expect.stringContaining("POST /api/tasks/t-1/run"),
    ]);

    wrapper.unmount();
  }, 10_000);

  it("reruns a completed task and starts the task queue", async () => {
    const calls: Array<{ method: "PATCH" | "POST"; url: string; body: unknown }> = [];

    const completed = makeTask({ id: "t-1", status: "completed" });
    const rerun = makeTask({ id: "t-2", status: "pending" });
    tasksFromApi = [completed];

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return tasksFromApi;
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };

    patchImpl = async () => {
      throw new Error("PATCH should not be used for rerun");
    };

    postImpl = async (url: string, body: unknown) => {
      calls.push({ method: "POST", url, body });
      if (url.includes("/api/tasks/t-1/rerun")) {
        expect(body).toEqual({ title: "Updated", prompt: "Updated prompt" });
        return { success: true, task: { ...rerun, title: "Updated", prompt: "Updated prompt" } };
      }
      if (url.includes("/api/task-queue/run")) {
        return { enabled: true, running: true, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await waitForTasks(wrapper, 1);

    await (wrapper.vm as unknown as { updateQueuedTaskAndRun: (id: string, updates: unknown) => Promise<void> }).updateQueuedTaskAndRun(
      "t-1",
      { title: "Updated", prompt: "Updated prompt" },
    );
    await settleUi(wrapper);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      expect.stringContaining("POST /api/tasks/t-1/rerun"),
      expect.stringContaining("POST /api/task-queue/run"),
    ]);

    wrapper.unmount();
  }, 10_000);
});
