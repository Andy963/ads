import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";

const TEST_TIMEOUT_MS = 40_000;
const OUTBOX_KEY = "ads.outbox.default.main";

/** The outbox lives in localStorage so a reload in any tab still finds the prompt. */
function seedPendingPrompt(pending: Record<string, unknown>): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify({ pending, queued: [] }));
}

function readOutbox(): string | null {
  return localStorage.getItem(OUTBOX_KEY);
}

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWorkerWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onMessage?: (msg: unknown) => void;
  sendPrompt?: (payload: unknown, clientMessageId?: string) => void;
  clearHistory: () => void;
} | null = null;
let _lastPlannerWs: typeof lastWorkerWs = null;

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
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "planner") {
        _lastPlannerWs = this as unknown as typeof lastWorkerWs;
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

function makeModel(id: string, displayName: string, provider = "openai"): ModelConfig {
  return {
    id,
    displayName,
    provider,
    isEnabled: true,
    isDefault: false,
  };
}

describe("Model selector persistence", () => {
  beforeEach(() => {
    lastWorkerWs = null;
    _lastPlannerWs = null;
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
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWorkerWs = null;
    _lastPlannerWs = null;
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

  it("keeps the centered effort selector scoped to the active lane and outgoing prompt", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    try {
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);
      const controller = wrapper.vm as any;
      controller.setMainModelId("gpt-4.1");
      controller.setPlannerModelId("gpt-4o");
      controller.setMainModelReasoningEffort("medium");
      controller.setPlannerModelReasoningEffort("high");
      await wrapper.get('[data-testid="lane-tab-worker"]').trigger("click");
      await settleUi(wrapper);

      const order = Array.from(wrapper.get(".laneTabGroup").element.children).map((element) => element.getAttribute("data-testid"));
      expect(order).toEqual(["lane-tab-planner", "lane-model-controls", "lane-tab-worker"]);
      const selector = wrapper.findComponent({ name: "MainChatModelSelectors" });
      expect(selector.props("modelReasoningEffort")).toBe("medium");
      selector.vm.$emit("setReasoningEffort", "ultra");
      await settleUi(wrapper);
      controller.sendMainPrompt("Worker prompt");
      await settleUi(wrapper);
      expect(lastSendPromptPayload).toMatchObject({ text: "Worker prompt", model: "gpt-4.1", model_reasoning_effort: "ultra" });

      lastWorkerWs!.onMessage?.({ type: "result", ok: true, output: "Worker done" });
      await wrapper.get('[data-testid="lane-tab-planner"]').trigger("click");
      await settleUi(wrapper);
      expect(_lastPlannerWs).toBeTruthy();
      _lastPlannerWs!.onOpen?.();
      await settleUi(wrapper);
      expect(selector.props("modelReasoningEffort")).toBe("high");
      selector.vm.$emit("setReasoningEffort", "max");
      await settleUi(wrapper);
      controller.sendPlannerPrompt("Advisor prompt");
      await settleUi(wrapper);
      expect(lastSendPromptPayload).toMatchObject({ text: "Advisor prompt", model: "gpt-4o", model_reasoning_effort: "max" });

      await wrapper.get('[data-testid="lane-tab-worker"]').trigger("click");
      await settleUi(wrapper);
      expect(selector.props("modelReasoningEffort")).toBe("ultra");
    } finally {
      wrapper.unmount();
    }
  }, TEST_TIMEOUT_MS);

  it(
    "reloads runtime model options after the model manager changes",
    async () => {
      let runtimeModels: ModelConfig[] = [makeModel("gpt-4.1", "GPT-4.1")];
      let modelFetchCount = 0;
      getImpl = async (url: string) => {
        if (url === "/api/models") {
          modelFetchCount += 1;
          return runtimeModels;
        }
        if (url === "/api/projects") return { projects: [], activeProjectId: null };
        if (url.startsWith("/api/paths/validate")) return { ok: false };
        return {};
      };

      const DraggableModalStub = defineComponent({ template: "<div><slot /></div>" });
      const ModelManagerStub = defineComponent({
        name: "ModelManager",
        emits: ["changed"],
        template: '<button data-testid="model-manager-change" @click="$emit(\'changed\')">change</button>',
      });
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: {
          stubs: {
            LoginGate: false,
            MainChatView: false,
            MarkdownContent: true,
            DraggableModal: DraggableModalStub,
            ModelManager: ModelManagerStub,
          },
        },
      });
      await settleUi(wrapper);

      expect(modelFetchCount).toBeGreaterThanOrEqual(1);
      await wrapper.find('[data-testid="settings-open"]').trigger("click");
      await settleUi(wrapper);

      runtimeModels = [
        makeModel("gpt-4.1", "GPT-4.1"),
        {
          ...makeModel("gpt-5.2", "GPT-5.2"),
          configJson: { allowedAgents: ["codex"] },
        },
      ];
      await wrapper.find('[data-testid="model-manager-change"]').trigger("click");

      await vi.waitFor(() => {
        expect(modelFetchCount).toBeGreaterThanOrEqual(2);
        expect(wrapper.vm.models.map((model: ModelConfig) => model.id)).toContain("gpt-5.2");
      });

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends the selected cross-agent model with its active agent",
    async () => {
      const models: ModelConfig[] = [
        makeModel("gpt-4.1", "GPT-4.1"),
        makeModel("claude-opus-5[1m]", "Claude Opus 5", "anthropic"),
      ];
      getImpl = async (url: string) => {
        if (url === "/api/models") return models;
        if (url === "/api/projects") return { projects: [], activeProjectId: null };
        if (url.startsWith("/api/paths/validate")) return { ok: false };
        return {};
      };

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);
      lastWorkerWs!.onMessage?.({
        type: "agents",
        activeAgentId: "codex",
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude Code", ready: true },
        ],
      });
      await settleUi(wrapper);

      wrapper.vm.switchMainAgent?.("claude");
      wrapper.vm.setMainModelId?.("claude-opus-5[1m]");
      await settleUi(wrapper);

      wrapper.vm.sendMainPrompt?.("hello");
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toMatchObject({
        text: "hello",
        agentId: "claude",
        model: "claude-opus-5[1m]",
      });
      expect(localStorage.getItem("ads.modelId.default.main.claude")).toBe("claude-opus-5[1m]");

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves an unknown stored model instead of replacing it with a fallback",
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
      expect(lastSendPromptPayload).toMatchObject({ text: "hello", model: "not-a-real-model" });
      expect(localStorage.getItem("ads.modelId.default.main")).toBe("not-a-real-model");

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
      seedPendingPrompt({ clientMessageId: "c-1", text: "hello", createdAt: Date.now() });

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

  it(
    "preserves the stored agent id when replaying a restored pending prompt",
    async () => {
      seedPendingPrompt({ clientMessageId: "c-agent", text: "hello", createdAt: Date.now(), agentId: "claude" });

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
        activeAgentId: "codex",
        effectiveModel: "gpt-4.1",
        effectiveModelReasoningEffort: "high",
      });
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({
        text: "hello",
        agentId: "claude",
        model: "gpt-4.1",
      });

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "preserves stored model options when replaying a restored pending prompt",
    async () => {
      seedPendingPrompt({
        clientMessageId: "c-model",
        text: "hello",
        createdAt: Date.now(),
        model: "gpt-4o",
        modelReasoningEffort: "medium",
      });

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

      expect(lastSendPromptPayload).toBeTruthy();
      expect(lastSendPromptPayload).toMatchObject({
        text: "hello",
        model: "gpt-4o",
        model_reasoning_effort: "medium",
      });

      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    [4401, "Unauthorized"],
    [4409, "Max clients reached (increase ADS_WEB_MAX_CLIENTS)"],
  ])(
    "does not replay a pre-ack pending prompt after terminal close code %s",
    async (code) => {
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      wrapper.vm.sendMainPrompt?.("hello");
      await settleUi(wrapper);

      expect(readOutbox()).toContain("\"text\":\"hello\"");
      lastSendPromptPayload = null;

      lastWorkerWs!.onClose?.({ code, reason: "" });
      await settleUi(wrapper);

      expect(readOutbox()).toBeNull();

      await wrapper.vm.connectWs?.();
      await settleUi(wrapper);
      expect(lastWorkerWs).toBeTruthy();

      lastWorkerWs!.onOpen?.();
      await settleUi(wrapper);
      lastWorkerWs!.onMessage?.({
        type: "welcome",
        threadId: null,
        chatSessionId: "main",
        inFlight: false,
        effectiveModel: "gpt-4.1",
        effectiveModelReasoningEffort: "high",
      });
      await settleUi(wrapper);

      expect(lastSendPromptPayload).toBeNull();
      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "applies unsequenced agents snapshot immediately even during sync catch-up buffering",
    async () => {
      let syncResolver: ((val: unknown) => void) | null = null;
      getImpl = async (url: string) => {
        if (url === "/api/models") return [makeModel("gpt-4.1", "GPT-4.1")];
        if (url === "/api/projects") return { projects: [], activeProjectId: null };
        if (url.startsWith("/api/sync/events")) {
          return new Promise((resolve) => {
            syncResolver = resolve;
          });
        }
        return {};
      };

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: { stubs: { LoginGate: false, MainChatView: false, MarkdownContent: true, DraggableModal: true } },
      });
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);

      // Welcome signals cursor gap; sequencer begins catch-up and starts buffering
      lastWorkerWs!.onMessage?.({
        type: "welcome",
        threadId: null,
        chatSessionId: "main",
        latestSeq: 10,
        effectiveModel: "gpt-4.1",
      });
      await settleUi(wrapper);

      // Agents frame arrives during catch-up buffering
      lastWorkerWs!.onMessage?.({
        type: "agents",
        activeAgentId: "codex",
        agents: [
          { id: "codex", name: "Codex", ready: true },
          { id: "claude", name: "Claude Code", ready: true },
        ],
      });
      await settleUi(wrapper);

      // Available agents must be populated immediately without waiting for catch-up HTTP to finish
      expect(wrapper.vm.workerAgents.length).toBe(2);
      expect(wrapper.vm.workerAgents[0].id).toBe("codex");

      if (syncResolver) {
        syncResolver({ events: [], latestSeq: 10, hasMore: false });
      }
      await settleUi(wrapper);
      wrapper.unmount();
    },
    TEST_TIMEOUT_MS,
  );
});
