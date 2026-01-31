import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig, Task, TaskQueueStatus } from "../api/types";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
  onTaskEvent?: (payload: unknown) => void;
  onMessage?: (msg: unknown) => void;
  clearHistory: () => void;
} | null = null;

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

    clearHistory = vi.fn();

    constructor(_: { sessionId: string; chatSessionId?: string }) {
      lastWs = this as unknown as typeof lastWs;
    }

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

async function ensureWsConnected(wrapper: any): Promise<void> {
  if (!lastWs) {
    await wrapper.vm.connectWs?.();
    await settleUi(wrapper);
  }
  expect(lastWs).toBeTruthy();
  lastWs!.onOpen?.();
  await settleUi(wrapper);
}

describe("command UI lifecycle", () => {
  beforeEach(() => {
    lastWs = null;
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
    lastWs = null;
    vi.clearAllMocks();
  });

  it("shows per-command execute previews during turn and collapses to a tree on completion", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    lastWs!.onMessage?.({
      type: "command",
      command: {
        id: "c-1",
        command: "git status --porcelain",
        outputDelta: "$ git status --porcelain\nM a\nM b\nM c\nM d\n",
      },
    });
    await settleUi(wrapper);

    const during = (wrapper.vm as any).messages as Array<any>;
    expect(during.some((m) => m.kind === "command")).toBe(false);
    const execute = during.find((m) => m.kind === "execute");
    expect(execute).toBeTruthy();
    expect(execute.command).toBe("git status --porcelain");
    expect(String(execute.content)).toContain("M a");
    expect(String(execute.content)).not.toContain("M d");
    expect(execute.hiddenLineCount).toBe(3);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "Summary" });
    await settleUi(wrapper);

    const after = (wrapper.vm as any).messages as Array<any>;
    expect(after.some((m) => m.kind === "execute")).toBe(false);
    const tree = after.find((m) => m.kind === "command");
    expect(tree).toBeTruthy();
    expect(String(tree.content)).toContain("$ git status --porcelain");
    expect(after.some((m) => m.role === "assistant" && m.kind === "text" && m.content.includes("Summary"))).toBe(true);

    wrapper.unmount();
  });

  it("does not keep an empty streaming placeholder when the turn returns an empty result", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "" });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    expect(messages.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(false);

    wrapper.unmount();
  });

  it("hides boot/analysis step traces and drops the placeholder once progress arrives", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    const before = (wrapper.vm as any).messages as Array<any>;
    expect(before.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(true);

    lastWs!.onMessage?.({ type: "delta", delta: "[boot] 初始化 Codex 线程: thread#1\n", source: "step" });
    lastWs!.onMessage?.({ type: "delta", delta: "[analysis] 开始处理请求\n", source: "step" });
    await settleUi(wrapper);

    const afterBoot = (wrapper.vm as any).messages as Array<any>;
    const allText = afterBoot.map((m) => String(m.content ?? "")).join("\n");
    expect(allText).not.toContain("初始化 Codex 线程");
    expect(allText).not.toContain("开始处理请求");

    lastWs!.onMessage?.({ type: "delta", delta: "[tool] Tool: shell\n", source: "step" });
    await settleUi(wrapper);

    const afterProgress = (wrapper.vm as any).messages as Array<any>;
    expect(afterProgress.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(false);
    expect(afterProgress.map((m) => String(m.content ?? "")).join("\n")).toContain("Tool: shell");

    wrapper.unmount();
  });
});
