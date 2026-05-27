import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../../server/utils/historyStore.js";
import {
  handleBuiltinCommand,
  isBlockedUserSlashCommand,
  parseCommandRequest,
} from "../../server/web/server/ws/commandBuiltins.js";

function sanitizeCommandPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && "command" in (payload as Record<string, unknown>)) {
    return String((payload as Record<string, unknown>).command ?? "");
  }
  return "";
}

describe("web/ws/commandBuiltins", () => {
  it("parses silent cd commands and suppresses chat broadcast", () => {
    const parsed = parseCommandRequest({
      payload: { command: "/cd next", silent: true },
      sanitizeInput: sanitizeCommandPayload,
    });

    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.equal(parsed.request.command, "/cd next");
    assert.equal(parsed.request.normalizedSlash, "cd");
    assert.equal(parsed.request.isSilentCommandPayload, true);
    assert.equal(parsed.request.shouldBroadcast, false);
  });

  it("handles pwd locally and records a status history entry", () => {
    const sent: unknown[] = [];
    const logged: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-builtins", maxEntriesPerSession: 10 });

    try {
      const result = handleBuiltinCommand({
        request: {
          command: "/pwd",
          slash: { command: "pwd", body: "" },
          normalizedSlash: "pwd",
          isSilentCommandPayload: false,
          shouldBroadcast: true,
        },
        userId: 7,
        historyKey: "history-1",
        currentCwd: "/tmp/project",
        orchestrator: { id: "orch" } as any,
        state: {} as any,
        sessionManager: {} as any,
        historyStore,
        sendToCommandScope: (payload) => sent.push(payload),
        transport: {
          ws: {} as any,
          sendWorkspaceState: () => {
            throw new Error("pwd should not emit workspace state");
          },
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: (text) => logged.push(text),
          logError: () => {},
        },
        syncWorkspaceTemplates: () => {},
      });

      assert.equal(result.handled, true);
      assert.deepEqual(sent, [{ type: "result", ok: true, output: "当前工作目录: /tmp/project" }]);
      assert.deepEqual(logged, ["当前工作目录: /tmp/project"]);
      assert.equal(historyStore.get("history-1").at(-1)?.kind, "status");
      assert.equal(historyStore.get("history-1").at(-1)?.text, "当前工作目录: /tmp/project");
    } finally {
      historyStore.clear("history-1");
    }
  });

  it("resumes saved continuity when /cd recreates an idle-evicted runtime session", () => {
    const sent: unknown[] = [];
    let recreatedWithResumeThread: boolean | undefined;

    const result = handleBuiltinCommand({
      request: {
        command: "/cd next",
        slash: { command: "cd", body: "next" },
        normalizedSlash: "cd",
        isSilentCommandPayload: false,
        shouldBroadcast: true,
      },
      userId: 7,
      historyKey: "history-1",
      currentCwd: "/tmp/project",
      orchestrator: { id: "orch" } as any,
      state: {
        directoryManager: {
          setUserCwd: () => ({ success: true }),
          getUserCwd: () => "/tmp/project/next",
        },
        workspaceCache: new Map(),
        cwdStore: new Map(),
        cwdStorePath: "",
        persistCwdStore: () => {},
      } as any,
      sessionManager: {
        hasSession: () => false,
        setUserCwd: () => {},
        getOrCreate: (_userId: number, _cwd?: string, resumeThread?: boolean) => {
          recreatedWithResumeThread = resumeThread;
          return { id: "next" } as any;
        },
      } as any,
      historyStore: new HistoryStore({ namespace: "test-command-builtins-cd", maxEntriesPerSession: 10 }),
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
      syncWorkspaceTemplates: () => {},
    });

    assert.equal(result.handled, true);
    assert.equal(recreatedWithResumeThread, true);
    assert.deepEqual(sent, [{ type: "result", ok: true, output: "已切换到: /tmp/project/next\n提示: 代理上下文已切换到新目录" }]);
  });

  it("records missing /cd argument errors so reconnect replay keeps the command result", () => {
    const sent: unknown[] = [];
    const broadcast: unknown[] = [];
    const loggedErrors: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-builtins-cd-missing", maxEntriesPerSession: 10 });

    try {
      const result = handleBuiltinCommand({
        request: {
          command: "/cd",
          slash: { command: "cd", body: "" },
          normalizedSlash: "cd",
          isSilentCommandPayload: false,
          shouldBroadcast: false,
        },
        userId: 7,
        historyKey: "history-cd-missing",
        currentCwd: "/tmp/project",
        orchestrator: { id: "orch" } as any,
        state: {} as any,
        sessionManager: {} as any,
        historyStore,
        sendToCommandScope: (payload) => sent.push(payload),
        sendToHistoryScope: (payload) => broadcast.push(payload),
        transport: {
          ws: {} as any,
          sendWorkspaceState: () => {
            throw new Error("failed cd should not emit workspace state");
          },
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: () => {},
          logError: (text) => loggedErrors.push(text),
        },
        syncWorkspaceTemplates: () => {},
      });

      assert.equal(result.handled, true);
      assert.deepEqual(sent, []);
      assert.deepEqual(broadcast, [{ type: "result", ok: false, output: "用法: /cd <path>" }]);
      assert.deepEqual(loggedErrors, ["用法: /cd <path>"]);
      assert.deepEqual(
        historyStore
          .get("history-cd-missing")
          .map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "用法: /cd <path>", kind: "error" }],
      );
    } finally {
      historyStore.clear("history-cd-missing");
    }
  });

  it("records failed /cd results so reconnect replay explains the rejected directory change", () => {
    const sent: unknown[] = [];
    const broadcast: unknown[] = [];
    const loggedErrors: string[] = [];
    const historyStore = new HistoryStore({ namespace: "test-command-builtins-cd-failed", maxEntriesPerSession: 10 });

    try {
      const result = handleBuiltinCommand({
        request: {
          command: "/cd missing",
          slash: { command: "cd", body: "missing" },
          normalizedSlash: "cd",
          isSilentCommandPayload: false,
          shouldBroadcast: false,
        },
        userId: 7,
        historyKey: "history-cd-failed",
        currentCwd: "/tmp/project",
        orchestrator: { id: "orch" } as any,
        state: {
          directoryManager: {
            setUserCwd: () => ({ success: false, error: "No such directory" }),
          },
        } as any,
        sessionManager: {} as any,
        historyStore,
        sendToCommandScope: (payload) => sent.push(payload),
        sendToHistoryScope: (payload) => broadcast.push(payload),
        transport: {
          ws: {} as any,
          sendWorkspaceState: () => {
            throw new Error("failed cd should not emit workspace state");
          },
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        sessionLogger: {
          logInput: () => {},
          logOutput: () => {},
          logError: (text) => loggedErrors.push(text),
        },
        syncWorkspaceTemplates: () => {},
      });

      assert.equal(result.handled, true);
      assert.deepEqual(sent, []);
      assert.deepEqual(broadcast, [{ type: "result", ok: false, output: "错误: No such directory" }]);
      assert.deepEqual(loggedErrors, ["错误: No such directory"]);
      assert.deepEqual(
        historyStore
          .get("history-cd-failed")
          .map((entry) => ({ role: entry.role, text: entry.text, kind: entry.kind })),
        [{ role: "status", text: "错误: No such directory", kind: "error" }],
      );
    } finally {
      historyStore.clear("history-cd-failed");
    }
  });

  it("recognizes blocked user slash commands", () => {
    assert.equal(isBlockedUserSlashCommand("search"), true);
    assert.equal(isBlockedUserSlashCommand("ads.status"), true);
    assert.equal(isBlockedUserSlashCommand("pwd"), false);
  });
});
