import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ensureWsSessionLogger, handleWsControlMessage } from "../../server/web/server/ws/messageControl.js";

describe("web/ws/messageControl", () => {
  it("returns null and warns when session logger initialization fails", () => {
    const warnings: string[] = [];
    const logger = ensureWsSessionLogger({
      sessionManager: {
        ensureLogger: () => {
          throw new Error("boom");
        },
      } as any,
      userId: 7,
      warn: (message) => warnings.push(message),
    });

    assert.equal(logger, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Failed to initialize session logger/);
  });

  it("handles clear_history and reviewer read-only control messages", async () => {
    const sent: unknown[] = [];
    const broadcasted: unknown[] = [];
    let sharedResetCalls = 0;
    const sharedResetOptions: Array<{ sourceChatSessionId: string; reviewerSnapshotIdToPreserve: string | null }> = [];
    const bindings = new Map([["history-1", "snap-1"]]);
    let aborted = 0;
    const controller = new AbortController();
    controller.abort = () => {
      aborted += 1;
    };
    const promptRunEpochs = new Map<string, number>([["history-1", 1]]);

    const clearedHistory = await handleWsControlMessage({
      parsed: { type: "clear_history" },
      chatSessionId: "planner",
      isReviewerChat: true,
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {} as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: {
        clear: () => {},
      },
      interruptControllers: new Map([["history-1", controller]]),
      promptRunEpochs,
      reviewerSnapshotBindings: bindings,
      ensureTaskContext: (() => ({})) as any,
      sendJson: (payload) => sent.push(payload),
      broadcastSessionReset: (payload) => broadcasted.push(payload),
      resetSharedSessionState: (options) => {
        sharedResetCalls += 1;
        sharedResetOptions.push(options);
        bindings.delete("history-1");
        return { preservedReviewerSnapshotId: null };
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(clearedHistory.handled, true);
    assert.equal(aborted, 1);
    assert.equal(bindings.has("history-1"), false);
    assert.equal(sharedResetCalls, 1);
    assert.deepEqual(sharedResetOptions, [{ sourceChatSessionId: "planner", reviewerSnapshotIdToPreserve: null }]);
    assert.equal(promptRunEpochs.get("history-1"), 2);
    assert.deepEqual(broadcasted, [
      { type: "session_reset", source: "clear_history", sourceChatSessionId: "planner", preservedReviewerSnapshotId: null },
    ]);
    assert.deepEqual(sent[0], {
      type: "result",
      ok: true,
      output: "已清空历史缓存并重置会话",
      kind: "clear_history",
    });

    const reviewerGuard = await handleWsControlMessage({
      parsed: { type: "command", payload: "ls" },
      chatSessionId: "reviewer",
      isReviewerChat: true,
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {} as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: { clear: () => {} },
      reviewerSnapshotBindings: new Map(),
      ensureTaskContext: (() => ({})) as any,
      sendJson: (payload) => sent.push(payload),
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(reviewerGuard.handled, true);
    assert.deepEqual(sent[1], {
      type: "error",
      message: "Reviewer lane is read-only and does not accept commands.",
    });
  });

  it("preserves the existing reviewer snapshot binding only when clear_history explicitly requests the same snapshot", async () => {
    const sent: unknown[] = [];
    const broadcasted: unknown[] = [];
    const bindings = new Map([["history-1", "snap-1"]]);
    const preserved: Array<{ userId: number; snapshotId: string }> = [];
    const clearedSaved: number[] = [];

    await handleWsControlMessage({
      parsed: { type: "clear_history", payload: { preserveReviewerSnapshotId: "snap-1" } },
      chatSessionId: "reviewer",
      isReviewerChat: true,
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {
        reset: () => {},
        getSavedReviewerSnapshotId: () => undefined,
        clearSavedReviewerSnapshotBinding: (userId: number) => clearedSaved.push(userId),
        saveReviewerSnapshotBinding: (userId: number, snapshotId: string) => preserved.push({ userId, snapshotId }),
      } as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: { clear: () => {} } as any,
      reviewerSnapshotBindings: bindings,
      ensureTaskContext: ((workspaceRoot: string) => ({
        reviewStore: {
          getSnapshot: (snapshotId: string) => (workspaceRoot === "/tmp/project" && snapshotId === "snap-1" ? { id: snapshotId } : null),
        },
      })) as any,
      sendJson: (payload) => sent.push(payload),
      broadcastSessionReset: (payload) => broadcasted.push(payload),
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(bindings.get("history-1"), "snap-1");
    assert.deepEqual(clearedSaved, [7]);
    assert.deepEqual(preserved, [{ userId: 7, snapshotId: "snap-1" }]);
    assert.deepEqual(broadcasted, [
      {
        type: "session_reset",
        source: "clear_history",
        sourceChatSessionId: "reviewer",
        preservedReviewerSnapshotId: "snap-1",
      },
    ]);
    assert.deepEqual(sent[0], {
      type: "result",
      ok: true,
      output: "已清空历史缓存并重置会话",
      kind: "clear_history",
    });

    bindings.set("history-1", "snap-1");
    preserved.length = 0;

    await handleWsControlMessage({
      parsed: { type: "clear_history", payload: { preserveReviewerSnapshotId: "snap-2" } },
      chatSessionId: "reviewer",
      isReviewerChat: true,
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {
        reset: () => {},
        getSavedReviewerSnapshotId: () => undefined,
        clearSavedReviewerSnapshotBinding: () => {},
        saveReviewerSnapshotBinding: (userId: number, snapshotId: string) => preserved.push({ userId, snapshotId }),
      } as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: { clear: () => {} } as any,
      reviewerSnapshotBindings: bindings,
      ensureTaskContext: ((workspaceRoot: string) => ({
        reviewStore: {
          getSnapshot: (snapshotId: string) => (workspaceRoot === "/tmp/project" && snapshotId === "snap-2" ? { id: snapshotId } : null),
        },
      })) as any,
      sendJson: () => {},
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(bindings.has("history-1"), false);
    assert.deepEqual(preserved, []);
  });
});
