import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (url === "/api/models") return [] as T;
      if (url.startsWith("/api/paths/validate")) return { ok: false } as T;
      return {} as T;
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

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

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

describe("mobile navigation shell", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders Advisor and Worker tabs in one shared tab list and switches panels on tab click", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const tablist = wrapper.get('[role="tablist"]');
    const tabs = tablist.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.get(".laneTabLabel").text())).toEqual(["Acopilot", "Actions"]);
    expect(tabs.map((tab) => tab.attributes("aria-selected"))).toEqual(["true", "false"]);
    expect(wrapper.find('[data-testid="lane-tab-tasks"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lane-tab-reviewer"]').exists()).toBe(false);

    // Both lane panels stay mounted; the inactive one is hidden from view.
    expect(wrapper.find('[data-testid="lane-panel-advisor"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lane-panel-worker"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="lane-panel-worker"]').element as HTMLElement).style.display).toBe("none");
    expect((wrapper.find('[data-testid="lane-panel-advisor"]').element as HTMLElement).style.display).toBe("");

    await wrapper.get('[data-testid="lane-tab-worker"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.find('[data-testid="lane-panel-worker"]').element as HTMLElement).style.display).toBe("");
    expect((wrapper.find('[data-testid="lane-panel-advisor"]').element as HTMLElement).style.display).toBe("none");
    expect(wrapper.get('[data-testid="lane-tab-worker"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[data-testid="lane-tab-advisor"]').attributes("aria-selected")).toBe("false");

    await wrapper.get('[data-testid="lane-tab-advisor"]').trigger("click");
    await settleUi(wrapper);

    expect((wrapper.find('[data-testid="lane-panel-advisor"]').element as HTMLElement).style.display).toBe("");
    expect((wrapper.find('[data-testid="lane-panel-worker"]').element as HTMLElement).style.display).toBe("none");

    wrapper.unmount();
  });
});
