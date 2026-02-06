import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

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
      if (chatSessionId === "planner") return;
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

async function ensureWsConnected(wrapper: any): Promise<void> {
  if (!lastWs) {
    await wrapper.vm.connectWs?.();
    await settleUi(wrapper);
  }
  expect(lastWs).toBeTruthy();
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

    let tasksFetchCount = 0;
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
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
  });

  it("reloads tasks after reconnect so missed terminal events do not leave stale status", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    await ensureWsConnected(wrapper);
    await settleUi(wrapper);

    expect(((wrapper.vm as any).tasks ?? []).map((t: any) => t.status)).toEqual(["running"]);

    // Simulate a WS disconnect that could cause the UI to miss terminal task events.
    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    // Let the reconnect timer fire (scheduleReconnect uses exponential backoff starting at ~800ms).
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    await settleUi(wrapper);

    // The reconnect creates a new ws instance; simulate successful connect.
    expect(lastWs).toBeTruthy();
    lastWs!.onOpen?.();
    await Promise.resolve();
    await settleUi(wrapper);

    expect(((wrapper.vm as any).tasks ?? []).map((t: any) => t.status)).toEqual(["completed"]);
    wrapper.unmount();
  });
});
