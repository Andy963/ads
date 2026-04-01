import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { executeCommandLine } from "../../server/web/server/ws/commandExecution.js";

describe("web/ws/commandExecution", () => {
  it("records command results in history and refreshes workspace state", async () => {
    const sent: unknown[] = [];
    const workspaceStateCalls: Array<{ ws: unknown; workspaceRoot: string }> = [];
    const historyStore = new HistoryStore({ namespace: "test-command-execution", maxEntriesPerSession: 10 });
    const interruptControllers = new Map<string, AbortController>();
    const ws = { id: "ws-1" };

    try {
      await executeCommandLine({
        command: "ads task status",
        currentCwd: "/tmp/project",
        historyKey: "history-1",
        historyStore,
        interruptControllers,
        runAdsCommandLine: async () => ({ ok: false, output: "command failed" }),
        sendToCommandScope: (payload) => sent.push(payload),
        transport: {
          ws: ws as any,
          sendWorkspaceState: (ws, workspaceRoot) => workspaceStateCalls.push({ ws, workspaceRoot }),
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: () => {},
          logError: () => {},
        },
      });

      assert.deepEqual(sent, [{ type: "result", ok: false, output: "command failed" }]);
      assert.equal(historyStore.get("history-1").at(-1)?.role, "status");
      assert.equal(historyStore.get("history-1").at(-1)?.kind, "command");
      assert.deepEqual(workspaceStateCalls, [{ ws, workspaceRoot: "/tmp/project" }]);
      assert.equal(interruptControllers.has("history-1"), false);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("reports aborts immediately and removes the interrupt controller", async () => {
    const sent: unknown[] = [];
    const loggedErrors: string[] = [];
    const interruptControllers = new Map<string, AbortController>();
    let resolveRun: ((value: { ok: boolean; output: string }) => void) | null = null;
    let runStarted: (() => void) | null = null;

    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runPromise = new Promise<{ ok: boolean; output: string }>((resolve) => {
      resolveRun = resolve;
    });

    const execution = executeCommandLine({
      command: "sleep forever",
      currentCwd: "/tmp/project",
      historyKey: "history-2",
      historyStore: new HistoryStore({ namespace: "test-command-execution-abort", maxEntriesPerSession: 10 }),
      interruptControllers,
      runAdsCommandLine: async () => {
        runStarted?.();
        return await runPromise;
      },
      sendToCommandScope: (payload) => sent.push(payload),
      transport: {
        ws: {} as any,
        sendWorkspaceState: () => {
          throw new Error("aborted command should not refresh workspace state");
        },
      },
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: (text) => loggedErrors.push(text),
      },
    });

    await started;
    interruptControllers.get("history-2")?.abort();
    await execution;
    resolveRun?.({ ok: true, output: "late output" });

    assert.deepEqual(sent, [{ type: "error", message: "已中断，输出可能不完整" }]);
    assert.deepEqual(loggedErrors, ["已中断，输出可能不完整"]);
    assert.equal(interruptControllers.has("history-2"), false);
  });
});
