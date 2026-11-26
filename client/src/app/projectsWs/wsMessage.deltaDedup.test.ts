import { describe, expect, it, vi } from "vitest";

import { createAppContext, type AppContext } from "../controller";
import { createChatActions } from "../chat";
import type { ProjectRuntime } from "../controllerTypes";

import { createWsMessageHandler } from "./wsMessage";

function setup(): {
  rt: ProjectRuntime;
  handler: (msg: unknown) => void;
} {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = ctx.getAcopilotRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = "acopilot";
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    preferenceLane: "acopilot",
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
    sealActiveStreamingAssistant: chat.sealActiveStreamingAssistant,
    threadReset: chat.threadReset,
    upsertExecuteBlock: chat.upsertExecuteBlock,
    upsertLiveActivity: chat.upsertLiveActivity,
    upsertStreamingDelta: chat.upsertStreamingDelta,
    replaceStreamingText: chat.replaceStreamingText,
  });
  return { rt, handler };
}

describe("Acopilot delta, delta_snapshot, and result deduplication", () => {
  it("skips a catch-up delta_snapshot whose endOffset was already rendered via live delta even when previousRevision is 0 and clientMessageId is absent", () => {
    const { rt, handler } = setup();
    const phase1 = "Phase 1: checking repository state.";
    const phase2 = "Phase 2: preparing implementation patch.";

    handler({
      type: "user",
      clientMessageId: "turn-1",
      text: "fix issue #715",
      ts: 1_000,
      kind: "client_message_id:turn-1",
    });
    handler({
      type: "delta",
      delta: phase1,
      assistantItemId: "msg-1",
      streamId: "stream:lane:tok:1",
      startOffset: 0,
      endOffset: phase1.length,
      ts: 1_001,
    });
    handler({
      type: "command",
      command: { id: "cmd-1", command: "git status", status: "completed", outputDelta: "clean\n" },
      ts: 1_002,
    });
    handler({
      type: "delta",
      delta: phase2,
      assistantItemId: "msg-2",
      streamId: "stream:lane:tok:2",
      startOffset: 0,
      endOffset: phase2.length,
      ts: 1_003,
    });
    handler({
      type: "command",
      command: { id: "cmd-2", command: "cargo test", status: "completed", outputDelta: "ok\n" },
      ts: 1_004,
    });

    // Replayed delta_snapshot arrives with revision=5 after live delta already reached the same endOffset.
    handler({
      type: "delta_snapshot",
      text: phase2,
      assistantItemId: "msg-2",
      streamId: "stream:lane:tok:2",
      revision: 5,
      startOffset: 0,
      endOffset: phase2.length,
      active: false,
      ts: 1_003,
    });

    const assistantTexts = rt.messages.value
      .filter((message) => message.role === "assistant" && message.kind === "text")
      .map((message) => message.content);
    expect(assistantTexts).toEqual([phase1, phase2]);
  });

  it("deduplicates replayed delta_snapshot by clientMessageId and assistantItemId across command blocks even after stream offset reset", () => {
    const { rt, handler } = setup();
    const phase1 = "Inspecting tests and server state.";

    handler({
      type: "user",
      clientMessageId: "turn-2",
      text: "run checks",
      ts: 2_000,
      kind: "client_message_id:turn-2",
    });
    handler({
      type: "delta",
      clientMessageId: "turn-2",
      assistantItemId: "msg-phase-1",
      delta: phase1,
      streamId: "stream:lane:tok:10",
      startOffset: 0,
      endOffset: phase1.length,
      ts: 2_001,
    });
    handler({
      type: "command",
      command: { id: "cmd-10", command: "cargo test", status: "completed", outputDelta: "ok\n" },
      ts: 2_002,
    });

    // Simulate reconnect clearing stream offset caches before replay.
    rt.streamEndOffsets?.clear();
    rt.streamSnapshotRevisions?.clear();

    handler({
      type: "delta_snapshot",
      clientMessageId: "turn-2",
      assistantItemId: "msg-phase-1",
      text: phase1,
      streamId: "stream:lane:tok:10",
      revision: 3,
      startOffset: 0,
      endOffset: phase1.length,
      active: false,
      ts: 2_001,
    });

    const assistantMessages = rt.messages.value.filter(
      (message) => message.role === "assistant" && message.kind === "text",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe(phase1);
    expect(assistantMessages[0]?.streaming).toBe(false);
  });

  it("reconciles multi-phase live deltas and terminal result into single sealed bubbles without duplicates", () => {
    const { rt, handler } = setup();
    const commentary = "Checking the implementation first.";
    const finalAnswer = "All fixes are verified and ready.";

    handler({
      type: "user",
      clientMessageId: "turn-3",
      text: "implement fix",
      ts: 3_000,
      kind: "client_message_id:turn-3",
    });
    handler({
      type: "delta",
      clientMessageId: "turn-3",
      assistantItemId: "msg-commentary",
      delta: commentary,
      streamId: "stream:lane:tok:20",
      startOffset: 0,
      endOffset: commentary.length,
      ts: 3_001,
    });
    handler({
      type: "command",
      command: { id: "cmd-20", command: "npm test", status: "completed", outputDelta: "pass\n" },
      ts: 3_002,
    });
    handler({
      type: "delta",
      clientMessageId: "turn-3",
      assistantItemId: "msg-final",
      delta: finalAnswer,
      streamId: "stream:lane:tok:21",
      startOffset: 0,
      endOffset: finalAnswer.length,
      ts: 3_003,
    });
    handler({
      type: "result",
      ok: true,
      clientMessageId: "turn-3",
      output: finalAnswer,
      assistantItems: [{ id: "msg-final", text: finalAnswer }],
      ts: 3_004,
    });

    const assistantMessages = rt.messages.value.filter(
      (message) => message.role === "assistant" && message.kind === "text",
    );
    expect(assistantMessages.map((message) => message.content)).toEqual([commentary, finalAnswer]);
    expect(assistantMessages.every((message) => message.streaming === false)).toBe(true);
  });
});
