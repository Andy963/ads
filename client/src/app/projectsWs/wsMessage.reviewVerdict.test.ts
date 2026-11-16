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

function handoffFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "agent_message",
    messageId: "review-verdict:job-1",
    kind: "review_verdict",
    fromLane: "actions",
    fromRole: "reviewer",
    toLane: "acopilot",
    toRole: "acopilot",
    correlationId: "job-1",
    issueId: 613,
    issueTitle: "Fix review handoff",
    issueUrl: "https://github.com/Andy963/ads/issues/613",
    prNumber: 614,
    status: "pending",
    baseSha: "aaa111",
    headSha: "cf1e4a7da50681226edf99caa383ff8c3c3aa089",
    text: "Reviewer -> Acopilot handoff for Issue #613. Status: REJECT.",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("Reviewer to Acopilot handoff events", () => {
  it("renders a visible agent handoff without creating a user prompt", () => {
    const { rt, handler, enqueuePrompt } = setup();
    handler(handoffFrame());

    expect(enqueuePrompt).not.toHaveBeenCalled();
    expect(rt.queuedPrompts.value).toEqual([]);
    const card = rt.messages.value.find((message) => message.id === "review-verdict:job-1");
    expect(card).toMatchObject({
      role: "system",
      kind: "agent_handoff",
      agentHandoff: {
        messageId: "review-verdict:job-1",
        status: "pending",
        issueId: 613,
        prNumber: 614,
        headSha: "cf1e4a7da50681226edf99caa383ff8c3c3aa089",
      },
    });
    expect(rt.messages.value.some((message) => message.role === "user")).toBe(false);
  });

  it("updates one card across handoff lifecycle events", () => {
    const { rt, handler } = setup();
    handler(handoffFrame());
    handler(handoffFrame({ status: "running", attempts: 1 }));
    handler(handoffFrame({ status: "delivered", attempts: 1 }));

    const cards = rt.messages.value.filter((message) => message.kind === "agent_handoff");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.agentHandoff?.status).toBe("delivered");
  });

  it("restores handoffs from an authoritative snapshot", () => {
    const { rt, handler } = setup();
    handler({ type: "agent_message_snapshot", entries: [handoffFrame({ status: "failed", lastError: "model unavailable" })] });
    expect(rt.messages.value.find((message) => message.kind === "agent_handoff")?.agentHandoff).toMatchObject({
      status: "failed",
      lastError: "model unavailable",
    });
  });

  it("ignores handoffs in the Actions lane", () => {
    const { handler, enqueuePrompt } = setup({ preferenceLane: "actions" });
    handler(handoffFrame());
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it("ignores the retired review_verdict_ready prompt source", () => {
    const { handler, enqueuePrompt } = setup();
    handler({ type: "review_verdict_ready", jobId: "job-legacy", issueId: 613, status: "PASS" });
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it("renders an agent-origin history entry as a handoff instead of user input", () => {
    const { rt, handler } = setup();
    handler({
      type: "user",
      clientMessageId: "review-verdict:job-1",
      text: "Reviewer handoff",
      ts: Date.now(),
      kind: "client_message_id:review-verdict:job-1;prompt_meta:origin=agent",
    });
    expect(rt.messages.value.some((message) => message.role === "user")).toBe(false);
    expect(rt.messages.value.some((message) => message.kind === "agent_handoff")).toBe(true);
  });
});
