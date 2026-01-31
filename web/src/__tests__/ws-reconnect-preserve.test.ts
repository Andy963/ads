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

    constructor(_: { sessionId: string; chatSessionId?: string }) {
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
  // bootstrap() is async; keep tests deterministic by forcing a ws connect.
  if (!lastWs) {
    await wrapper.vm.connectWs?.();
    await settleUi(wrapper);
  }
  expect(lastWs).toBeTruthy();
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

describe("WS reconnect preserves UI unless thread_reset", () => {
  beforeEach(() => {
    lastWs = null;
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWs = null;
    vi.clearAllMocks();
  });

  it("does not clear messages on ws close", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    await ensureWsConnected(wrapper);
    (wrapper.vm as any).messages = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    (wrapper.vm as any).activeThreadId = "thread-1";
    await settleUi(wrapper);

    lastWs!.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper);

    expect((wrapper.vm as any).messages.map((m: any) => m.content)).toEqual(["Hello", "World"]);
    expect((wrapper.vm as any).activeThreadId).toBe("thread-1");
    expect(info).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("clears messages and records a thread_reset reason when receiving thread_reset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).messages = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    (wrapper.vm as any).activeThreadId = "thread-1";
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "thread_reset" });
    await settleUi(wrapper);

    const contents = (wrapper.vm as any).messages.map((m: any) => m.content);
    expect(contents.join("\n")).not.toContain("Hello");
    expect(contents.join("\n")).not.toContain("World");
    expect(info).toHaveBeenCalled();
    const args = info.mock.calls.map((c) => c[1]).filter(Boolean);
    expect(args.some((payload: any) => payload?.reason === "thread_reset")).toBe(true);
    wrapper.unmount();
  });

  it("suppresses the clear_history result bubble after user reset", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).messages = [
      { id: "u1", role: "user", kind: "text", content: "Hello" },
      { id: "a1", role: "assistant", kind: "text", content: "World" },
    ];
    await settleUi(wrapper);

    (wrapper.vm as any).clearActiveChat();
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "ignored", kind: "clear_history" });
    await settleUi(wrapper);

    expect((wrapper.vm as any).messages).toHaveLength(0);
    expect(info).toHaveBeenCalled();
    wrapper.unmount();
  });
});
