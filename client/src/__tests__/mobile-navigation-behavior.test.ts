import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";

import type { ModelConfig } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let projectsResponse: {
  projects: Array<{ id: string; workspaceRoot: string; name: string; chatSessionId: string }>;
  activeProjectId: string | null;
} = { projects: [], activeProjectId: null };

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

const ModelManagerStub = defineComponent({
  name: "ModelManager",
  props: {
    agent: { type: String, default: null },
    showHeader: { type: Boolean, default: true },
    initialTab: { type: String, default: "models" },
  },
  template:
    '<section data-testid="settings-panel" :data-show-header="showHeader" :data-initial-tab="initialTab"><span class="selected-agent">{{ agent }}</span></section>',
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
    projectsResponse = { projects: [], activeProjectId: null };
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") return projectsResponse;
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
          ModelManager: ModelManagerStub,
          DraggableModal: true,
        },
      },
    });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="mobile-drawer-toggle"]').exists()).toBe(true);
    expect(wrapper.find(".chatShell").exists()).toBe(true);
    expect(wrapper.find(".mobileMainPanel").exists()).toBe(false);
    expect(wrapper.findAll(".laneTab").map((tab) => tab.text())).toEqual(["Advisor", "Worker"]);
    expect(wrapper.find('[data-testid="lane-tab-status-planner"]').classes()).toContain("laneTabStatusDot--connected");
    expect(wrapper.find('[data-testid="lane-tab-status-worker"]').classes()).toContain("laneTabStatusDot--connected");
    expect(wrapper.find('[data-testid="lane-tab-planner"]').classes()).toContain("active");

    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    await wrapper.find('[data-testid="lane-tab-planner"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-panel-planner"]').isVisible()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').isVisible()).toBe(false);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);
    expect(localStorage.getItem("ads.mobileWorkspaceTab.default")).toBe("worker");
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.findAll(".mobileDrawerNavItem")).toHaveLength(2);
    expect(wrapper.findAll(".mobileDrawerNavItem")[0]?.text()).toContain("项目");
    expect(wrapper.findAll(".mobileDrawerNavItem")[1]?.text()).toContain("系统设置");

    await wrapper.find('[data-testid="mobile-drawer-section-settings"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
    expect(wrapper.find(".chatShell").exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-panel"]').exists()).toBe(true);
    expect(wrapper.find(".selected-agent").text()).toBe("");
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-show-header")).toBe("false");
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-initial-tab")).toBe("lane-prompts");

    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-choose-provider"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mobile-context-action-create-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-refresh-models"]').exists()).toBe(true);

    wrapper.unmount();
  }, 40_000);

  it("restores the last tab independently for each project", async () => {
    projectsResponse = {
      projects: [
        { id: "p1", workspaceRoot: "/workspace/project-a", name: "Project A", chatSessionId: "main" },
        { id: "p2", workspaceRoot: "/workspace/project-b", name: "Project B", chatSessionId: "main" },
      ],
      activeProjectId: "p1",
    };
    localStorage.setItem("ads.mobileWorkspaceTab.p1", "worker");
    localStorage.setItem("ads.mobileWorkspaceTab.p2", "planner");

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatView: false,
          ModelManager: ModelManagerStub,
          DraggableModal: true,
        },
      },
    });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="lane-tab-planner"]').classes()).not.toContain("active");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("Project B"));
    expect(projectB).toBeDefined();
    await projectB!.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-tab-planner"]').classes()).toContain("active");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    const projectA = wrapper.findAll("button.projectRow").find((row) => row.text().includes("Project A"));
    expect(projectA).toBeDefined();
    await projectA!.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="lane-tab-planner"]').classes()).not.toContain("active");

    wrapper.unmount();
  }, 40_000);

  it("does not write mobile tab preferences from desktop lane navigation", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: {
        stubs: {
          LoginGate: false,
          MainChatView: false,
          ModelManager: ModelManagerStub,
          DraggableModal: true,
        },
      },
    });
    await settleUi(wrapper);

    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.default")).toBeNull();

    wrapper.unmount();
  }, 40_000);
});
