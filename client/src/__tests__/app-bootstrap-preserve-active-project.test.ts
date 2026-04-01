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
  }

  return { AdsWebSocket };
});

vi.mock("../components/LoginGate.vue", () => {
  return {
    default: defineComponent({
      name: "LoginGate",
      emits: ["logged-in"],
      mounted() {
        queueMicrotask(() => {
          this.$emit("logged-in", { id: "u-1", username: "admin" });
        });
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

describe("App bootstrap preserves the visible active project", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "ADS_WEB_PROJECTS",
      JSON.stringify([
        { sessionId: "p1", path: "/tmp/project-a", name: "Project A", initialized: true, chatSessionId: "main" },
        { sessionId: "p2", path: "/tmp/project-b", name: "Project B", initialized: true, chatSessionId: "main" },
      ]),
    );
    localStorage.setItem("ADS_WEB_ACTIVE_PROJECT", "p2");

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url === "/api/projects") {
        return {
          projects: [
            { id: "p1", workspaceRoot: "/tmp/project-a", name: "Project A", chatSessionId: "main", createdAt: 1, updatedAt: 1 },
            { id: "p2", workspaceRoot: "/tmp/project-b", name: "Project B", chatSessionId: "main", createdAt: 2, updatedAt: 2 },
          ],
          activeProjectId: "p1",
        };
      }
      if (url.includes("/api/task-queue/status")) {
        return { enabled: true, running: false, ready: true, streaming: false } satisfies TaskQueueStatus;
      }
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

  it("does not switch to the server active project when the current local project is still present", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);

    expect((wrapper.vm as any).activeProjectId).toBe("p2");
    expect(localStorage.getItem("ADS_WEB_ACTIVE_PROJECT")).toBe("p2");

    wrapper.unmount();
  });
});
