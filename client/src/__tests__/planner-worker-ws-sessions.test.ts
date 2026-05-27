import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";
import { createAppController } from "../app/controller";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
const wsConnections: Array<{ sessionId: string; chatSessionId: string }> = [];
const wsByChatSessionId = new Map<string, any>();

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
    send = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main");
      wsConnections.push({
        sessionId: String(options.sessionId ?? ""),
        chatSessionId,
      });
      wsByChatSessionId.set(chatSessionId, this);
    }

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

async function mountController() {
  let controller: ReturnType<typeof createAppController> | null = null;
  const Harness = defineComponent({
    setup() {
      controller = createAppController();
      return {};
    },
    template: "<div />",
  });

  const wrapper = mount(Harness);
  await settleUi(wrapper as any);
  if (!controller) {
    throw new Error("controller not created");
  }
  controller.loggedIn.value = true;
  controller.currentUser.value = { id: "u-1", username: "admin" } as any;
  await controller.bootstrap();
  await settleUi(wrapper as any);
  return { wrapper, controller };
}

describe("Lane websocket sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    wsConnections.length = 0;
    wsByChatSessionId.clear();

    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
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
  });

  it("opens worker and planner chat sessions for the default project", async () => {
    const { wrapper } = await mountController();

    const chats = wsConnections
      .filter((c) => c.sessionId === "default")
      .map((c) => c.chatSessionId)
      .sort();

    expect(chats).toContain("main");
    expect(chats).toContain("planner");
    wrapper.unmount();
  });

  it("keeps reconnect and only swaps lane history after resume snapshots arrive", async () => {
    const { wrapper, controller } = await mountController();

    const workerRt = controller.getRuntime("default");
    const plannerRt = controller.getPlannerRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const plannerWs = wsByChatSessionId.get("planner");

    expect(workerWs).toBeTruthy();
    expect(plannerWs).toBeTruthy();

    workerRt.messages.value = [{ id: "w-1", role: "assistant", kind: "text", content: "worker history" }];
    plannerRt.messages.value = [{ id: "p-1", role: "assistant", kind: "text", content: "planner history" }];
    workerRt.busy.value = false;
    plannerRt.busy.value = true;
    await settleUi(wrapper as any);

    plannerWs.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper as any);

    expect(plannerRt.connected.value).toBe(false);
    expect(workerRt.connected.value).toBe(true);
    expect(plannerRt.busy.value).toBe(true);
    expect(workerRt.busy.value).toBe(false);

    plannerWs.onOpen?.();
    await settleUi(wrapper as any);
    plannerWs.onMessage?.({ type: "welcome", inFlight: false });
    await settleUi(wrapper as any);

    expect(plannerRt.connected.value).toBe(true);

    plannerRt.messages.value = [];
    plannerWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "planner restored only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toContain("planner restored only");
    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    await controller.resumePlannerThread();
    expect(plannerWs.send).toHaveBeenCalledWith("task_resume");
    expect(workerWs.send).not.toHaveBeenCalledWith("task_resume");
    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner restored only"]);
    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    plannerWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "planner resumed only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner resumed only"]);

    await controller.resumeTaskThread();
    expect(workerWs.send).toHaveBeenCalledWith("task_resume");
    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);
    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner resumed only"]);

    workerWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "worker resumed only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker resumed only"]);
    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner resumed only"]);
    wrapper.unmount();
  });

  it("keeps existing chat visible when worker or planner resume fails", async () => {
    const { wrapper, controller } = await mountController();

    const workerRt = controller.getRuntime("default");
    const plannerRt = controller.getPlannerRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const plannerWs = wsByChatSessionId.get("planner");

    expect(workerWs).toBeTruthy();
    expect(plannerWs).toBeTruthy();

    workerRt.messages.value = [{ id: "w-1", role: "assistant", kind: "text", content: "worker history" }];
    plannerRt.messages.value = [{ id: "p-1", role: "assistant", kind: "text", content: "planner history" }];
    await settleUi(wrapper as any);

    await controller.resumeTaskThread();
    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    workerWs.onMessage?.({ type: "error", message: "worker resume failed" });
    await settleUi(wrapper as any);

    expect(workerRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history", "worker resume failed"]);
    expect(workerRt.messages.value.at(-1)?.kind).toBe("error");

    await controller.resumePlannerThread();
    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner history"]);

    plannerWs.onMessage?.({ type: "error", message: "planner resume failed" });
    await settleUi(wrapper as any);

    expect(plannerRt.messages.value.map((entry: any) => entry.content)).toEqual(["planner history", "planner resume failed"]);
    expect(plannerRt.messages.value.at(-1)?.kind).toBe("error");
    wrapper.unmount();
  });

  it("shows blocked resume attempts as error messages in the target lane", async () => {
    const { wrapper, controller } = await mountController();

    const workerRt = controller.getRuntime("default");
    const plannerRt = controller.getPlannerRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const plannerWs = wsByChatSessionId.get("planner");

    workerRt.queueStatus.value = { enabled: true, running: true, ready: true, streaming: false } satisfies TaskQueueStatus;

    await controller.resumeTaskThread();
    await controller.resumePlannerThread();
    await settleUi(wrapper as any);

    expect(workerWs.send).not.toHaveBeenCalledWith("task_resume");
    expect(plannerWs.send).not.toHaveBeenCalledWith("task_resume");
    expect(workerRt.messages.value.at(-1)).toMatchObject({
      role: "system",
      kind: "error",
      content: "任务执行中，无法恢复",
    });
    expect(plannerRt.messages.value.at(-1)).toMatchObject({
      role: "system",
      kind: "error",
      content: "任务执行中，无法恢复",
    });
    wrapper.unmount();
  });
});
