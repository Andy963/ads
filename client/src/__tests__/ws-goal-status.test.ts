import { describe, expect, it, vi } from "vitest";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type Ref<T> = { value: T };

function createRuntime(tasks: any[] = []): any {
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
    availableAgents: { value: [] } satisfies Ref<any[]>,
    activeAgentId: { value: "" } satisfies Ref<string>,
    resumeReplacePending: false,
    tasks: { value: tasks } satisfies Ref<any[]>,
  };
}

function makeHandler(rt: any) {
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
  });
}

function makeTask(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: "t",
    prompt: "p",
    model: "auto",
    status: "running",
    priority: 0,
    queueOrder: 0,
    inheritContext: false,
    agentId: "codex",
    retryCount: 0,
    maxRetries: 0,
    createdAt: 0,
    goalMode: true,
    ...overrides,
  };
}

describe("ws goal:status / goal:cleared", () => {
  it("updates the task's goal fields on goal:status", () => {
    const rt = createRuntime([makeTask("t1")]);
    const handler = makeHandler(rt);

    handler({
      type: "goal:status",
      data: {
        taskId: "t1",
        status: "active",
        tokensUsed: 100,
        timeUsedSeconds: 5,
        tokenBudget: 500,
        objective: "do X",
      },
    });

    expect(rt.tasks.value[0].goalStatus).toBe("active");
    expect(rt.tasks.value[0].goalTokensUsed).toBe(100);
    expect(rt.tasks.value[0].goalTimeUsedSeconds).toBe(5);
    expect(rt.tasks.value[0].goalTokenBudget).toBe(500);
    expect(rt.tasks.value[0].goalObjective).toBe("do X");
  });

  it("ignores goal:status for unknown task ids", () => {
    const rt = createRuntime([makeTask("t1", { goalStatus: "active" })]);
    const handler = makeHandler(rt);

    handler({
      type: "goal:status",
      data: { taskId: "unknown", status: "paused", tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null },
    });

    expect(rt.tasks.value[0].goalStatus).toBe("active");
  });

  it("clears goal fields on goal:cleared", () => {
    const rt = createRuntime([
      makeTask("t1", { goalStatus: "active", goalTokensUsed: 50, goalTimeUsedSeconds: 3 }),
    ]);
    const handler = makeHandler(rt);

    handler({ type: "goal:cleared", data: { taskId: "t1" } });

    expect(rt.tasks.value[0].goalStatus).toBeNull();
    expect(rt.tasks.value[0].goalTokensUsed).toBeNull();
    expect(rt.tasks.value[0].goalTimeUsedSeconds).toBeNull();
  });
});
