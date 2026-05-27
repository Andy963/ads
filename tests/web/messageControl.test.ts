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

  it("clears only the current lane by default for clear_history", async () => {
    const sent: unknown[] = [];
    const broadcasted: unknown[] = [];
    let sharedResetCalls = 0;
    let localHistoryClears = 0;
    let localSessionResets = 0;
    let aborted = 0;
    const controller = new AbortController();
    controller.abort = () => {
      aborted += 1;
    };
    const promptRunEpochs = new Map<string, number>([["history-1", 1]]);

    const clearedHistory = await handleWsControlMessage({
      parsed: { type: "clear_history" },
      chatSessionId: "planner",
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {
        reset: () => {
          localSessionResets += 1;
        },
      } as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: {
        clear: () => {
          localHistoryClears += 1;
        },
      },
      interruptControllers: new Map([["history-1", controller]]),
      promptRunEpochs,
      ensureTaskContext: (() => ({})) as any,
      sendJson: (payload) => sent.push(payload),
      broadcastSessionReset: (payload) => broadcasted.push(payload),
      resetSharedSessionState: () => {
        sharedResetCalls += 1;
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(clearedHistory.handled, true);
    assert.equal(aborted, 1);
    assert.equal(sharedResetCalls, 0);
    assert.equal(localHistoryClears, 1);
    assert.equal(localSessionResets, 1);
    assert.equal(promptRunEpochs.get("history-1"), 2);
    assert.deepEqual(broadcasted, [
      { type: "session_reset", source: "clear_history", sourceChatSessionId: "planner", scope: "lane" },
    ]);
    assert.deepEqual(sent[0], {
      type: "result",
      ok: true,
      output: "已清空历史缓存并重置会话",
      kind: "clear_history",
    });
  });

  it("uses shared reset only when clear_history explicitly requests shared scope", async () => {
    const sent: unknown[] = [];
    const broadcasted: unknown[] = [];
    const sharedResetOptions: Array<{ sourceChatSessionId: string }> = [];
    let localHistoryClears = 0;
    let localSessionResets = 0;

    const clearedHistory = await handleWsControlMessage({
      parsed: { type: "clear_history", payload: { scope: "shared" } },
      chatSessionId: "planner",
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      sessionManager: {
        reset: () => {
          localSessionResets += 1;
        },
      } as any,
      orchestrator: { id: "orch" } as any,
      getWorkspaceLock: (() => null) as any,
      historyStore: {
        clear: () => {
          localHistoryClears += 1;
        },
      },
      ensureTaskContext: (() => ({})) as any,
      sendJson: (payload) => sent.push(payload),
      broadcastSessionReset: (payload) => broadcasted.push(payload),
      resetSharedSessionState: (options) => {
        sharedResetOptions.push(options);
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.equal(clearedHistory.handled, true);
    assert.deepEqual(sharedResetOptions, [{ sourceChatSessionId: "planner" }]);
    assert.equal(localHistoryClears, 0);
    assert.equal(localSessionResets, 0);
    assert.deepEqual(broadcasted, [
      { type: "session_reset", source: "clear_history", sourceChatSessionId: "planner", scope: "shared" },
    ]);
    assert.deepEqual(sent[0], {
      type: "result",
      ok: true,
      output: "已清空历史缓存并重置会话",
      kind: "clear_history",
    });
  });

});
