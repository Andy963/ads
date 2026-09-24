import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatActions } from "../chat";
import { createAppContext, type AppContext } from "../controller";
import type { ProjectRuntime } from "../controllerTypes";

import { createWsMessageHandler } from "./wsMessage";

function setup(): { rt: ProjectRuntime; handler: (message: unknown) => void } {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = ctx.getRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = "main";
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
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
  return { rt, handler };
}

describe("Actions WebSocket event contract", () => {
  afterEach(() => {
    delete (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: unknown }).__ADS_ON_ACTION_JOB_UPDATED__;
    vi.clearAllMocks();
  });

  it("ignores legacy step events while rendering command, final response, and job status", () => {
    const { rt, handler } = setup();
    const onJobUpdate = vi.fn();
    (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: unknown }).__ADS_ON_ACTION_JOB_UPDATED__ = onJobUpdate;

    handler({ type: "step", title: "Developer live step", delta: "Inspecting files", jobId: "job-345" });
    expect(rt.messages.value.some((message) => message.id === "live-step")).toBe(false);

    handler({ type: "command", command: "npm test", output: "failed", status: "failed", jobId: "job-345" });
    expect(rt.turnCommands).toContain("npm test");

    handler({ type: "assistant_done", text: "Implementation complete", jobId: "job-345", ts: 1000 });
    expect(rt.messages.value.some((message) => message.role === "assistant" && message.content === "Implementation complete")).toBe(true);

    handler({ type: "action_job_updated", jobId: "job-345", status: "blocked", reworkCount: 2 });
    expect(onJobUpdate).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-345", status: "blocked" }));
  });

  it("lets ordinary chat command events use the normal command lifecycle", () => {
    const { rt, handler } = setup();

    handler({
      type: "command",
      command: { command: "npm test", outputDelta: "running", status: "running" },
      ts: 1000,
    });

    expect(rt.turnCommands).toContain("npm test");
    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
  });

  it("keeps identical final responses from separate Action jobs", () => {
    const { rt, handler } = setup();

    handler({ type: "assistant_done", text: "Done", jobId: "job-1", ts: 1000 });
    handler({ type: "assistant_done", text: "Done", jobId: "job-2", ts: 1001 });

    expect(rt.messages.value.filter((message) => message.role === "assistant" && message.content === "Done")).toHaveLength(2);
  });
});
