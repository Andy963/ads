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

describe("App brand version display", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the app version in the drawer footer and keeps it out of the topbar", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const drawer = wrapper.get('[data-testid="mobile-drawer"]');
    const footer = drawer.get('[data-testid="drawer-footer"]');
    expect(footer.get(".drawerBrandTitle").text()).toBe("ADS");
    expect(footer.get(".drawerBrandVersion").text()).toBe("v0.0.1");

    const topbar = wrapper.get("header.topbar");
    expect(topbar.find(".brand").exists()).toBe(false);
    expect(topbar.text()).not.toContain("0.0.1");

    wrapper.unmount();
  });
});
