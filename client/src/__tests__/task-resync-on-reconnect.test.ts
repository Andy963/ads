import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";
import { createAppController } from "../app/controller";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  clearHistory: () => void;
} | null = null;

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

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "planner" || chatSessionId === "reviewer") return;
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {
      // Let tests decide when to trigger onOpen/onMessage/onClose.
    }

    close(): void {}

    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
  }

  return { AdsWebSocket };
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

async function mountReconnectHarness() {
  let controller: ReturnType<typeof createAppController> | null = null;
  const Harness = defineComponent({
    name: "TaskReconnectHarness",
    setup() {
      controller = createAppController();
      return {};
    },
    template: "<div />",
  });

  const wrapper = mount(Harness);
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  if (!controller) {
    throw new Error("controller not created");
  }

  controller.loggedIn.value = true;
  controller.currentUser.value = { id: "u-1", username: "admin" } as any;
  await controller.connectWs("default");
  await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });
  expect(lastWs).toBeTruthy();
  return { wrapper, controller, rt: controller.getRuntime("default") };
}

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? "t-1",
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "do something",
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
    startedAt: overrides.startedAt ?? now,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("task list resync on ws reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastWs = null;
    localStorage.clear();
    sessionStorage.clear();

    let queueStatusFetchCount = 0;
    let tasksFetchCount = 0;
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status")) {
        queueStatusFetchCount += 1;
        if (queueStatusFetchCount === 1) {
          return { enabled: true, running: true, ready: true, streaming: true } satisfies TaskQueueStatus;
        }
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      if (url.startsWith("/api/tasks")) {
        tasksFetchCount += 1;
        if (tasksFetchCount === 1) return [makeTask({ status: "running", completedAt: null })] satisfies Task[];
        return [makeTask({ status: "completed", completedAt: Date.now(), result: "ok" })] satisfies Task[];
      }
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWs = null;
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("reloads queue state and tasks after reconnect so missed terminal events do not leave stale task state", async () => {
    const { wrapper, controller, rt } = await mountReconnectHarness();

    await controller.loadQueueStatus("default");
    await controller.loadTasks("default");
    await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });

    expect(rt.queueStatus.value).toMatchObject({ enabled: true, ready: true, running: true, streaming: true });
    expect(rt.tasks.value.map((task) => task.status)).toEqual(["running"]);

    const disconnectedWs = lastWs;

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });

    await vi.advanceTimersByTimeAsync(800);
    await settleUi(wrapper as { vm: { $nextTick: () => Promise<void> } });

    expect(lastWs).toBeTruthy();
    expect(lastWs).not.toBe(disconnectedWs);

    lastWs!.onOpen?.();
    await vi.waitFor(() => {
      expect(rt.queueStatus.value).toMatchObject({ enabled: true, ready: true, running: false, streaming: false });
      expect(rt.tasks.value.map((task) => task.status)).toEqual(["completed"]);
    });

    wrapper.unmount();
  });
});
