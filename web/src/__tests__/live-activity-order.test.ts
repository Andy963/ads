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
  onTaskEvent?: (payload: unknown) => void;
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

    connect(): void {}
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
  lastWs!.onOpen?.();
  await settleUi(wrapper);
}

describe("live activity ordering", () => {
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

  it("keeps explored live activity above the assistant stream when the placeholder is dropped", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    // Simulate an early explored event (e.g. VectorSearch(auto) report) arriving before any assistant tokens.
    lastWs!.onMessage?.({
      type: "explored",
      header: true,
      entry: { category: "Search", summary: "VectorSearch(auto) fresh ok=0 code=disabled injected=0 hits=0 filtered=0 chars=0 ms=1 qhash=deadbeef0000" },
    });
    await settleUi(wrapper);

    // Now simulate the first assistant token arriving.
    lastWs!.onMessage?.({ type: "delta", delta: "Hi", source: "chat" });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    const textContents = messages.map((m) => String(m.content ?? ""));

    const activityIdx = textContents.findIndex((t) => t.includes("VectorSearch(auto)"));
    const assistantIdx = messages.findIndex((m) => m.role === "assistant" && m.streaming && String(m.content ?? "").includes("Hi"));

    expect(activityIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(activityIdx).toBeLessThan(assistantIdx);

    wrapper.unmount();
  });

  it("keeps explored live activity above execute blocks", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "explored",
      header: true,
      entry: {
        category: "Search",
        summary: "VectorSearch(auto) fresh status=failed code=query_failed http=400 reason=query failed (400) injected=0 hits=0 filtered=0 chars=0 retry=0 ms=1 qhash=deadbeef0000",
      },
    });
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "command",
      command: {
        id: "cmd-1",
        command: "echo hello",
        outputDelta: "$ echo hello\nhello\n",
      },
    });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    const activityIdx = messages.findIndex((m) => m.id === "live-activity" && String(m.content ?? "").includes("VectorSearch(auto)"));
    const executeIdx = messages.findIndex((m) => m.kind === "execute" && String(m.command ?? "").includes("echo hello"));

    expect(activityIdx).toBeGreaterThanOrEqual(0);
    expect(executeIdx).toBeGreaterThanOrEqual(0);
    expect(activityIdx).toBeLessThan(executeIdx);

    wrapper.unmount();
  });

  it("auto-clears explored live activity after 3 seconds (resets on new events)", async () => {
    vi.useFakeTimers();
    try {
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      // First explored event should show the live activity panel.
      lastWs!.onMessage?.({
        type: "explored",
        header: true,
        entry: { category: "Search", summary: "VectorSearch(auto) first" },
      });
      await settleUi(wrapper);
      expect(String((wrapper.vm as any).messages.map((m: any) => m.id).join(","))).toContain("live-activity");

      // After 1.5 seconds, send another explored event; TTL should reset.
      vi.advanceTimersByTime(1500);
      await settleUi(wrapper);
      lastWs!.onMessage?.({
        type: "explored",
        header: true,
        entry: { category: "Search", summary: "VectorSearch(auto) second" },
      });
      await settleUi(wrapper);

      // 2.999s after the last event: still visible.
      vi.advanceTimersByTime(2999);
      await settleUi(wrapper);
      expect((wrapper.vm as any).messages.some((m: any) => m.id === "live-activity")).toBe(true);

      // 3.000s after the last event: cleared.
      vi.advanceTimersByTime(1);
      await settleUi(wrapper);
      expect((wrapper.vm as any).messages.some((m: any) => m.id === "live-activity")).toBe(false);

      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
