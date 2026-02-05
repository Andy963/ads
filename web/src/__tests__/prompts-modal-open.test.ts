import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let getCalls: string[] = [];
let lastWs: {
  onOpen?: () => void;
  connect: () => void;
} | null = null;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      getCalls.push(url);
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

    constructor(_: { sessionId: string; chatSessionId?: string }) {
      lastWs = this as unknown as typeof lastWs;
    }

    connect(): void {
      // noop
    }

    close(): void {}

    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
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

describe("Prompt Library modal entry", () => {
  beforeEach(() => {
    getCalls = [];
    lastWs = null;
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      if (url === "/api/prompts") return { prompts: [] };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWs = null;
    vi.clearAllMocks();
  });

  it("opens a modal and fetches prompts when clicking the gear button", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    if (!lastWs) {
      await (wrapper.vm as any).connectWs?.();
      await settleUi(wrapper);
    }

    const btn = wrapper.find('[data-testid="prompts-button"]');
    expect(btn.exists()).toBe(true);

    await btn.trigger("click");
    await settleUi(wrapper);

    expect(getCalls.some((u) => u === "/api/prompts")).toBe(true);
    expect(wrapper.find('[data-testid="prompts-modal"]').exists()).toBe(true);

    wrapper.unmount();
  });
});

