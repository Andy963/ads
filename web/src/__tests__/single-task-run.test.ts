import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskDetail, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;
type PostImpl = (url: string, body: unknown) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let postImpl: PostImpl | null = null;

vi.mock("../api/client", () => {
  class ApiClient {
    constructor(_: { baseUrl: string }) {}

    async get<T>(url: string): Promise<T> {
      if (!getImpl) throw new Error("getImpl not set");
      return (await getImpl(url)) as T;
    }

    async post<T>(url: string, body: unknown): Promise<T> {
      if (!postImpl) throw new Error("postImpl not set");
      return (await postImpl(url, body)) as T;
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

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "P",
    model: overrides.model ?? "mock",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    retryCount: overrides.retryCount ?? 0,
    maxRetries: overrides.maxRetries ?? 0,
    createdAt: overrides.createdAt ?? now,
    queuedAt: overrides.queuedAt ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    createdBy: overrides.createdBy ?? null,
    attachments: overrides.attachments,
  };
}

describe("App.runSingleTask", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks/")) {
        const taskId = url.split("/api/tasks/")[1]?.split("?")[0]?.split("/")[0] ?? "t-1";
        const task = makeTask({ id: taskId, status: "pending" });
        return { ...task, messages: [] } satisfies TaskDetail;
      }
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
    postImpl = async () => {
      throw new Error("postImpl not overridden");
    };
  });

  afterEach(() => {
    getImpl = null;
    postImpl = null;
    vi.clearAllMocks();
  });

  it("calls POST /api/tasks/:id/run and shows a toast notice without shifting the task list", async () => {
    const called: string[] = [];
    postImpl = async (url: string) => {
      called.push(url);
      if (url.includes("/api/tasks/t-1/run")) return { success: true, taskId: "t-1", mode: "single", state: "scheduled" };
      throw new Error(`unexpected url: ${url}`);
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    wrapper.vm.tasks = [makeTask({ id: "t-1", status: "pending" })];
    await settleUi(wrapper);

    await wrapper.vm.runSingleTask("t-1");
    await settleUi(wrapper);

    expect(called.some((u) => u.includes("/api/tasks/t-1/run"))).toBe(true);
    expect(typeof wrapper.vm.apiNotice).toBe("string");
    expect(wrapper.vm.apiNotice).toContain("t-1".slice(0, 8));

    const toast = wrapper.find(".noticeToast");
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("scheduled");
    expect(toast.attributes("role")).toBe("status");
    expect(toast.attributes("aria-live")).toBe("polite");

    expect(wrapper.find("aside.left").text()).not.toContain("scheduled");
    expect(wrapper.find("aside.left .notice").exists()).toBe(false);
    wrapper.unmount();
  }, 15000);

  it("auto-clears the toast notice after 3 seconds", async () => {
    vi.useFakeTimers();
    try {
      postImpl = async (url: string) => {
        if (url.includes("/api/tasks/t-1/run")) return { success: true, taskId: "t-1", mode: "single", state: "scheduled" };
        throw new Error(`unexpected url: ${url}`);
      };

      const App = (await import("../App.vue")).default;
      const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
      await settleUi(wrapper);

      wrapper.vm.tasks = [makeTask({ id: "t-1", status: "pending" })];
      await settleUi(wrapper);

      await wrapper.vm.runSingleTask("t-1");
      await settleUi(wrapper);
      expect(wrapper.find(".noticeToast").exists()).toBe(true);

      vi.advanceTimersByTime(3000);
      await settleUi(wrapper);
      expect(wrapper.find(".noticeToast").exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
