import { defineComponent, nextTick, type PropType } from "vue";
import { shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type StubMessage = { id: string; content: string };

let getImpl: GetImpl | null = null;
const refreshAfterVisibility = vi.fn().mockResolvedValue(undefined);

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(): Promise<T> {
      return {} as T;
    }

    async patch<T>(): Promise<T> {
      return {} as T;
    }

    async delete<T>(): Promise<T> {
      return {} as T;
    }
  }

  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: (event: { code: number; reason?: string }) => void;
    onError?: () => void;
    onMessage?: (message: unknown) => void;

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

    connect(): void {
      queueMicrotask(() => this.onOpen?.());
    }

    close(): void {}
    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => ({
  default: defineComponent({
    name: "LoginGate",
    emits: ["logged-in"],
    mounted() {
      queueMicrotask(() => this.$emit("logged-in", { id: "u-1", username: "admin" }));
    },
    template: "<div />",
  }),
}));

const MainChatViewStub = defineComponent({
  name: "MainChatView",
  props: {
    messages: { type: Array as PropType<StubMessage[]>, default: () => [] },
  },
  setup(_, { expose }) {
    expose({ refreshAfterVisibility });
    return {};
  },
  template: `
    <div class="main-chat-stub">
      <span
        v-for="message in messages"
        :key="message.id"
        class="stub-message"
        :data-message-id="message.id"
      >{{ message.content }}</span>
    </div>
  `,
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await wrapper.vm.$nextTick();
    await nextTick();
    await Promise.resolve();
  }
}

function message(id: string, content: string) {
  return { id, role: "assistant", kind: "text", content };
}

function isPanelDisplayed(panel: { exists: () => boolean; attributes?: (name: string) => string | undefined }): boolean {
  if (!panel.exists()) return false;
  return !String(panel.attributes?.("style") ?? "").includes("display: none");
}

describe("Issue #198 lane conversation switching", () => {
  beforeEach(() => {
    localStorage.clear();
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") {
        return {
          projects: [],
          activeProjectId: null,
        };
      }
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: [] };
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    refreshAfterVisibility.mockClear();
    localStorage.clear();
  });

  it("commits a touch lane switch only on release and ignores a cancelled gesture", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: MainChatViewStub } },
    });
    await settleUi(wrapper);
    const workerTab = wrapper.get('[data-testid="lane-tab-worker"]');
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true };

    await workerTab.trigger("pointerdown", pointer);
    expect(wrapper.get('[data-testid="lane-tab-planner"]').attributes("aria-selected")).toBe("true");
    await workerTab.trigger("pointercancel", pointer);
    await workerTab.trigger("pointerup", pointer);
    expect(workerTab.attributes("aria-selected")).toBe("false");

    await workerTab.trigger("pointerdown", pointer);
    await workerTab.trigger("pointerup", pointer);
    await settleUi(wrapper);
    expect(workerTab.attributes("aria-selected")).toBe("true");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-planner"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("switches the visible conversation and refreshes only the selected lane", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatView: MainChatViewStub,
          ModelManager: true,
          DraggableModal: true,
          SessionResumePicker: true,
        },
      },
    });

    await settleUi(wrapper);

    const plannerRuntime = (wrapper.vm as any).activePlannerRuntime;
    const workerRuntime = (wrapper.vm as any).activeRuntime;
    plannerRuntime.messages.value = [message("planner-1", "Advisor response")];
    workerRuntime.messages.value = [message("worker-1", "Worker response")];
    await settleUi(wrapper);

    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-planner"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-worker"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-planner"]').text()).toContain("Advisor response");

    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);

    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-worker"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-planner"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).toContain("Worker response");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).not.toContain("Advisor response");

    await wrapper.find('[data-testid="lane-tab-planner"]').trigger("click");
    await settleUi(wrapper);

    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-planner"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-worker"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-planner"]').text()).toContain("Advisor response");
    expect(wrapper.find('[data-testid="lane-panel-planner"]').text()).not.toContain("Worker response");

    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-planner"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeChatLane).toBe("worker");
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-worker"]'))).toBe(true);
    expect(isPanelDisplayed(wrapper.find('[data-testid="lane-panel-planner"]'))).toBe(false);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').text()).toContain("Worker response");

    wrapper.unmount();
  });
});
