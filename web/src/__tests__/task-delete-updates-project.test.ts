import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";
import type { ProjectTab } from "../app/controllerTypes";

type GetImpl = (url: string) => Promise<unknown>;
type DeleteImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let deleteImpl: DeleteImpl | null = null;

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

    async delete<T>(url: string): Promise<T> {
      if (!deleteImpl) throw new Error("deleteImpl not set");
      return (await deleteImpl(url)) as T;
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
    prompt: overrides.prompt ?? "Do something",
    model: overrides.model ?? "auto",
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

function makeProject(overrides: Partial<ProjectTab>): ProjectTab {
  const now = Date.now();
  return {
    id: overrides.id ?? `p-${now}`,
    name: overrides.name ?? "Project",
    path: overrides.path ?? "/workspace",
    sessionId: overrides.sessionId ?? overrides.id ?? `p-${now}`,
    initialized: overrides.initialized ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    branch: overrides.branch,
    expanded: overrides.expanded ?? true,
  };
}

describe("task delete updates correct project runtime", () => {
  beforeEach(() => {
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      if (url.startsWith("/api/tasks")) return [] satisfies Task[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
    deleteImpl = async () => ({ success: true });
  });

  afterEach(() => {
    getImpl = null;
    deleteImpl = null;
    vi.clearAllMocks();
  });

  it("removes the task from the project it was deleted from, even if activeProjectId changes before confirm", async () => {
    const deletedUrls: string[] = [];
    deleteImpl = async (url: string) => {
      deletedUrls.push(url);
      return { success: true };
    };

    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    const p1 = makeProject({ id: "p1", path: "/w/p1", expanded: true });
    const p2 = makeProject({ id: "p2", path: "/w/p2", expanded: true });
    wrapper.vm.projects = [p1, p2];
    wrapper.vm.activeProjectId = "p1";
    await settleUi(wrapper);

    const t1 = makeTask({ id: "t-1", title: "To delete", status: "pending" });
    const t2 = makeTask({ id: "t-2", title: "Keep", status: "pending" });
    const t3 = makeTask({ id: "t-3", title: "Other project", status: "pending" });

    const rt1 = wrapper.vm.getRuntime("p1");
    const rt2 = wrapper.vm.getRuntime("p2");
    rt1.tasks.value = [t1, t2];
    rt1.selectedId.value = "t-1";
    rt2.tasks.value = [t3];
    rt2.selectedId.value = "t-3";
    await settleUi(wrapper);

    await wrapper.vm.deleteTask("t-1");
    await settleUi(wrapper);

    // Simulate user switching project before confirming the modal.
    wrapper.vm.activeProjectId = "p2";
    await settleUi(wrapper);

    await wrapper.vm.confirmDeleteTask();
    await settleUi(wrapper);

    expect(rt1.tasks.value.map((t: Task) => t.id)).toEqual(["t-2"]);
    expect(rt2.tasks.value.map((t: Task) => t.id)).toEqual(["t-3"]);
    expect(deletedUrls.some((u) => u.includes("/api/tasks/t-1"))).toBe(true);
    expect(deletedUrls.some((u) => u.includes("workspace=%2Fw%2Fp1"))).toBe(true);

    wrapper.unmount();
  }, 15000);
});
