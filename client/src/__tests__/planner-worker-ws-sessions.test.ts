import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";
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
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    localStorage.clear();
  });

  it("opens worker and advisor chat sessions for the default project", async () => {
    const { wrapper } = await mountController();

    const chats = wsConnections
      .filter((c) => c.sessionId === "default")
      .map((c) => c.chatSessionId)
      .sort();

    expect(chats).toContain("main");
    expect(chats).toContain("advisor");
    wrapper.unmount();
  });

  it("keeps reconnect and only swaps lane history after resume snapshots arrive", async () => {
    const { wrapper, controller } = await mountController();

    const actionsRt = controller.getRuntime("default");
    const acopilotRt = controller.getAcopilotRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const advisorWs = wsByChatSessionId.get("advisor");

    expect(workerWs).toBeTruthy();
    expect(advisorWs).toBeTruthy();

    actionsRt.messages.value = [{ id: "w-1", role: "assistant", kind: "text", content: "worker history" }];
    acopilotRt.messages.value = [{ id: "p-1", role: "assistant", kind: "text", content: "advisor history" }];
    actionsRt.busy.value = false;
    acopilotRt.busy.value = true;
    await settleUi(wrapper as any);

    advisorWs.onClose?.({ code: 1006, reason: "" });
    await settleUi(wrapper as any);

    expect(acopilotRt.connected.value).toBe(false);
    expect(actionsRt.connected.value).toBe(true);
    expect(acopilotRt.busy.value).toBe(true);
    expect(actionsRt.busy.value).toBe(false);

    advisorWs.onOpen?.();
    await settleUi(wrapper as any);
    advisorWs.onMessage?.({ type: "welcome", inFlight: false });
    await settleUi(wrapper as any);

    expect(acopilotRt.connected.value).toBe(true);

    acopilotRt.messages.value = [];
    advisorWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "advisor restored only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toContain("advisor restored only");
    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    await controller.resumeAcopilotThread();
    expect(advisorWs.send).toHaveBeenCalledWith("task_resume");
    expect(workerWs.send).not.toHaveBeenCalledWith("task_resume");
    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor restored only"]);
    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    advisorWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "advisor resumed only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor resumed only"]);

    await controller.resumeTaskThread();
    expect(workerWs.send).toHaveBeenCalledWith("task_resume");
    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);
    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor resumed only"]);

    workerWs.onMessage?.({
      type: "history",
      items: [{ role: "ai", text: "worker resumed only", kind: "text", ts: Date.now() }],
    });
    await settleUi(wrapper as any);

    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker resumed only"]);
    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor resumed only"]);
    wrapper.unmount();
  });

  it("keeps existing chat visible when worker or advisor resume fails", async () => {
    const { wrapper, controller } = await mountController();

    const actionsRt = controller.getRuntime("default");
    const acopilotRt = controller.getAcopilotRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const advisorWs = wsByChatSessionId.get("advisor");

    expect(workerWs).toBeTruthy();
    expect(advisorWs).toBeTruthy();

    actionsRt.messages.value = [{ id: "w-1", role: "assistant", kind: "text", content: "worker history" }];
    acopilotRt.messages.value = [{ id: "p-1", role: "assistant", kind: "text", content: "advisor history" }];
    await settleUi(wrapper as any);

    await controller.resumeTaskThread();
    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);

    workerWs.onMessage?.({ type: "error", message: "worker resume failed" });
    await settleUi(wrapper as any);

    expect(actionsRt.messages.value.map((entry: any) => entry.content)).toEqual(["worker history"]);
    expect(actionsRt.laneStatus.value).toEqual({ kind: "error", message: "worker resume failed" });

    await controller.resumeAcopilotThread();
    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor history"]);

    advisorWs.onMessage?.({ type: "error", message: "advisor resume failed" });
    await settleUi(wrapper as any);

    expect(acopilotRt.messages.value.map((entry: any) => entry.content)).toEqual(["advisor history"]);
    expect(acopilotRt.laneStatus.value).toEqual({ kind: "error", message: "advisor resume failed" });
    wrapper.unmount();
  });

  it("suppresses resume attempts while lane input is locked", async () => {
    const { wrapper, controller } = await mountController();

    const actionsRt = controller.getRuntime("default");
    const acopilotRt = controller.getAcopilotRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    const advisorWs = wsByChatSessionId.get("advisor");

    actionsRt.inputLocked.value = true;
    acopilotRt.inputLocked.value = true;

    await controller.resumeTaskThread();
    await controller.resumeAcopilotThread();
    await settleUi(wrapper as any);

    expect(workerWs.send).not.toHaveBeenCalledWith("task_resume");
    expect(advisorWs.send).not.toHaveBeenCalledWith("task_resume");
    wrapper.unmount();
  });

  it("unlocks the target lane when a resume request is not accepted by the websocket", async () => {
    const { wrapper, controller } = await mountController();

    const actionsRt = controller.getRuntime("default");
    const workerWs = wsByChatSessionId.get("main");
    workerWs.send.mockReturnValueOnce(false);

    await controller.resumeTaskThread();
    await settleUi(wrapper as any);

    expect(actionsRt.inputLocked.value).toBe(false);
    expect(actionsRt.resumeReplacePending).toBe(false);
    expect(actionsRt.laneStatus.value).toEqual({
      kind: "error",
      message: "恢复上下文失败：WebSocket 尚未连接，请稍后重试",
    });
    wrapper.unmount();
  });
});
