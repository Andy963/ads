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
    const cleared: string[] = [];
    const reset: number[] = [];
    const bindings = new Map([["history-1", "snap-1"]]);

    const clearedHistory = await handleWsControlMessage({
      parsed: { type: "clear_history" },
      isReviewerChat: true,
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {
        reset: (userId: number) => reset.push(userId),
      } as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: {
        clear: (key: string) => cleared.push(key),
      },
      reviewerSnapshotBindings: bindings,
      ensureTaskContext: (() => ({})) as any,
      sendJson: (payload) => sent.push(payload),
      logger: { warn: () => {} },
    });

    assert.equal(clearedHistory.handled, true);
    assert.equal(bindings.has("history-1"), false);
    assert.deepEqual(cleared, ["history-1"]);
    assert.deepEqual(reset, [7]);
    assert.deepEqual(sent[0], {
      type: "result",
      ok: true,
      output: "已清空历史缓存并重置会话",
      kind: "clear_history",
    });

    const reviewerGuard = await handleWsControlMessage({
      parsed: { type: "command", payload: "ls" },
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
      logger: { warn: () => {} },
    });

    assert.equal(reviewerGuard.handled, true);
    assert.deepEqual(sent[1], {
      type: "error",
      message: "Reviewer lane is read-only and does not accept commands.",
    });
  });
});
