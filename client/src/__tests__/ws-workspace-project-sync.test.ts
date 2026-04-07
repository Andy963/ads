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
    boundReviewSnapshotId: { value: null } satisfies Ref<string | null>,
    latestReviewArtifact: { value: null } satisfies Ref<any>,
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

  const clearPendingPrompt = vi.fn();
  const clearStepLive = vi.fn();
  const finalizeCommandBlock = vi.fn();

  const threadReset = vi.fn((targetRt: any, params: { resetThreadId?: boolean }) => {
    if (params.resetThreadId) {
      targetRt.activeThreadId.value = null;
    }
  });

  const handler = createWsMessageHandler({
    projects: { value: args.projects },
    pid: args.pid,
    rt: args.rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId,

    updateProject: args.updateProject,
    applyResumeHistory: vi.fn(),
    cancelPendingResume: vi.fn(),
    clearPendingPrompt,
    clearStepLive,
    commandKeyForWsEvent: () => null,
    finalizeAssistant: vi.fn(),
    finalizeCommandBlock,
    flushQueuedPrompts: vi.fn(),
    ingestCommand: vi.fn(),
    ingestCommandActivity: vi.fn(),
    ingestExploredActivity: vi.fn(),
    pushMessageBeforeLive: vi.fn(),
    shouldIgnoreStepDelta: () => false,
    threadReset,
    upsertExecuteBlock: vi.fn(),
    upsertLiveActivity: vi.fn(),
    upsertStepLiveDelta: vi.fn(),
    upsertStreamingDelta: vi.fn(),
  });

  return { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock };
}

describe("ws workspace project sync", () => {
  it("keeps the synthetic default project rooted externally while still recording workspace state", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler } = createHandler({
      projects: [
        {
          id: "default",
          path: "/home/andy",
          name: "andy",
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
      branch: "main",
    });
  });

  it("clears pending cd marker and keeps non-default project path on workspace event", () => {
    const rt = createRuntime();
    rt.pendingCdRequestedPath = "/tmp/backend";
    const updateProject = vi.fn();
    const { handler } = createHandler({
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

  it("treats fresh welcome as authoritative even when a thread id is unexpectedly present", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "stale" }];
    rt.activeThreadId.value = "thread-stale";
    const updateProject = vi.fn();
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-unexpected",
      contextMode: "fresh",
    });

    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "welcome_fresh_context",
        resetThreadId: true,
      }),
    );
    expect(rt.activeThreadId.value).toBeNull();
  });

  it("preserves resumed and history injection welcome behavior", () => {
    const resumedRt = createRuntime();
    resumedRt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    resumedRt.activeThreadId.value = "thread-local";
    const resumed = createHandler({
      projects: [],
      pid: "default",
      rt: resumedRt,
      updateProject: vi.fn(),
    });

    resumed.handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-resumed",
      contextMode: "thread_resumed",
    });

    expect(resumed.threadReset).not.toHaveBeenCalled();
    expect(resumedRt.messages.value.map((entry: any) => entry.content)).toEqual(["keep me"]);
    expect(resumedRt.activeThreadId.value).toBe("thread-resumed");

    const injectedRt = createRuntime();
    injectedRt.messages.value = [{ id: "u2", role: "user", kind: "text", content: "keep me too" }];
    injectedRt.activeThreadId.value = "thread-local";
    const injected = createHandler({
      projects: [],
      pid: "default",
      rt: injectedRt,
      updateProject: vi.fn(),
    });

    injected.handler({
      type: "welcome",
      inFlight: false,
      threadId: null,
      contextMode: "history_injection",
    });

    expect(injected.threadReset).not.toHaveBeenCalled();
    expect(injectedRt.messages.value.map((entry: any) => entry.content)).toEqual(["keep me too"]);
    expect(injectedRt.activeThreadId.value).toBeNull();
  });

  it("clears stale local continuity when a sibling connection resets the same chat lane", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "stale" }];
    rt.activeThreadId.value = "thread-stale";
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.turnHasPatch = true;
    rt.delegationsInFlight.value = [{ id: "delegation-1" }];
    rt.pendingAckClientMessageId = "ack-1";
    rt.queuedPrompts.value = ["queued"];
    const updateProject = vi.fn();
    const { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({ type: "session_reset", source: "clear_history", sourceChatSessionId: "main" });

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.turnHasPatch).toBe(false);
    expect(rt.delegationsInFlight.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(clearPendingPrompt).toHaveBeenCalledWith(rt);
    expect(clearStepLive).toHaveBeenCalledWith(rt);
    expect(finalizeCommandBlock).toHaveBeenCalledWith(rt);
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
  });

  it("clears stale local continuity when a sibling chat lane resets the shared session", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    rt.activeThreadId.value = "thread-keep";
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.queuedPrompts.value = ["queued"];
    const { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({ type: "session_reset", source: "clear_history", sourceChatSessionId: "planner" });

    expect(clearPendingPrompt).toHaveBeenCalledWith(rt);
    expect(clearStepLive).toHaveBeenCalledWith(rt);
    expect(finalizeCommandBlock).toHaveBeenCalledWith(rt);
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.activeThreadId.value).toBeNull();
  });

  it("preserves reviewer snapshot bindings while clearing reviewer chat continuity after a sibling lane reset", () => {
    const rt = createRuntime();
    rt.chatSessionId = "reviewer";
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "review this" }];
    rt.activeThreadId.value = "reviewer-thread";
    rt.boundReviewSnapshotId.value = "snapshot-9";
    rt.latestReviewArtifact.value = { id: "artifact-1", snapshotId: "snapshot-9" };
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "session_reset",
      source: "clear_history",
      sourceChatSessionId: "main",
      preservedReviewerSnapshotId: "snapshot-9",
    });

    expect(rt.boundReviewSnapshotId.value).toBe("snapshot-9");
    expect(rt.latestReviewArtifact.value).toEqual({ id: "artifact-1", snapshotId: "snapshot-9" });
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        resetThreadId: true,
      }),
    );
  });

  it("clears reviewer snapshot bindings when reviewer clear_history was broadcast without preservation", () => {
    const rt = createRuntime();
    rt.chatSessionId = "reviewer";
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "review this" }];
    rt.activeThreadId.value = "reviewer-thread";
    rt.boundReviewSnapshotId.value = "snapshot-9";
    rt.latestReviewArtifact.value = { id: "artifact-1", snapshotId: "snapshot-9" };
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "session_reset",
      source: "clear_history",
      sourceChatSessionId: "reviewer",
      preservedReviewerSnapshotId: null,
    });

    expect(rt.boundReviewSnapshotId.value).toBeNull();
    expect(rt.latestReviewArtifact.value).toBeNull();
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        resetThreadId: true,
      }),
    );
  });

  it("keeps result-driven thread resets local-only instead of clearing backend history again", () => {
    const rt = createRuntime();
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadReset: true,
      threadId: "thread-new",
      expectedThreadId: "thread-new",
    });

    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "result_thread_reset",
        keepLatestTurn: true,
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
  });
});
