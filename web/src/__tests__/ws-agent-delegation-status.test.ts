import { describe, expect, it, vi } from "vitest";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type Ref<T> = { value: T };

function createRuntime(): any {
  return {
    busy: { value: false } satisfies Ref<boolean>,
    turnInFlight: false,
    turnHasPatch: false,
    delegationsInFlight: { value: [] } satisfies Ref<any[]>,
    pendingAckClientMessageId: null,
    suppressNextClearHistoryResult: false,
    pendingCdRequestedPath: null,
    messages: { value: [] } satisfies Ref<any[]>,
    turnCommands: [],
    recentCommands: { value: [] } satisfies Ref<string[]>,
    executePreviewByKey: new Map(),
    executeOrder: [],
    seenCommandIds: new Set<string>(),
    liveActivity: {},
    activeThreadId: { value: null } satisfies Ref<string | null>,
    workspacePath: { value: "" } satisfies Ref<string>,
  };
}

function createHandler(rt: any) {
  const randomId = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}-${++n}`;
  })();

  return createWsMessageHandler({
    projects: { value: [] },
    pid: "default",
    rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId,

    updateProject: vi.fn(),
    applyMergedHistory: vi.fn(),
    clearPendingPrompt: vi.fn(),
    clearStepLive: vi.fn(),
    commandKeyForWsEvent: () => null,
    finalizeAssistant: vi.fn(),
    finalizeCommandBlock: vi.fn(),
    flushQueuedPrompts: vi.fn(),
    ingestCommand: vi.fn(),
    ingestCommandActivity: vi.fn(),
    ingestExploredActivity: vi.fn(),
    pushMessageBeforeLive: vi.fn(),
    shouldIgnoreStepDelta: () => false,
    threadReset: vi.fn(),
    upsertExecuteBlock: vi.fn(),
    upsertLiveActivity: vi.fn(),
    upsertStepLiveDelta: vi.fn(),
    upsertStreamingDelta: vi.fn(),
  });
}

describe("ws agent delegation status", () => {
  it("tracks delegations in-flight via agent start/result messages", () => {
    const rt = createRuntime();
    const handler = createHandler(rt);

    handler({
      type: "agent",
      event: "delegation:start",
      delegationId: "d1",
      agentId: "gemini",
      agentName: "Gemini",
      prompt: "do the thing",
      ts: Date.now(),
    });

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.delegationsInFlight.value.length).toBe(1);
    expect(rt.delegationsInFlight.value[0].id).toBe("d1");

    handler({
      type: "agent",
      event: "delegation:result",
      delegationId: "d1",
      agentId: "gemini",
      agentName: "Gemini",
      prompt: "do the thing",
      ts: Date.now(),
    });

    expect(rt.delegationsInFlight.value.length).toBe(0);
  });

  it("clears delegation state when a turn completes", () => {
    const rt = createRuntime();
    const handler = createHandler(rt);

    handler({
      type: "agent",
      event: "delegation:start",
      delegationId: "d2",
      agentId: "gemini",
      agentName: "Gemini",
      prompt: "work",
      ts: Date.now(),
    });

    expect(rt.delegationsInFlight.value.length).toBe(1);

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadId: "t1",
    });

    expect(rt.delegationsInFlight.value.length).toBe(0);
  });
});

