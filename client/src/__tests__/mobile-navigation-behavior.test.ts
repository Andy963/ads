import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";

import type { ModelConfig } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

function readStoredMobileTab(projectId: string): string | null {
  const raw = localStorage.getItem(`ads.prefs.${projectId}`);
  if (!raw) return null;
  const prefs = JSON.parse(raw) as { mobileTab?: string };
  return prefs.mobileTab ?? null;
}

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
    showTabs: { type: Boolean, default: true },
    initialTab: { type: String, default: "models" },
  },
  template:
    '<section data-testid="settings-panel" :data-show-header="showHeader" :data-show-tabs="showTabs" :data-initial-tab="initialTab"><span class="selected-agent">{{ agent }}</span></section>',
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

  it("activates a menu tap once without starting a topbar edge swipe (Issue #236)", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false, ModelManager: ModelManagerStub } } });
    await settleUi(wrapper);
    const button = wrapper.get('[data-testid="mobile-drawer-toggle"]');
    await button.get("rect").trigger("touchstart", { touches: [{ clientX: 12, clientY: 20 }] });
    await wrapper.get(".app").trigger("touchmove", { touches: [{ clientX: 70, clientY: 20 }] });
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
    await wrapper.get(".app").trigger("touchend", { touches: [] });

    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 20 });
      Object.defineProperties(event, {
        pointerType: { value: "touch" }, pointerId: { value: 1 }, isPrimary: { value: true },
      });
      button.element.dispatchEvent(event);
      await nextTick();
    }
    expect(wrapper.find(".mobileDrawer").exists()).toBe(true);
    button.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    await nextTick();
    expect(wrapper.find(".mobileDrawer").exists()).toBe(true);
    button.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    await nextTick();
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);

    await wrapper.get(".app").trigger("touchstart", { touches: [{ clientX: 5, clientY: 200 }] });
    await wrapper.get(".app").trigger("touchmove", { touches: [{ clientX: 60, clientY: 200 }] });
    expect(wrapper.find(".mobileDrawer").exists()).toBe(true);
    wrapper.unmount();
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
    expect(wrapper.find('[data-testid="lane-tab-status-advisor"]').classes()).toContain("laneTabStatusDot--connected");
    expect(wrapper.find('[data-testid="lane-tab-status-worker"]').classes()).toContain("laneTabStatusDot--connected");
    expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");

    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    await wrapper.find('[data-testid="lane-tab-advisor"]').trigger("click");
    await settleUi(wrapper);
    // Both lane panels stay mounted; only the inactive one is marked hidden.
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').classes()).not.toContain("lanePanel--inactive");
    expect(wrapper.find('[data-testid="lane-panel-worker"]').classes()).toContain("lanePanel--inactive");
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);
    expect(readStoredMobileTab("default")).toBe("actions");
    expect(localStorage.getItem("ads.mobileWorkspaceTab.default")).toBeNull();
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mobile-context-action-resume"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mobile-context-action-new-session"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.findAll(".mobileDrawerNavItem")).toHaveLength(3);
    expect(wrapper.findAll(".mobileDrawerNavItem")[0]?.text()).toContain("项目");
    expect(wrapper.findAll(".mobileDrawerNavItem")[1]?.text()).toContain("角色指令");
    expect(wrapper.findAll(".mobileDrawerNavItem")[2]?.text()).toContain("模型配置");

    await wrapper.find('[data-testid="mobile-drawer-section-prompts"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
    expect(wrapper.find(".chatShell").exists()).toBe(false);
    expect(wrapper.find('[data-testid="settings-panel"]').exists()).toBe(true);
    expect(wrapper.find(".selected-agent").text()).toBe("");
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-show-header")).toBe("false");
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-show-tabs")).toBe("false");
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-initial-tab")).toBe("lane-prompts");
    // Role prompts expose no contextual actions, so the menu button hides.
    expect(wrapper.find('[data-testid="mobile-context-menu-toggle"]').exists()).toBe(false);

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    await wrapper.find('[data-testid="mobile-drawer-section-models"]').trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="settings-panel"]').attributes("data-initial-tab")).toBe("models");

    // Settings views expose no duplicate contextual actions, so the menu button stays hidden.
    expect(wrapper.find('[data-testid="mobile-context-menu-toggle"]').exists()).toBe(false);

    wrapper.unmount();
  }, 40_000);

  it("keeps disabled context actions compact and hint-free", async () => {
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

    const advisorRuntime = (wrapper.vm as any).activeAdvisorRuntime as {
      busy: { value: boolean };
      connected: { value: boolean };
    };
    advisorRuntime.busy.value = true;
    await settleUi(wrapper);
    await wrapper.find('[data-testid="mobile-context-menu-toggle"]').trigger("click");

    const menu = wrapper.find('[data-testid="mobile-context-menu"]');
    const actions = menu.findAll("button.mobileContextAction");
    expect(menu.attributes("aria-label")).toBe("项目操作");
    expect(menu.find(".mobileContextMenuTitle").exists()).toBe(false);
    expect(menu.findAll(".mobileContextActionHint")).toHaveLength(0);
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => (action.element as HTMLButtonElement).disabled)).toBe(true);

    advisorRuntime.busy.value = false;
    advisorRuntime.connected.value = false;
    await settleUi(wrapper);
    expect((menu.find('[data-testid="mobile-context-action-resume"]').element as HTMLButtonElement).disabled).toBe(false);
    expect((menu.find('[data-testid="mobile-context-action-new-session"]').element as HTMLButtonElement).disabled).toBe(true);
    expect(menu.findAll(".mobileContextActionHint")).toHaveLength(0);

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
    localStorage.setItem("ads.mobileWorkspaceTab.p2", "advisor");

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
    expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).not.toContain("active");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    const projectB = wrapper.findAll("button.projectRow").find((row) => row.text().includes("Project B"));
    expect(projectB).toBeDefined();
    await projectB!.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");

    await wrapper.find('[data-testid="mobile-drawer-toggle"]').trigger("click");
    await settleUi(wrapper);
    const projectA = wrapper.findAll("button.projectRow").find((row) => row.text().includes("Project A"));
    expect(projectA).toBeDefined();
    await projectA!.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
    expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).not.toContain("active");

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

  describe("horizontal lane swipe (Issue #292, carousel in #309)", () => {
    async function mountMobileChat() {
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: {
          stubs: {
            LoginGate: false,
            ModelManager: ModelManagerStub,
            DraggableModal: true,
          },
        },
      });
      await settleUi(wrapper);
      return wrapper;
    }

    function dispatchTouch(
      el: Element,
      type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
      point: { clientX: number; clientY: number } | null,
      timeStamp: number,
    ): void {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches: point ? [point] : [] });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      el.dispatchEvent(event);
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    async function waitForSnap(): Promise<void> {
      // 340ms lane settle timer, with margin.
      await sleep(480);
    }

    it("tracks the panels 1:1 during a swipe and snaps to Worker on release", async () => {
      const wrapper = await mountMobileChat();
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");

      const panels = wrapper.get(".lanePanels").element;
      dispatchTouch(panels, "touchstart", { clientX: 220, clientY: 320 }, 1000);
      dispatchTouch(panels, "touchmove", { clientX: 150, clientY: 320 }, 1020);
      await settleUi(wrapper);

      const track = wrapper.get(".lanePanelsTrack");
      expect((track.element as HTMLElement).style.transform).toBe("translate3d(-70px, 0, 0)");
      expect(track.classes()).toContain("lanePanelsTrack--dragging");
      // Both panels stay mounted mid-drag, so no blank gap shows between them.
      expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="lane-panel-worker"]').exists()).toBe(true);

      dispatchTouch(panels, "touchmove", { clientX: 60, clientY: 320 }, 1040);
      await settleUi(wrapper);
      expect((track.element as HTMLElement).style.transform).toBe("translate3d(-160px, 0, 0)");

      dispatchTouch(panels, "touchend", null, 1050);
      await waitForSnap();
      await settleUi(wrapper);

      expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
      expect(wrapper.get(".lanePanelsTrack").classes()).toContain("lanePanelsTrack--worker");
      expect(wrapper.get(".lanePanelsTrack").classes()).not.toContain("lanePanelsTrack--dragging");
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      const advisorPanel = wrapper.get('[data-testid="lane-panel-advisor"]');
      expect(advisorPanel.classes()).toContain("lanePanel--inactive");
      expect(advisorPanel.attributes("aria-hidden")).toBe("true");
      expect(advisorPanel.attributes("inert")).toBeDefined();
      const workerPanel = wrapper.get('[data-testid="lane-panel-worker"]');
      expect(workerPanel.classes()).not.toContain("lanePanel--inactive");
      expect(workerPanel.attributes("aria-hidden")).toBeUndefined();
      expect(workerPanel.attributes("inert")).toBeUndefined();
      expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
      expect(readStoredMobileTab("default")).toBe("actions");
      wrapper.unmount();
    });

    it("springs back to the current lane below the distance threshold", async () => {
      const wrapper = await mountMobileChat();
      const panels = wrapper.get(".lanePanels").element;

      dispatchTouch(panels, "touchstart", { clientX: 220, clientY: 320 }, 1000);
      dispatchTouch(panels, "touchmove", { clientX: 120, clientY: 320 }, 1500);
      await settleUi(wrapper);
      // 100px = 25.6% of the 390px viewport; release velocity is no flick.
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("translate3d(-100px, 0, 0)");

      dispatchTouch(panels, "touchend", null, 1600);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.get(".lanePanelsTrack").classes()).not.toContain("lanePanelsTrack--worker");
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      expect(readStoredMobileTab("default")).toBeNull();
      wrapper.unmount();
    });

    it("switches lanes on a fast flick below the distance threshold", async () => {
      const wrapper = await mountMobileChat();
      const panels = wrapper.get(".lanePanels").element;

      dispatchTouch(panels, "touchstart", { clientX: 220, clientY: 320 }, 1000);
      dispatchTouch(panels, "touchmove", { clientX: 160, clientY: 320 }, 1040);
      // 60px = 15.4% but -60px/40ms = -1.5px/ms is a flick.
      dispatchTouch(panels, "touchend", null, 1050);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
      expect(wrapper.get(".lanePanelsTrack").classes()).toContain("lanePanelsTrack--worker");
      wrapper.unmount();
    });

    it("cancelling the touch springs back to the current lane", async () => {
      const wrapper = await mountMobileChat();
      const panels = wrapper.get(".lanePanels").element;

      dispatchTouch(panels, "touchstart", { clientX: 220, clientY: 320 }, 1000);
      dispatchTouch(panels, "touchmove", { clientX: 60, clientY: 320 }, 1040);
      await settleUi(wrapper);
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("translate3d(-160px, 0, 0)");

      dispatchTouch(panels, "touchcancel", null, 1050);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      wrapper.unmount();
    });

    it("switches from Worker back to Advisor on a rightward drag", async () => {
      const wrapper = await mountMobileChat();
      await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-worker"]').classes()).toContain("active");
      expect(wrapper.get(".lanePanelsTrack").classes()).toContain("lanePanelsTrack--worker");

      const panels = wrapper.get(".lanePanels").element;
      dispatchTouch(panels, "touchstart", { clientX: 180, clientY: 300 }, 1000);
      dispatchTouch(panels, "touchmove", { clientX: 340, clientY: 300 }, 1400);
      await settleUi(wrapper);
      // Base position is -390px (worker); +160px of drag leaves -230px.
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("translate3d(-230px, 0, 0)");

      dispatchTouch(panels, "touchend", null, 1500);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.get(".lanePanelsTrack").classes()).not.toContain("lanePanelsTrack--worker");
      expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
      wrapper.unmount();
    });

    it("keeps both lane panels mounted with identical DOM elements across switches", async () => {
      const wrapper = await mountMobileChat();
      const advisorEl = wrapper.get('[data-testid="lane-panel-advisor"]').element;
      const workerEl = wrapper.get('[data-testid="lane-panel-worker"]').element;

      await wrapper.find('[data-testid="lane-tab-worker"]').trigger("click");
      await settleUi(wrapper);
      expect(wrapper.get('[data-testid="lane-panel-advisor"]').element).toBe(advisorEl);
      expect(wrapper.get('[data-testid="lane-panel-worker"]').element).toBe(workerEl);
      expect(wrapper.get('[data-testid="lane-panel-advisor"]').attributes("aria-hidden")).toBe("true");

      await wrapper.find('[data-testid="lane-tab-advisor"]').trigger("click");
      await settleUi(wrapper);
      expect(wrapper.get('[data-testid="lane-panel-advisor"]').element).toBe(advisorEl);
      expect(wrapper.get('[data-testid="lane-panel-worker"]').element).toBe(workerEl);
      expect(wrapper.get('[data-testid="lane-panel-worker"]').attributes("aria-hidden")).toBe("true");
      wrapper.unmount();
    });

    it("keeps the left-edge gesture on the drawer and never switches lanes", async () => {
      const wrapper = await mountMobileChat();
      const panels = wrapper.get(".lanePanels");
      await panels.trigger("touchstart", { touches: [{ clientX: 12, clientY: 320 }] });
      await panels.trigger("touchmove", { touches: [{ clientX: 90, clientY: 320 }] });
      await settleUi(wrapper);

      expect(wrapper.find(".mobileDrawer").exists()).toBe(true);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      await panels.trigger("touchend", { touches: [] });
      wrapper.unmount();
    });

    it("ignores vertical scrolling and near-vertical drags", async () => {
      const wrapper = await mountMobileChat();
      const panels = wrapper.get(".lanePanels");

      await panels.trigger("touchstart", { touches: [{ clientX: 200, clientY: 200 }] });
      await panels.trigger("touchmove", { touches: [{ clientX: 206, clientY: 320 }] });
      await panels.trigger("touchend", { touches: [] });
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.find(".mobileDrawer").exists()).toBe(false);

      // |dx| above the lock threshold but failing the horizontal ratio gate.
      await panels.trigger("touchstart", { touches: [{ clientX: 200, clientY: 200 }] });
      await panels.trigger("touchmove", { touches: [{ clientX: 250, clientY: 260 }] });
      await panels.trigger("touchend", { touches: [] });
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      wrapper.unmount();
    });

    it("ignores swipes starting inside horizontally scrollable or editable children", async () => {
      const wrapper = await mountMobileChat();
      const panelsEl = wrapper.get(".lanePanels").element;
      const pre = document.createElement("pre");
      panelsEl.appendChild(pre);

      const start = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.assign(start, { touches: [{ clientX: 240, clientY: 300 }] });
      pre.dispatchEvent(start);
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.assign(move, { touches: [{ clientX: 140, clientY: 300 }] });
      pre.dispatchEvent(move);
      await settleUi(wrapper);

      expect(wrapper.find('[data-testid="lane-tab-advisor"]').classes()).toContain("active");
      expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
      expect(wrapper.find(".mobileDrawer").exists()).toBe(false);
      expect((wrapper.get(".lanePanelsTrack").element as HTMLElement).style.transform).toBe("");
      pre.remove();
      wrapper.unmount();
    });
  });

  describe("interactive drawer gesture (Issue #308)", () => {
    async function mountMobileChat() {
      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, {
        global: {
          stubs: {
            LoginGate: false,
            ModelManager: ModelManagerStub,
            DraggableModal: true,
          },
        },
      });
      await settleUi(wrapper);
      return wrapper;
    }

    type Wrapper = Awaited<ReturnType<typeof mountMobileChat>>;

    function dispatchTouch(
      el: Element,
      type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
      point: { clientX: number; clientY: number } | null,
      timeStamp: number,
    ): void {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches: point ? [point] : [] });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      el.dispatchEvent(event);
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    // .left.mobileDrawer resolves to min(360px, 84vw, 100vw - 24px) = 327.6px at 390px.
    const DRAWER_WIDTH = 327.6;

    function drawerTranslateX(wrapper: Wrapper): number | null {
      const drawer = wrapper.find('[data-testid="mobile-drawer"]');
      if (!drawer.exists()) return null;
      const transform = (drawer.element as HTMLElement).style.transform;
      const match = /translateX\((-?[\d.]+)px\)/.exec(transform);
      return match?.[1] !== undefined ? Number(match[1]) : null;
    }

    function backdropOpacity(wrapper: Wrapper): number | null {
      const backdrop = wrapper.find('[data-testid="mobile-drawer-backdrop"]');
      if (!backdrop.exists()) return null;
      const opacity = (backdrop.element as HTMLElement).style.opacity;
      return opacity === "" ? null : Number(opacity);
    }

    async function waitForSnap(): Promise<void> {
      // 340ms settle timer + 60ms cleanup timer, with margin.
      await sleep(480);
    }

    it("tracks the finger 1:1 with the transition disabled", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 110, clientY: 300 }, 1020);
      await settleUi(wrapper);

      const drawer = wrapper.get('[data-testid="mobile-drawer"]');
      expect(drawerTranslateX(wrapper)).toBeCloseTo(100 - DRAWER_WIDTH, 1);
      expect((drawer.element as HTMLElement).style.transition).toBe("none");
      expect(backdropOpacity(wrapper)).toBeCloseTo(100 / DRAWER_WIDTH, 3);

      dispatchTouch(app, "touchmove", { clientX: 60, clientY: 300 }, 1040);
      await settleUi(wrapper);
      expect(drawerTranslateX(wrapper)).toBeCloseTo(50 - DRAWER_WIDTH, 1);
      expect(backdropOpacity(wrapper)).toBeCloseTo(50 / DRAWER_WIDTH, 3);

      // touchcancel springs back to the pre-drag (closed) state.
      dispatchTouch(app, "touchcancel", null, 1050);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="mobile-drawer-backdrop"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("springs back closed when released below the distance threshold", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 100, clientY: 300 }, 1400);
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(true);

      // 90px = 27.5% of the drawer; release velocity 90/400 = 0.225px/ms is no flick.
      dispatchTouch(app, "touchend", null, 1500);
      // The drawer stays mounted while the snap-back animation runs.
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(true);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="mobile-drawer-backdrop"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="mobile-drawer-toggle"]').attributes("aria-expanded")).toBe("false");
      wrapper.unmount();
    });

    it("snaps open past 35% of the drawer width and cleans up inline styles", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 180, clientY: 300 }, 1400);
      // 170px = 51.9%; release velocity 170/400 = 0.425px/ms is no flick.
      dispatchTouch(app, "touchend", null, 1500);
      await waitForSnap();
      await settleUi(wrapper);

      const drawer = wrapper.get('[data-testid="mobile-drawer"]');
      expect(drawer.exists()).toBe(true);
      expect((drawer.element as HTMLElement).style.transform).toBe("");
      expect((drawer.element as HTMLElement).style.transition).toBe("");
      expect(wrapper.get('[data-testid="mobile-drawer-toggle"]').attributes("aria-expanded")).toBe("true");
      const backdrop = wrapper.get('[data-testid="mobile-drawer-backdrop"]');
      expect((backdrop.element as HTMLElement).style.opacity).toBe("");

      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("snaps open at exactly 35% of the drawer width", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;
      const dragDistance = DRAWER_WIDTH * 0.35;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 10 + dragDistance, clientY: 300 }, 1400);
      dispatchTouch(app, "touchend", null, 1500);
      await waitForSnap();
      await settleUi(wrapper);

      expect(wrapper.get('[data-testid="mobile-drawer-toggle"]').attributes("aria-expanded")).toBe("true");
      wrapper.unmount();
    });

    it("snaps open on a fast flick even below the distance threshold", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 50, clientY: 300 }, 1040);
      // 40px = 12.2% but 40px/40ms = 1px/ms is a flick.
      dispatchTouch(app, "touchend", null, 1050);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(true);
      wrapper.unmount();
    });

    it("snaps closed on a reverse flick even past the distance threshold", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 300 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 180, clientY: 300 }, 1400);
      dispatchTouch(app, "touchmove", { clientX: 170, clientY: 300 }, 1410);
      // 52.4% open but the trailing velocity is -10px/10ms = -1px/ms.
      dispatchTouch(app, "touchend", null, 1420);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("yields to vertical scrolling and never starts tracking", async () => {
      const wrapper = await mountMobileChat();
      const app = wrapper.get(".app").element;

      dispatchTouch(app, "touchstart", { clientX: 10, clientY: 200 }, 1000);
      dispatchTouch(app, "touchmove", { clientX: 16, clientY: 260 }, 1020);
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);

      // The cancelled session must not pick the gesture up again later.
      dispatchTouch(app, "touchmove", { clientX: 120, clientY: 262 }, 1040);
      dispatchTouch(app, "touchend", null, 1050);
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("tracks a close drag on the drawer and springs back open", async () => {
      const wrapper = await mountMobileChat();
      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);
      const drawerEl = wrapper.get('[data-testid="mobile-drawer"]').element;

      dispatchTouch(drawerEl, "touchstart", { clientX: 300, clientY: 400 }, 2000);
      dispatchTouch(drawerEl, "touchmove", { clientX: 200, clientY: 400 }, 2400);
      await settleUi(wrapper);
      expect(drawerTranslateX(wrapper)).toBeCloseTo(-100, 1);
      expect(backdropOpacity(wrapper)).toBeCloseTo(1 - 100 / DRAWER_WIDTH, 3);

      // 30.5% closed; trailing velocity -100px/400ms = -0.25px/ms is no flick.
      dispatchTouch(drawerEl, "touchend", null, 2500);
      await waitForSnap();
      await settleUi(wrapper);
      const drawer = wrapper.get('[data-testid="mobile-drawer"]');
      expect(drawer.exists()).toBe(true);
      expect((drawer.element as HTMLElement).style.transform).toBe("");
      wrapper.unmount();
    });

    it("snaps shut on a slow close drag past the threshold", async () => {
      const wrapper = await mountMobileChat();
      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);
      const drawerEl = wrapper.get('[data-testid="mobile-drawer"]').element;

      dispatchTouch(drawerEl, "touchstart", { clientX: 300, clientY: 400 }, 3000);
      dispatchTouch(drawerEl, "touchmove", { clientX: 80, clientY: 400 }, 3800);
      // 32.8% still open; trailing velocity -220px/800ms = -0.275px/ms is no flick.
      dispatchTouch(drawerEl, "touchend", null, 3900);
      await waitForSnap();
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="mobile-drawer-toggle"]').attributes("aria-expanded")).toBe("false");
      wrapper.unmount();
    });

    it("snaps shut after a 40% close drag", async () => {
      const wrapper = await mountMobileChat();
      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);
      const drawerEl = wrapper.get('[data-testid="mobile-drawer"]').element;
      const dragDistance = DRAWER_WIDTH * 0.4;

      dispatchTouch(drawerEl, "touchstart", { clientX: 300, clientY: 400 }, 3000);
      dispatchTouch(drawerEl, "touchmove", { clientX: 300 - dragDistance, clientY: 400 }, 3400);
      dispatchTouch(drawerEl, "touchend", null, 3500);
      await waitForSnap();
      await settleUi(wrapper);

      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="mobile-drawer-toggle"]').attributes("aria-expanded")).toBe("false");
      wrapper.unmount();
    });

    it("keeps the menu button path on the CSS transition without inline styles", async () => {
      const wrapper = await mountMobileChat();
      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);

      const drawer = wrapper.get('[data-testid="mobile-drawer"]');
      expect(drawer.exists()).toBe(true);
      expect((drawer.element as HTMLElement).style.transform).toBe("");
      expect((drawer.element as HTMLElement).style.transition).toBe("");
      const backdrop = wrapper.get('[data-testid="mobile-drawer-backdrop"]');
      expect((backdrop.element as HTMLElement).style.opacity).toBe("");

      await wrapper.get('[data-testid="mobile-drawer-toggle"]').trigger("click");
      await settleUi(wrapper);
      expect(wrapper.find('[data-testid="mobile-drawer"]').exists()).toBe(false);
      wrapper.unmount();
    });
  });
});
