import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

const TEST_TIMEOUT_MS = 40_000;

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWorkerWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onTaskEvent?: (payload: unknown) => void;
  onMessage?: (msg: unknown) => void;
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory: () => void;
} | null = null;
let _lastPlannerWs: typeof lastWorkerWs = null;
let _lastReviewerWs: typeof lastWorkerWs = null;

let lastSendPromptPayload: unknown = null;

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
        _lastPlannerWs = this as unknown as typeof lastWorkerWs;
      } else if (chatSessionId === "reviewer") {
        _lastReviewerWs = this as unknown as typeof lastWorkerWs;
      } else {
        lastWorkerWs = this as unknown as typeof lastWorkerWs;
      }
    }

    connect(): void {}
    close(): void {}

    send(): void {}
    sendPrompt(payload: unknown): void {
      lastSendPromptPayload = payload;
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
  if (!lastWorkerWs) {
    await wrapper.vm.connectWs?.();
    await settleUi(wrapper);
  }
  expect(lastWorkerWs).toBeTruthy();
  lastWorkerWs!.onOpen?.();
  await settleUi(wrapper);
}

function makeModel(id: string, displayName: string): ModelConfig {
  return {
    id,
    displayName,
    provider: "openai",
    isEnabled: true,
    isDefault: false,
  };
}

describe("Model selector persistence", () => {
  beforeEach(() => {
    lastWorkerWs = null;
    _lastPlannerWs = null;
    _lastReviewerWs = null;
    lastSendPromptPayload = null;
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }

    const models: ModelConfig[] = [makeModel("gpt-4.1", "GPT-4.1"), makeModel("gpt-4o", "GPT-4o")];
    getImpl = async (url: string) => {
      if (url === "/api/models") return models;
      if (url === "/api/projects") return { projects: [], activeProjectId: null };
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWorkerWs = null;
    _lastPlannerWs = null;
    _lastReviewerWs = null;
    lastSendPromptPayload = null;
    vi.clearAllMocks();
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }
  });

  it(
    "restores a persisted model id and keeps it",
    async () => {
      localStorage.setItem("ads.modelId.default.main", "gpt-4o");

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      wrapper.vm.sendMainPrompt?.("hello");
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({ text: "hello", model: "gpt-4o" });
      expect(localStorage.getItem("ads.modelId.default.main")).toBe("gpt-4o");

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "falls back to the first model and persists it when the stored id is invalid",
    async () => {
      localStorage.setItem("ads.modelId.default.main", "not-a-real-model");

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      wrapper.vm.sendMainPrompt?.("hello");
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({ text: "hello", model: "gpt-4.1" });
      expect(localStorage.getItem("ads.modelId.default.main")).toBe("gpt-4.1");

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "uses backend effective model and persists it when there is no stored selection",
    async () => {
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);
      lastWorkerWs!.onMessage?.({
        type: "welcome",
        threadId: null,
        chatSessionId: "main",
        effectiveModel: "gpt-4.1",
        effectiveModelReasoningEffort: "high",
      });
      await settleUi(wrapper);

      wrapper.vm.sendMainPrompt?.("hello");
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({ text: "hello", model: "gpt-4.1" });
      expect(localStorage.getItem("ads.modelId.default.main")).toBe("gpt-4.1");

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "waits for welcome effective model before replaying a restored pending prompt",
    async () => {
      sessionStorage.setItem(
        "ads.pendingPrompt.default.main",
        JSON.stringify({ clientMessageId: "c-1", text: "hello", createdAt: Date.now() }),
      );

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      expect(lastSendPromptPayload).toBeNull();

      lastWorkerWs!.onMessage?.({
        type: "welcome",
        threadId: null,
        chatSessionId: "main",
        effectiveModel: "gpt-4.1",
        effectiveModelReasoningEffort: "high",
      });
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({
        text: "hello",
        model: "gpt-4.1",
        model_reasoning_effort: "high",
      });

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );
});
