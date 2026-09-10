import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";

import type { ModelConfig } from "../api/types";
import { RECONNECT_PENDING_RESEND_NOTICE } from "../app/projectsWs/reconnectNotice";

type GetImpl = (url: string) => Promise<unknown>;

let getImpl: GetImpl | null = null;
let lastWs: {
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason?: string }) => void;
  onError?: () => void;
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
    onMessage?: (msg: unknown) => void;

    clearHistory = vi.fn();

    constructor(options: { sessionId: string; chatSessionId?: string }) {
      const chatSessionId = String(options.chatSessionId ?? "main").trim() || "main";
      if (chatSessionId === "planner") return;
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
    localStorage.clear();
    sessionStorage.clear();
    lastWs = null;
    getImpl = async (url: string) => {
      if (url === "/api/models") return [] satisfies ModelConfig[];
      if (url.startsWith("/api/paths/validate")) return { ok: false };
      return {};
    };
  });

  afterEach(() => {
    getImpl = null;
    lastWs = null;
    vi.clearAllMocks();
  });

  it("shows the latest execute preview during turn and preserves it on completion", async () => {
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
    expect(during.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(false);
    expect(during.some((m) => m.kind === "command")).toBe(false);
    const execute = during.find((m) => m.kind === "execute");
    expect(execute).toBeTruthy();
    expect(execute.command).toBe("git status --porcelain");
    expect(String(execute.content)).toContain("M a");
    expect(String(execute.content)).toContain("M c");
    expect(String(execute.content)).not.toContain("M d");
    expect(String(execute.fullContent)).toContain("M d");
    expect(execute.hiddenLineCount).toBe(1);

    lastWs!.onMessage?.({ type: "result", ok: true, output: "Summary" });
    await settleUi(wrapper);

    const after = (wrapper.vm as any).messages as Array<any>;
    const completedExecute = after.find((m) => m.kind === "execute");
    expect(completedExecute).toMatchObject({
      command: "git status --porcelain",
      streaming: false,
    });
    expect(after.some((m) => m.kind === "command")).toBe(false);
    expect(after.some((m) => m.role === "assistant" && m.kind === "text" && m.content.includes("Summary"))).toBe(true);

    wrapper.unmount();
  });

  it("renders successful command results as execute blocks instead of assistant replies", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    lastWs!.onMessage?.({
      type: "result",
      ok: true,
      kind: "execute",
      command: "git status --short",
      output: "M file.ts\n",
    });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    const execute = messages.find((m) => m.kind === "execute");
    expect(execute).toMatchObject({
      role: "system",
      kind: "execute",
      command: "git status --short",
      content: "M file.ts",
      streaming: false,
    });
    expect(messages.some((m) => m.role === "assistant" && String(m.content ?? "").includes("M file.ts"))).toBe(false);

    wrapper.unmount();
  });

  it("renders and completes commands when the backend sends no output fields", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    try {
      await settleUi(wrapper);
      await ensureWsConnected(wrapper);
      (wrapper.vm as any).sendMainPrompt("Run checks");
      await settleUi(wrapper);

      lastWs!.onMessage?.({
        type: "command", ts: 1,
        command: { id: "cmd-only", identity: "cmd-only", command: "npm test", status: "inProgress" },
      });
      await settleUi(wrapper);
      const running = ((wrapper.vm as any).messages as Array<any>).filter((message) => message.kind === "execute");
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({ command: "npm test", content: "", streaming: true });

      lastWs!.onMessage?.({
        type: "command", ts: 2,
        command: { id: "cmd-only", identity: "cmd-only", command: "npm test", status: "completed", exit_code: 0 },
      });
      await settleUi(wrapper);
      const completed = ((wrapper.vm as any).messages as Array<any>).filter((message) => message.kind === "execute");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ command: "npm test", content: "", streaming: false });
      lastWs!.onMessage?.({ type: "result", ok: true, output: "Checks complete" });
      await settleUi(wrapper);
    } finally {
      wrapper.unmount();
    }
  });

  it("truncates long command result blocks while preserving full output", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    lastWs!.onMessage?.({
      type: "result",
      ok: true,
      kind: "execute",
      command: "npm test",
      output: "line 1\nline 2\nline 3\nline 4\n",
    });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    const execute = messages.find((m) => m.kind === "execute");
    expect(execute).toMatchObject({
      role: "system",
      kind: "execute",
      command: "npm test",
      content: "line 1\nline 2\nline 3",
      fullContent: "line 1\nline 2\nline 3\nline 4",
      hiddenLineCount: 1,
      streaming: false,
    });
    expect(String(execute.content)).not.toContain("line 4");

    wrapper.unmount();
  });

  it("renders failed command results with command context as execute blocks", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    lastWs!.onMessage?.({
      type: "result",
      ok: false,
      kind: "execute",
      command: "npm test",
      output: "Tests failed\n",
    });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    const execute = messages.find((m) => m.kind === "execute");
    expect(execute).toMatchObject({
      role: "system",
      kind: "execute",
      command: "npm test",
      content: "Tests failed",
      streaming: false,
    });
    expect(messages.some((m) => m.role === "system" && m.kind === "error" && String(m.content ?? "").includes("Tests failed"))).toBe(false);

    wrapper.unmount();
  });

  it("renders successful status command results in the fixed lane status", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    lastWs!.onMessage?.({
      type: "result",
      ok: true,
      kind: "status",
      output: "当前工作目录: /tmp/project",
    });
    await settleUi(wrapper);

    const messages = (wrapper.vm as any).messages as Array<any>;
    expect(messages.some((m) => m.role === "system" && m.kind === "text" && m.content === "当前工作目录: /tmp/project")).toBe(false);
    expect(messages.some((m) => m.role === "assistant" && String(m.content ?? "").includes("当前工作目录"))).toBe(false);
    expect((wrapper.vm as any).workerConnectionStatus).toEqual({
      kind: "info",
      message: "当前工作目录: /tmp/project",
    });

    (wrapper.vm as any).sendMainPrompt("continue");
    await settleUi(wrapper);

    expect((wrapper.vm as any).workerConnectionStatus).toBeNull();

    lastWs!.onMessage?.({ type: "result", ok: true, output: "done" });
    await settleUi(wrapper);

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

  it("renders provider-authored live-step text and drops the placeholder once progress arrives", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);

    const before = (wrapper.vm as any).messages as Array<any>;
    expect(before.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(true);

    lastWs!.onMessage?.({ type: "delta", delta: "I will inspect the workspace before running a command.\n", source: "step" });
    await settleUi(wrapper);

    const afterProgress = (wrapper.vm as any).messages as Array<any>;
    expect(afterProgress.some((m) => m.role === "assistant" && m.streaming && String(m.content).trim() === "")).toBe(false);
    expect(afterProgress.map((m) => String(m.content ?? "")).join("\n")).toContain(
      "I will inspect the workspace before running a command.",
    );

    wrapper.unmount();
  });

  it("shows reconnect progress instead of the retryable websocket close error", async () => {
    const App = (await import("../App.vue")).default;
    const wrapper = shallowMount(App, { global: { stubs: { LoginGate: false } } });
    await settleUi(wrapper);
    await ensureWsConnected(wrapper);

    (wrapper.vm as any).sendMainPrompt("hello");
    await settleUi(wrapper);
    lastWs!.onClose?.({ code: 1006, reason: "network changed" });
    await settleUi(wrapper);

    expect((wrapper.vm as any).workerConnectionStatus).toEqual({
      kind: "progress",
      message: RECONNECT_PENDING_RESEND_NOTICE,
    });
    wrapper.unmount();
  });
});
