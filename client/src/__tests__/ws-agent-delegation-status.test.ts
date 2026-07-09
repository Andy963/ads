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
    threadWarning: { value: null } satisfies Ref<string | null>,
    workspacePath: { value: "" } satisfies Ref<string>,
    resumeReplacePending: false,
  };
}

function createHandler(rt: any, overrides: Record<string, unknown> = {}) {
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
    applyResumeHistory: vi.fn(),
    cancelPendingResume: vi.fn(),
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
    ...overrides,
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

  it("does not render raw originalError details in classified errors", () => {
    const rt = createRuntime();
    const pushMessageBeforeLive = vi.fn();
    const handler = createHandler(rt, { pushMessageBeforeLive });

    handler({
      type: "error",
      message: "API 请求频率过高，请稍后重试",
      errorInfo: {
        code: "rate_limit",
        retryable: true,
        needsReset: false,
        originalError: '{"type":"system","subtype":"api_retry","attempt":10}',
      },
    });

    const pushed = pushMessageBeforeLive.mock.calls[0]?.[0] as { content?: string } | undefined;
    expect(pushed?.content).toContain("API 请求频率过高，请稍后重试");
    expect(pushed?.content).toContain("错误类型: rate_limit");
    expect(pushed?.content).not.toContain("详细信息");
    expect(pushed?.content).not.toContain("api_retry");
  });
});

