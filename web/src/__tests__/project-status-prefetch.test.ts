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
      // Let tests decide when to trigger onOpen/onMessage/onClose.
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

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: overrides.id ?? `t-${now}`,
    title: overrides.title ?? "Test Task",
    prompt: overrides.prompt ?? "",
    model: overrides.model ?? "mock",
    status: overrides.status ?? "pending",
    priority: overrides.priority ?? 0,
    queueOrder: overrides.queueOrder ?? 0,
    inheritContext: overrides.inheritContext ?? true,
    agentId: overrides.agentId ?? null,
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

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("project status spinner prefetch", () => {
  beforeEach(() => {
    localStorage.clear();

    const now = Date.now();
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        {
          sessionId: "default",
          name: "Default",
          path: "",
          chatSessionId: "main",
          initialized: true,
          createdAt: now,
          updatedAt: now,
          expanded: true,
        },
        {
          sessionId: "sess-b",
          name: "B",
          path: "/tmp/work-b",
          chatSessionId: "main",
          initialized: true,
          createdAt: now,
          updatedAt: now,
          expanded: false,
        },
        {
          sessionId: "sess-a",
          name: "A",
          path: "/tmp/work-a",
          chatSessionId: "main",
          initialized: true,
          createdAt: now,
          updatedAt: now,
          expanded: false,
        },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "sess-a");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.includes("/api/task-queue/status"))
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;

      if (url.startsWith("/api/tasks")) {
        if (url.includes("workspace=%2Ftmp%2Fwork-a")) return [makeTask({ id: "t-a", status: "running" })] satisfies Task[];
        if (url.includes("workspace=%2Ftmp%2Fwork-b")) return [makeTask({ id: "t-b", status: "running" })] satisfies Task[];
        return [] satisfies Task[];
      }
      if (url.startsWith("/api/projects")) {
        return {
          projects: [
            { id: "sess-a", workspaceRoot: "/tmp/work-a", name: "A", chatSessionId: "main", createdAt: now, updatedAt: now },
            { id: "sess-b", workspaceRoot: "/tmp/work-b", name: "B", chatSessionId: "main", createdAt: now, updatedAt: now },
          ],
          activeProjectId: "sess-a",
        };
      }
      if (url.startsWith("/api/paths/validate")) {
        if (url.includes("work-a")) return { ok: true, projectSessionId: "sess-a", workspaceRoot: "/tmp/work-a", resolvedPath: "/tmp/work-a" };
        if (url.includes("work-b")) return { ok: true, projectSessionId: "sess-b", workspaceRoot: "/tmp/work-b", resolvedPath: "/tmp/work-b" };
        return { ok: false };
      }
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows spinners for projects that have running tasks after a page reload", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    for (let i = 0; i < 40; i += 1) {
      await settleUi(wrapper);
      const rows = wrapper.findAll(".projectRow");
      if (rows.length < 2) continue;
      const vm = wrapper.vm as any;
      const bTasks = vm.getRuntime("sess-b").tasks.value;
      if (Array.isArray(bTasks) && bTasks.length > 0) break;
    }

    const rows = wrapper.findAll(".projectRow");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const rowA = rows.find((r) => r.text().includes("A")) ?? null;
    const rowB = rows.find((r) => r.text().includes("B")) ?? null;
    const rowWorkspace = rows.find((r) => r.text().includes("Workspace")) ?? null;

    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();
    expect(rowWorkspace).toBeTruthy();

    expect(rowA!.find(".projectStatus").classes("spinning")).toBe(true);
    expect(rowB!.find(".projectStatus").classes("spinning")).toBe(true);

    wrapper.unmount();
  });
});
