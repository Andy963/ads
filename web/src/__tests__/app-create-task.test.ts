import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;

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

describe("App.createTask chat insertion", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
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
    getImpl = null;
    postImpl = null;
    vi.clearAllMocks();
  });

  it("does not append a user bubble when agent is busy", async () => {
    postImpl = async () =>
      makeTask({
        id: "created-1",
        status: "pending",
        prompt: "Hello",
      });

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    wrapper.vm.messages = [];
    wrapper.vm.tasks = [makeTask({ id: "running-1", status: "running" })];
    await settleUi(wrapper);

    const before = wrapper.vm.messages.length;
    await wrapper.vm.createTask({ prompt: "Hello" });
    await settleUi(wrapper);

    expect(wrapper.vm.messages).toHaveLength(before);
    wrapper.unmount();
  }, 15000);

  it("creates the task and selects it without mutating the chat stream", async () => {
    postImpl = async () =>
      makeTask({
        id: "created-2",
        status: "pending",
        prompt: "Hello",
      });

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    wrapper.vm.messages = [];
    wrapper.vm.busy = false;
    wrapper.vm.tasks = [];
    await settleUi(wrapper);

    await wrapper.vm.createTask({ prompt: "Hello" });
    await settleUi(wrapper);

    expect(wrapper.vm.messages).toHaveLength(0);
    expect(wrapper.vm.selectedId).toBe("created-2");
    expect(wrapper.vm.tasks).toHaveLength(1);
    expect(wrapper.vm.tasks[0]).toMatchObject({ id: "created-2", prompt: "Hello" });
    wrapper.unmount();
  });

  it("submitTaskCreateAndRun creates the task and starts the queue", async () => {
    const called: string[] = [];
    postImpl = async (url: string) => {
      called.push(url);
      if (url.includes("/api/tasks") && !url.includes("/reorder") && !url.includes("/run")) {
        return makeTask({ id: "created-3", status: "pending", prompt: "Hello" });
      }
      if (url.includes("/api/task-queue/run")) {
        return { enabled: true, running: true, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    await (wrapper.vm as unknown as { submitTaskCreateAndRun: (input: { prompt: string }) => Promise<void> }).submitTaskCreateAndRun({
      prompt: "Hello",
    });
    await settleUi(wrapper);

    expect(called.some((u) => u.includes("/api/tasks"))).toBe(true);
    expect(called.some((u) => u.includes("/api/task-queue/run"))).toBe(true);

    wrapper.unmount();
  });
});

describe("App task:completed result dedupe", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
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
    getImpl = null;
    postImpl = null;
    vi.clearAllMocks();
  });

  it("does not show duplicated task result when task:completed is delivered twice", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    wrapper.vm.messages = [];
    await settleUi(wrapper);

    const completed = makeTask({
      id: "task-1",
      status: "completed",
      result: "Done",
      completedAt: Date.now(),
    });

    const onTaskEvent = (wrapper.vm as unknown as { onTaskEvent?: (payload: { event: string; data: unknown }) => void }).onTaskEvent;
    expect(typeof onTaskEvent).toBe("function");

    onTaskEvent?.({ event: "task:completed", data: completed });
    onTaskEvent?.({ event: "task:completed", data: completed });
    await settleUi(wrapper);

    const assistantMessages = wrapper.vm.messages.filter((m: { role: string }) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: "Done" });
    wrapper.unmount();
  });
});
