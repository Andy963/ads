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
    availableAgents: { value: [] } satisfies Ref<any[]>,
    activeAgentId: { value: "" } satisfies Ref<string>,
    taskBundleDrafts: { value: [] } satisfies Ref<any[]>,
    queuedPrompts: { value: [] } satisfies Ref<string[]>,
    threadWarning: { value: null } satisfies Ref<string | null>,
    chatSessionId: "main",
    ignoreNextHistory: false,
    resumeReplacePending: false,
  };
}

function createHandler(args: { projects: any[]; pid: string; rt: any; updateProject: ReturnType<typeof vi.fn> }) {
  const randomId = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}-${++n}`;
  })();

  return createWsMessageHandler({
    projects: { value: args.projects },
    pid: args.pid,
    rt: args.rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId,

    updateProject: args.updateProject,
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

describe("ws workspace project sync", () => {
  it("syncs default project from welcome workspace payload", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const handler = createHandler({
      projects: [
        {
          id: "default",
          path: "",
          name: "Workspace",
          sessionId: "default",
          chatSessionId: "main",
          initialized: false,
          createdAt: 1,
          updatedAt: 1,
          expanded: false,
        },
      ],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "welcome",
      inFlight: false,
      workspace: {
        path: "/tmp/demo-project",
        branch: "main",
      },
    });

    expect(rt.workspacePath.value).toBe("/tmp/demo-project");
    expect(updateProject).toHaveBeenCalledWith("default", {
      initialized: true,
      path: "/tmp/demo-project",
      name: "demo-project",
      branch: "main",
    });
  });

  it("clears pending cd marker and keeps non-default project path on workspace event", () => {
    const rt = createRuntime();
    rt.pendingCdRequestedPath = "/tmp/backend";
    const updateProject = vi.fn();
    const handler = createHandler({
      projects: [
        {
          id: "p1",
          path: "/tmp/backend",
          name: "Backend",
          sessionId: "p1",
          chatSessionId: "main",
          initialized: false,
          createdAt: 1,
          updatedAt: 1,
          expanded: true,
        },
      ],
      pid: "p1",
      rt,
      updateProject,
    });

    handler({
      type: "workspace",
      data: {
        path: "/tmp/backend",
        branch: "feature-x",
      },
    });

    expect(rt.pendingCdRequestedPath).toBeNull();
    expect(updateProject).toHaveBeenCalledWith("p1", {
      initialized: true,
      branch: "feature-x",
    });
  });
});
