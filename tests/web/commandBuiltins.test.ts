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

  it("recognizes blocked user slash commands", () => {
    assert.equal(isBlockedUserSlashCommand("search"), true);
    assert.equal(isBlockedUserSlashCommand("ads.status"), true);
    assert.equal(isBlockedUserSlashCommand("pwd"), false);
  });
});
