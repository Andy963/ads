import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import { executeCommandLine } from "../../server/web/server/ws/commandExecution.js";

describe("web/ws/commandExecution", () => {
  it("records successful command output as replayable execute history", async () => {
    const sent: unknown[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-execution-ok", maxEntriesPerSession: 10 });
    const interruptControllers = new Map<string, AbortController>();

    try {
      await executeCommandLine({
        command: "git status --short",
        currentCwd: "/tmp/project",
        historyKey: "history-ok",
        historyStore,
        interruptControllers,
        runAdsCommandLine: async () => ({ ok: true, output: "M file.ts\n" }),
        sendToCommandScope: (payload) => sent.push(payload),
        transport: {
          ws: {} as any,
          sendWorkspaceState: () => {},
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: () => {},
          logError: () => {},
        },
      });

      assert.deepEqual(sent, [
        {
          type: "result",
          ok: true,
          output: "M file.ts\n",
          kind: "execute",
          command: "git status --short",
        },
      ]);
      assert.deepEqual(
        historyStore.get("history-ok").map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "$ git status --short\nM file.ts", kind: "execute" }],
      );
    } finally {
      historyStore.clear("history-ok");
    }
  });

  it("records failed command results as replayable execute history and refreshes workspace state", async () => {
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

      assert.deepEqual(sent, [
        {
          type: "result",
          ok: false,
          output: "command failed",
          kind: "execute",
          command: "ads task status",
        },
      ]);
      assert.equal(historyStore.get("history-1").at(-1)?.role, "status");
      assert.equal(historyStore.get("history-1").at(-1)?.text, "$ ads task status\ncommand failed");
      assert.equal(historyStore.get("history-1").at(-1)?.kind, "execute");
      assert.deepEqual(workspaceStateCalls, [{ ws, workspaceRoot: "/tmp/project" }]);
      assert.equal(interruptControllers.has("history-1"), false);
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("reports aborts immediately and removes the interrupt controller", async () => {
    const sent: unknown[] = [];
    const loggedErrors: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-execution-abort", maxEntriesPerSession: 10 });
    const interruptControllers = new Map<string, AbortController>();
    let resolveRun: ((value: { ok: boolean; output: string }) => void) | null = null;
    let runStarted: (() => void) | null = null;

    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const runPromise = new Promise<{ ok: boolean; output: string }>((resolve) => {
      resolveRun = resolve;
    });

    try {
      const execution = executeCommandLine({
        command: "sleep forever",
        currentCwd: "/tmp/project",
        historyKey: "history-2",
        historyStore,
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
      assert.deepEqual(
        historyStore.get("history-2").map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "$ sleep forever\n已中断，输出可能不完整", kind: "execute" }],
      );
      assert.equal(interruptControllers.has("history-2"), false);
    } finally {
      historyStore.clear("history-2");
    }
  });

  it("records thrown command errors in history so reconnect replay explains the failed command", async () => {
    const sent: unknown[] = [];
    const loggedErrors: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-execution-error", maxEntriesPerSession: 10 });
    const interruptControllers = new Map<string, AbortController>();

    try {
      await executeCommandLine({
        command: "ads task status",
        currentCwd: "/tmp/project",
        historyKey: "history-3",
        historyStore,
        interruptControllers,
        runAdsCommandLine: async () => {
          throw new Error("command crashed");
        },
        sendToCommandScope: (payload) => sent.push(payload),
        transport: {
          ws: {} as any,
          sendWorkspaceState: () => {
            throw new Error("failed command should not refresh workspace state");
          },
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: () => {},
          logError: (text) => loggedErrors.push(text),
        },
      });

      assert.deepEqual(sent, [{ type: "error", message: "command crashed" }]);
      assert.deepEqual(loggedErrors, ["command crashed"]);
      assert.deepEqual(
        historyStore.get("history-3").map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "$ ads task status\ncommand crashed", kind: "execute" }],
      );
      assert.equal(interruptControllers.has("history-3"), false);
    } finally {
      historyStore.clear("history-3");
    }
  });
});
