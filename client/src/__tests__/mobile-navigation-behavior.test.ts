import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;

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
    onClose?: (ev: { code: number; reason?: string }) => void;
    onError?: () => void;
    onTaskEvent?: (payload: unknown) => void;
    onMessage?: (msg: unknown) => void;

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
      void nextTick(() => {
        this.$emit("logged-in", { id: "u-1", username: "admin" });
      });
    },
    template: "<div />",
  }),
}));

const RuleManagerStub = defineComponent({
  name: "GlobalRuleManager",
  props: {
    showHeader: { type: Boolean, default: true },
  },
  template: '<section data-testid="global-rule-manager" :data-show-header="showHeader" />',
  setup(_, { expose }) {
    expose({ create: vi.fn(), refresh: vi.fn() });
    return {};
  },
});

const ModelManagerStub = defineComponent({
  name: "ModelManager",
  props: {
    agent: { type: String, default: null },
    showHeader: { type: Boolean, default: true },
  },
  template:
    '<section data-testid="model-manager" :data-show-header="showHeader"><span class="selected-agent">{{ agent }}</span></section>',
  setup(_, { expose }) {
    expose({ create: vi.fn(), refresh: vi.fn() });
    return {};
  },
});

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await wrapper.vm.$nextTick();
    await Promise.resolve();
  }
}

describe("mobile navigation behavior", () => {
  let previousInnerWidth: number;

  beforeEach(() => {
    previousInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    localStorage.clear();
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") return { projects: [], activeProjectId: null };
      if (url.includes("/api/task-queue/status")) {
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: [] };
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { value: previousInnerWidth, configurable: true });
    vi.clearAllMocks();
  });

  it("switches the main area and contextual actions across mobile modules", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatView: false,
          GlobalRuleManager: RuleManagerStub,
          ModelManager: ModelManagerStub,
          DraggableModal: true,
        },
      },
    });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="mobile-drawer-toggle"]').exists()).toBe(true);
    expect(wrapper.find(".chatShell").exists()).toBe(true);
    expect(wrapper.find(".mobileMainPanel").exists()).toBe(false);

    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-create-task"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-create-rule"]').exists()).toBe(false);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.findAll(".mobileDrawerNavItem")).toHaveLength(3);
    expect(wrapper.findAll(".mobileDrawerNavItem")[0]?.text()).toContain("项目");
    expect(wrapper.findAll(".mobileDrawerNavItem")[1]?.text()).toContain("Rule");
    expect(wrapper.findAll(".mobileDrawerNavItem")[2]?.text()).toContain("Provider");

    await wrapper.find('[data-testid="mobile-drawer-section-rules"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
    expect(wrapper.find(".chatShell").exists()).toBe(false);
    expect(wrapper.find(".mobileMainPanel").exists()).toBe(true);
    expect(wrapper.find('[data-testid="global-rule-manager"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="global-rule-manager"]').attributes("data-show-header")).toBe("false");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await wrapper.find('[data-testid="mobile-drawer-section-models"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.findAll(".mobileDrawerSubitem")).toHaveLength(3);
    expect(wrapper.findAll(".mobileDrawerSubitemArrow")).toHaveLength(0);
    expect(wrapper.find(".mobileModuleEmpty").exists()).toBe(true);

    await wrapper.find('[data-testid="mobile-drawer-model-claude"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
    expect(wrapper.find(".chatShell").exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-manager"]').exists()).toBe(true);
    expect(wrapper.find(".selected-agent").text()).toBe("claude");
    expect(wrapper.find('[data-testid="model-manager"]').attributes("data-show-header")).toBe("false");

    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-choose-provider"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-create-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-refresh-models"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-create-rule"]').exists()).toBe(false);

    wrapper.unmount();
  }, 40_000);
});
