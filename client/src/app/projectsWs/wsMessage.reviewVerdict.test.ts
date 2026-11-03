import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions } from "../chat";
import type { ProjectRuntime } from "../controllerTypes";

import { createWsMessageHandler } from "./wsMessage";

function setup(options: { preferenceLane?: "actions" | "acopilot" } = {}): {
  rt: ProjectRuntime;
  handler: (msg: unknown) => void;
  enqueuePrompt: ReturnType<typeof vi.fn>;
} {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = options.preferenceLane === "actions" ? ctx.getRuntime("default") : ctx.getAcopilotRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = options.preferenceLane === "actions" ? "main" : "acopilot";
  const enqueuePrompt = vi.fn();
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    preferenceLane: options.preferenceLane,
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
    enqueuePrompt,
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
  return { rt, handler, enqueuePrompt };
}

function wakeFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "review_verdict_ready",
    jobId: "job-1",
    issueId: 613,
    prNumber: 614,
    status: "REJECT",
    headSha: "cf1e4a7da50681226edf99caa383ff8c3c3aa089",
    ...overrides,
  };
}

describe("review_verdict_ready wake event", () => {
  it("queues a follow-up turn that points at the Issue verdict comment", () => {
    const { handler, enqueuePrompt } = setup();
    handler(wakeFrame());

    expect(enqueuePrompt).toHaveBeenCalledTimes(1);
    const [prompt, images, rt] = enqueuePrompt.mock.calls[0]!;
    expect(String(prompt)).toContain("Issue #613");
    expect(String(prompt)).toContain("PR #614");
    expect(String(prompt)).toContain("REJECT");
    expect(String(prompt)).toContain("ads:review-verdict");
    expect(String(prompt)).toContain("job-1");
    expect(images).toEqual([]);
    expect(rt).toBeTruthy();
  });

  it("ignores a duplicate wake for the same job", () => {
    const { handler, enqueuePrompt } = setup();
    handler(wakeFrame());
    handler(wakeFrame());
    expect(enqueuePrompt).toHaveBeenCalledTimes(1);
  });

  it("shows a notice instead of interrupting a busy lane", () => {
    const { rt, handler, enqueuePrompt } = setup();
    rt.busy.value = true;
    handler(wakeFrame({ status: "PASS" }));
    expect(rt.laneStatus.value?.kind).toBe("info");
    expect(String(rt.laneStatus.value?.message ?? "")).toContain("评审结论");
    expect(enqueuePrompt).toHaveBeenCalledTimes(1);
  });

  it("does not react in the Actions lane", () => {
    const { handler, enqueuePrompt } = setup({ preferenceLane: "actions" });
    handler(wakeFrame());
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });
});
