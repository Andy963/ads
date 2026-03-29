import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

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

function getLaneTextarea(wrapper: any, lane: "planner" | "worker"): any {
  return wrapper.get(`[data-testid="lane-panel-${lane}"] textarea.composer-input`);
}

async function switchLane(wrapper: any, lane: "planner" | "worker" | "reviewer"): Promise<void> {
  await wrapper.get(`[data-testid="lane-tab-${lane}"]`).trigger("click");
  await settleUi(wrapper);
}

describe("Project and lane composer draft isolation", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "sess-a", path: "/tmp/project-a", name: "A", initialized: true },
        { sessionId: "sess-b", path: "/tmp/project-b", name: "B", initialized: true },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "sess-a");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("preserves lane-local drafts across tab switches without leaking across projects", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, {
      global: { stubs: { LoginGate: false, MainChatView: false, MainChatComposerPanel: false } },
    });
    await settleUi(wrapper);

    const workerTextareaA = getLaneTextarea(wrapper, "worker");
    expect(workerTextareaA.exists()).toBe(true);
    await workerTextareaA.setValue("worker draft text");
    expect((workerTextareaA.element as HTMLTextAreaElement).value).toBe("worker draft text");

    await switchLane(wrapper, "planner");
    const plannerTextareaA = getLaneTextarea(wrapper, "planner");
    await plannerTextareaA.setValue("planner draft line 1\nplanner draft line 2");
    expect((plannerTextareaA.element as HTMLTextAreaElement).value).toBe("planner draft line 1\nplanner draft line 2");

    await switchLane(wrapper, "worker");
    expect((getLaneTextarea(wrapper, "worker").element as HTMLTextAreaElement).value).toBe("worker draft text");

    await switchLane(wrapper, "planner");
    expect((getLaneTextarea(wrapper, "planner").element as HTMLTextAreaElement).value).toBe(
      "planner draft line 1\nplanner draft line 2",
    );

    await switchLane(wrapper, "worker");

    const projectRows = wrapper.findAll("button.projectRow");
    expect(projectRows.length).toBeGreaterThanOrEqual(2);
    const rowB = projectRows.find((row) => row.text().includes("B")) ?? null;
    expect(rowB).toBeTruthy();
    await rowB!.trigger("click");
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("sess-b");

    const workerTextareaB = getLaneTextarea(wrapper, "worker");
    expect(workerTextareaB.exists()).toBe(true);
    expect((workerTextareaB.element as HTMLTextAreaElement).value).toBe("");

    await switchLane(wrapper, "planner");
    expect((getLaneTextarea(wrapper, "planner").element as HTMLTextAreaElement).value).toBe("");

    const rowA = projectRows.find((row) => row.text().includes("A")) ?? null;
    expect(rowA).toBeTruthy();
    await rowA!.trigger("click");
    await settleUi(wrapper);

    await switchLane(wrapper, "worker");
    expect((getLaneTextarea(wrapper, "worker").element as HTMLTextAreaElement).value).toBe("worker draft text");
    await switchLane(wrapper, "planner");
    expect((getLaneTextarea(wrapper, "planner").element as HTMLTextAreaElement).value).toBe(
      "planner draft line 1\nplanner draft line 2",
    );

    wrapper.unmount();
  }, 30_000);
});
