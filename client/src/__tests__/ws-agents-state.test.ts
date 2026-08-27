import { describe, expect, it, vi } from "vitest";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type Ref<T> = { value: T };

function createRuntime(): any {
  return {
    busy: { value: false } satisfies Ref<boolean>,
    turnInFlight: false,
    turnHasPatch: false,
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
    availableAgents: { value: [] } satisfies Ref<any[]>,
    activeAgentId: { value: "" } satisfies Ref<string>,
    resumeReplacePending: false,
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

describe("ws agents snapshot", () => {
  it("updates active agent + available agents list", () => {
    const rt = createRuntime();
    const handler = createHandler(rt);

    handler({
      type: "agents",
      activeAgentId: "gemini",
      agents: [
        { id: "codex", name: "Codex", ready: true },
        { id: "gemini", name: "Gemini", ready: false, error: "missing api key" },
      ],
      threadId: "thread-123",
    });

    expect(rt.activeAgentId.value).toBe("gemini");
    expect(rt.availableAgents.value.length).toBe(2);
    expect(rt.availableAgents.value[0].id).toBe("codex");
    expect(rt.availableAgents.value[1].ready).toBe(false);
    expect(rt.activeThreadId.value).toBe("thread-123");
  });

  it("falls back to the first ready agent when the active agent is omitted or unavailable", () => {
    const rt = createRuntime();
    const handler = createHandler(rt);

    handler({
      type: "agents",
      agents: [
        { id: "codex", name: "Codex", ready: false, error: "missing api key" },
        { id: "claude", name: "Claude", ready: true },
      ],
    });

    expect(rt.activeAgentId.value).toBe("claude");

    rt.activeAgentId.value = "codex";
    handler({
      type: "agents",
      agents: [
        { id: "codex", name: "Codex", ready: false, error: "missing api key" },
        { id: "claude", name: "Claude", ready: true },
      ],
    });

    expect(rt.activeAgentId.value).toBe("claude");
  });

  it("ignores persisted agent snapshots replayed from the sync log", () => {
    const rt = createRuntime();
    const handler = createHandler(rt);

    handler({
      type: "agents",
      activeAgentId: "droid",
      agents: [
        { id: "codex", name: "Codex", ready: true },
        { id: "droid", name: "Droid", ready: true },
      ],
    });
    handler({
      type: "agents",
      seq: 42,
      activeAgentId: "codex",
      agents: [{ id: "codex", name: "Codex", ready: true }],
    });

    expect(rt.activeAgentId.value).toBe("droid");
    expect(rt.availableAgents.value.map((agent: { id: string }) => agent.id)).toEqual(["codex", "droid"]);
  });
});
