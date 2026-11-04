import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../app/controller";
import { createChatActions } from "../app/chat";
import type { ProjectRuntime } from "../app/controllerTypes";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

const HISTORY_INJECTION_WARNING = "没有可复用的原生会话，下一轮发送时会注入最近聊天历史来延续上下文。";
const HISTORY_INJECTION_STATUS = "后端线程未直接恢复；下一轮发送时会注入最近聊天历史来延续上下文。";
const THREAD_RESUMED_STATUS = "已恢复后端上下文线程。";

function setup(lane: "actions" | "acopilot"): { rt: ProjectRuntime; handler: (msg: unknown) => void } {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = lane === "actions" ? ctx.getRuntime("default") : ctx.getAcopilotRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = lane === "actions" ? "main" : "acopilot";
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    preferenceLane: lane,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId: ctx.randomId,
    updateProject: vi.fn(),
    applyResumeHistory: chat.applyResumeHistory,
    cancelPendingResume: chat.cancelPendingResume,
    clearPendingPrompt: chat.clearPendingPrompt,
    clearStepLive: chat.clearStepLive,
    commandKeyForWsEvent: chat.commandKeyForWsEvent,
    finalizeAssistant: chat.finalizeAssistant,
    finalizeCommandBlock: chat.finalizeCommandBlock,
    flushQueuedPrompts: chat.flushQueuedPrompts,
    enqueuePrompt: vi.fn(),
    ingestCommand: chat.ingestCommand,
    ingestCommandActivity: chat.ingestCommandActivity,
    ingestExploredActivity: chat.ingestExploredActivity,
    pushMessageBeforeLive: chat.pushMessageBeforeLive,
    threadReset: chat.threadReset,
    upsertExecuteBlock: chat.upsertExecuteBlock,
    upsertLiveActivity: chat.upsertLiveActivity,
    upsertStreamingDelta: chat.upsertStreamingDelta,
    replaceStreamingText: chat.replaceStreamingText,
  });
  rt.busy.value = false;
  rt.turnInFlight = false;
  rt.laneStatus.value = null;
  rt.threadWarning.value = null;
  return { rt, handler };
}

describe("context restoration notices are lane scoped", () => {
  it("keeps the history injection warning out of the Actions lane", () => {
    const { rt, handler } = setup("actions");
    rt.activeThreadId.value = "thread-old";

    handler({ type: "welcome", contextMode: "history_injection", threadId: "" });

    expect(rt.threadWarning.value).toBeNull();
  });

  it("keeps the history injection warning in the Acopilot lane", () => {
    const { rt, handler } = setup("acopilot");
    rt.activeThreadId.value = "thread-old";

    handler({ type: "welcome", contextMode: "history_injection", threadId: "" });

    expect(rt.threadWarning.value).toBe(HISTORY_INJECTION_WARNING);
  });

  it("keeps the history replay restore status out of the Actions lane", () => {
    const { rt, handler } = setup("actions");

    handler({ type: "history", contextMode: "history_injection", threadId: "thread-1", items: [] });

    expect(rt.laneStatus.value).toBeNull();
  });

  it("keeps the history replay restore status in the Acopilot lane", () => {
    const { rt, handler } = setup("acopilot");

    handler({ type: "history", contextMode: "history_injection", threadId: "thread-1", items: [] });

    expect(rt.laneStatus.value).toEqual({ kind: "info", message: HISTORY_INJECTION_WARNING });
  });

  it("keeps the server restore status out of the Actions lane", () => {
    const { rt, handler } = setup("actions");

    handler({ type: "status", message: HISTORY_INJECTION_STATUS, kind: "status" });

    expect(rt.laneStatus.value).toBeNull();
  });

  it("keeps the thread resumed status out of the Actions lane", () => {
    const { rt, handler } = setup("actions");

    handler({ type: "status", message: THREAD_RESUMED_STATUS, kind: "status" });

    expect(rt.laneStatus.value).toBeNull();
  });

  it("keeps other status messages in the Actions lane", () => {
    const { rt, handler } = setup("actions");

    handler({ type: "status", message: "当前工作目录: /home/andy/repos/ads", kind: "status" });

    expect(rt.laneStatus.value).toEqual({ kind: "info", message: "当前工作目录: /home/andy/repos/ads" });
  });

  it("keeps the transient context injection status out of the Actions lane", () => {
    const { rt, handler } = setup("actions");

    handler({ type: "context_injection", entryCount: 4, earliestTs: Date.now() });

    expect(rt.laneStatus.value).toBeNull();
  });

  it("keeps the transient context injection status in the Acopilot lane", () => {
    const { rt, handler } = setup("acopilot");

    handler({ type: "context_injection", entryCount: 4, earliestTs: Date.now() });

    expect(rt.laneStatus.value?.kind).toBe("info");
    expect(rt.laneStatus.value?.message).toContain("已注入最近 4 条聊天历史");
  });
});
