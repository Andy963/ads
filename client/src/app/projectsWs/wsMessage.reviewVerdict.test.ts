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
  it("routes an unstarted pending handoff to the active inbox slot without creating a user prompt or transcript card", () => {
    const { rt, handler, enqueuePrompt } = setup();
    handler(handoffFrame());

    expect(enqueuePrompt).not.toHaveBeenCalled();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.messages.value).toEqual([]);
    expect(rt.pendingAgentHandoffs.value).toHaveLength(1);
    expect(rt.pendingAgentHandoffs.value[0]).toMatchObject({
      messageId: "review-verdict:job-1",
      status: "pending",
      issueId: 613,
      prNumber: 614,
      headSha: "cf1e4a7da50681226edf99caa383ff8c3c3aa089",
    });
    expect(rt.messages.value.some((message) => message.role === "user")).toBe(false);
  });

  it("moves a pending handoff into one timeline card when execution starts and updates it in place", () => {
    const { rt, handler } = setup();
    handler(handoffFrame({ transitionRevision: 1 }));
    expect(rt.pendingAgentHandoffs.value).toHaveLength(1);
    expect(rt.messages.value).toHaveLength(0);

    handler(handoffFrame({ status: "running", attempts: 1, transitionRevision: 2 }));
    expect(rt.pendingAgentHandoffs.value).toHaveLength(0);
    expect(rt.messages.value.filter((message) => message.kind === "agent_handoff")).toHaveLength(1);

    handler(handoffFrame({ status: "delivered", attempts: 1, transitionRevision: 3 }));

    const cards = rt.messages.value.filter((message) => message.kind === "agent_handoff");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.agentHandoff?.status).toBe("delivered");
  });

  it("clears an unstarted pending handoff when superseded without adding a ghost card to the transcript", () => {
    const { rt, handler } = setup();
    handler(handoffFrame({ transitionRevision: 1 }));
    expect(rt.pendingAgentHandoffs.value).toHaveLength(1);

    handler(handoffFrame({ status: "superseded", attempts: 0, transitionRevision: 2 }));
    expect(rt.pendingAgentHandoffs.value).toEqual([]);
    expect(rt.messages.value).toEqual([]);
  });

  it("ignores unstarted superseded handoffs in agent_message_snapshot so stale cards never pin below newer turns", () => {
    const { rt, handler } = setup();
    handler({
      type: "history",
      items: [
        { role: "user", text: "Latest question", ts: 2_000, kind: "client_message_id:user-1" },
        { role: "assistant", text: "Latest answer", ts: 2_500 },
      ],
    });
    handler({
      type: "agent_message_snapshot",
      entries: [
        handoffFrame({
          messageId: "review-verdict:job-stale",
          status: "superseded",
          attempts: 0,
          createdAt: 1_000,
          updatedAt: 1_100,
        }),
      ],
    });

    expect(rt.pendingAgentHandoffs.value).toEqual([]);
    expect(rt.messages.value.map((message) => message.content)).toEqual([
      "Latest question",
      "Latest answer",
    ]);
  });

  it("updates a retried timeline handoff in place instead of duplicating into the pending inbox", () => {
    const { rt, handler } = setup();
    handler({
      type: "history",
      items: [
        {
          role: "user",
          text: "Verdict: INCOMPLETE on PR #687.",
          kind: "client_message_id:review-verdict:job-retry;prompt_meta:origin=agent",
          ts: 1_000,
        },
        { role: "user", text: "Later prompt", ts: 2_000, kind: "client_message_id:user-2" },
      ],
    });
    handler({
      type: "agent_message_snapshot",
      entries: [
        handoffFrame({
          messageId: "review-verdict:job-retry",
          status: "failed",
          attempts: 1,
          transitionRevision: 2,
          lastError: "model unavailable",
        }),
      ],
    });
    handler(handoffFrame({
      messageId: "review-verdict:job-retry",
      status: "pending",
      attempts: 1,
      transitionRevision: 3,
    }));

    expect(rt.pendingAgentHandoffs.value).toEqual([]);
    expect(rt.messages.value[0]?.id).toBe("review-verdict:job-retry");
    expect(rt.messages.value[0]?.agentHandoff?.status).toBe("pending");
  });

  it("inserts an unmatched non-superseded snapshot card chronologically rather than below newer messages", () => {
    const { rt, handler } = setup();
    handler({
      type: "history",
      items: [
        { role: "user", text: "Older prompt", ts: 1_000, kind: "client_message_id:u-1" },
        { role: "user", text: "Newer prompt", ts: 3_000, kind: "client_message_id:u-2" },
      ],
    });
    handler({
      type: "agent_message_snapshot",
      entries: [
        handoffFrame({
          messageId: "review-verdict:job-mid",
          status: "failed",
          attempts: 1,
          createdAt: 2_000,
          updatedAt: 2_050,
          lastError: "provider error",
        }),
      ],
    });

    expect(rt.messages.value.map((message) => message.id)).toEqual([
      "u-1",
      "review-verdict:job-mid",
      "u-2",
    ]);
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

  it("keeps persisted agent errors off the user retry path", () => {
    const { rt, handler } = setup();
    handler({
      type: "history",
      items: [
        {
          role: "user",
          text: "Reviewer handoff",
          kind: "client_message_id:review-verdict:job-1;prompt_meta:origin=agent",
          ts: 1,
        },
        {
          role: "status",
          text: "model unavailable",
          kind: "agent_message_error:review-verdict:job-1",
          ts: 2,
        },
      ],
    });

    expect(rt.messages.value.some((message) => message.kind === "agent_handoff")).toBe(true);
    expect(rt.messages.value.some((message) => message.role === "user")).toBe(false);
    expect(rt.messages.value.some((message) => message.kind === "error")).toBe(false);
  });
});
