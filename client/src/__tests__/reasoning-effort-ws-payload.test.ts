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
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory: () => void;
} | null = null;
let lastPlannerWs: typeof lastWs = null;
let lastSendPromptPayload: unknown = null;
let lastPlannerSendPromptPayload: unknown = null;

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
      if (chatSessionId === "planner") {
        lastPlannerWs = this as unknown as typeof lastWs;
      } else {
        lastWs = this as unknown as typeof lastWs;
      }
    }

    connect(): void {}
    close(): void {}

    send(): void {}
    sendPrompt(payload: unknown): void {
      if (this === lastPlannerWs) {
        lastPlannerSendPromptPayload = payload;
      } else {
        lastSendPromptPayload = payload;
      }
    }
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

async function ensurePlannerWsConnected(wrapper: any): Promise<void> {
  for (let i = 0; i < 10 && !lastPlannerWs; i += 1) {
    await settleUi(wrapper);
  }
  expect(lastPlannerWs).toBeTruthy();
  lastPlannerWs!.onOpen?.();
  await settleUi(wrapper);
}

describe("reasoning effort WS payload", () => {
  beforeEach(() => {
    lastWs = null;
    lastPlannerWs = null;
    lastSendPromptPayload = null;
    lastPlannerSendPromptPayload = null;
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
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
    lastPlannerWs = null;
    lastSendPromptPayload = null;
    lastPlannerSendPromptPayload = null;
    vi.clearAllMocks();
  });

  it("defaults worker model_reasoning_effort to xhigh", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    wrapper.vm.sendMainPrompt?.("hello");
    await settleUi(wrapper);

    expect(lastSendPromptPayload).toBeTruthy();
    expect(lastSendPromptPayload).toMatchObject({ text: "hello", model_reasoning_effort: "xhigh" });
  });

  it("keeps planner default model_reasoning_effort at high", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);
    await ensurePlannerWsConnected(wrapper);

    wrapper.vm.sendPlannerPrompt?.("hello");
    await settleUi(wrapper);

    expect(lastPlannerSendPromptPayload).toBeTruthy();
    expect(lastPlannerSendPromptPayload).toMatchObject({ text: "hello", model_reasoning_effort: "high" });
  });

  it("restores persisted reasoning effort and overrides defaults", async () => {
    try {
      localStorage.setItem("ads.reasoningEffort.default.main", "medium");
    } catch {
      // ignore
    }

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    wrapper.vm.sendMainPrompt?.("hello");
    await settleUi(wrapper);

    expect(lastSendPromptPayload).toBeTruthy();
    expect(lastSendPromptPayload).toMatchObject({ text: "hello", model_reasoning_effort: "medium" });
  });

  it("includes model_reasoning_effort on prompt payload", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    wrapper.vm.setMainModelReasoningEffort?.("xhigh");
    await settleUi(wrapper);

    wrapper.vm.sendMainPrompt?.("hello");
    await settleUi(wrapper);

    expect(lastSendPromptPayload).toBeTruthy();
    expect(lastSendPromptPayload).toMatchObject({ text: "hello", model_reasoning_effort: "xhigh" });
  });
});
