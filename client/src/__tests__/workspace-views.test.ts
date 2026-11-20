import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}
    async get<T>(url: string): Promise<T> {
      if (url === "/api/models") return [] as T;
      if (url === "/api/projects") return {
        projects: [{ id: "p1", workspaceRoot: "/w/ads", name: "ads", chatSessionId: "main" }],
        activeProjectId: "p1",
      } as T;
      if (url.startsWith("/api/paths/subdirs")) return { dirs: [], allowedDirs: [] } as T;
      if (url.startsWith("/api/paths/validate")) return { ok: false } as T;
      return {} as T;
    }
    async post<T>(): Promise<T> { return {} as T; }
    async patch<T>(): Promise<T> { return {} as T; }
    async delete<T>(): Promise<T> { return {} as T; }
  }
  return { ApiClient };
});

vi.mock("../api/ws", () => {
  class AdsWebSocket {
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    onMessage?: (message: unknown) => void;
    constructor(_: unknown) {}
    connect(): void { queueMicrotask(() => this.onOpen?.()); }
    close(): void {}
    send(): void {}
    sendPrompt(): void {}
    interrupt(): void {}
    clearHistory(): void {}
    cancelPrompt(): void {}
  }
  return {
    AdsWebSocket,
    getProjectWebSocketLane: (options: { lane: "actions" | "acopilot"; sessionId: string }) => new AdsWebSocket(options),
  };
});

vi.mock("../components/LoginGate.vue", () => ({
  default: defineComponent({
    name: "LoginGate",
    emits: ["logged-in"],
    mounted() { queueMicrotask(() => this.$emit("logged-in", { id: "u-1", username: "admin" })); },
    template: "<div />",
  }),
}));

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await wrapper.vm.$nextTick();
    await Promise.resolve();
  }
}

describe("project workspace views", () => {
  let previousInnerWidth: number;

  beforeEach(() => {
    previousInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: previousInnerWidth, configurable: true });
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders PRs as a project data view without lane status, transcript, or model controls", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false, PullRequestsWorkspace: true } } });
    await settleUi(wrapper);

    const tabs = wrapper.findAll('[role="tab"]').map((tab) => tab.attributes("data-testid"));
    expect(tabs).toEqual(["lane-tab-acopilot", "lane-tab-actions", "lane-tab-prs"]);
    expect(wrapper.find('[data-testid="lane-model-controls"]').exists()).toBe(false);

    await wrapper.get('[data-testid="lane-tab-prs"]').trigger("click");
    await settleUi(wrapper);

    expect(wrapper.get(".app").attributes("data-active-workspace-view")).toBe("prs");
    expect(wrapper.find('[data-testid="lane-tab-status-prs"]').exists()).toBe(false);
    expect(wrapper.find('pull-requests-workspace-stub').attributes("projectid")).toBe("p1");
    expect(wrapper.get(".lanePanelsTrack").isVisible()).toBe(false);
    expect(wrapper.find('[data-testid="active-project-context"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-new-session"]').exists()).toBe(false);

    await wrapper.get('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.get(".app").attributes("data-active-workspace-view")).toBe("actions");
    expect(wrapper.get(".lanePanelsTrack").attributes("style") ?? "").not.toContain("display: none");
    expect(wrapper.find('pull-requests-workspace-stub').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lane-new-session"]').exists()).toBe(true);
  });

  it("hides lane session actions from the mobile PR view", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false, PullRequestsWorkspace: true } } });
    await settleUi(wrapper);

    expect(wrapper.find('[data-testid="mobile-context-menu-toggle"]').exists()).toBe(true);
    await wrapper.get('[data-testid="lane-tab-prs"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="mobile-context-menu-toggle"]').exists()).toBe(false);

    await wrapper.get('[data-testid="lane-tab-actions"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="mobile-context-menu-toggle"]').exists()).toBe(true);
  });
});
