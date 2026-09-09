import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";

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

    constructor(_: { sessionId: string; chatSessionId?: string }) {}

    connect(): void {}
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

describe("project status spinner", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    vi.clearAllMocks();
  });

  it("shows lane-specific and combined project activity states", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const pid = String((wrapper.vm as any).activeProjectId ?? "").trim();
    expect(pid).not.toBe("");

    const workerRuntime = (wrapper.vm as any).getRuntime(pid) as { busy: { value: boolean } };
    const plannerRuntime = (wrapper.vm as any).getPlannerRuntime(pid) as { busy: { value: boolean } };
    workerRuntime.busy.value = false;
    plannerRuntime.busy.value = false;
    await settleUi(wrapper);

    expect(wrapper.find(".projectStatus").classes("spinning")).toBe(false);
    expect(wrapper.find(".laneTabBusySpinner").exists()).toBe(false);

    plannerRuntime.busy.value = true;
    await settleUi(wrapper);
    const projectStatus = wrapper.find(".projectStatus");
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--advisor"]));
    expect(projectStatus.attributes("title")).toBe("Advisor 正在规划…");
    expect(wrapper.find('[data-testid="lane-tab-busy-planner"]').classes()).toEqual(
      expect.arrayContaining(["laneTabBusySpinner", "laneTabBusySpinner--advisor"]),
    );
    expect(wrapper.find('[data-testid="lane-tab-busy-worker"]').exists()).toBe(false);

    workerRuntime.busy.value = true;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--both"]));
    expect(projectStatus.attributes("title")).toBe("Advisor 与 Worker 均在运行中…");
    expect(wrapper.find('[data-testid="lane-tab-busy-worker"]').classes()).toEqual(
      expect.arrayContaining(["laneTabBusySpinner", "laneTabBusySpinner--worker"]),
    );

    plannerRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes()).toEqual(expect.arrayContaining(["spinning", "spinning--worker"]));
    expect(projectStatus.classes("spinning--advisor")).toBe(false);
    expect(projectStatus.attributes("title")).toBe("Worker 正在执行…");

    workerRuntime.busy.value = false;
    await settleUi(wrapper);
    expect(projectStatus.classes("spinning")).toBe(false);
    expect(projectStatus.attributes("title")).toBeUndefined();

    wrapper.unmount();
  });
});
