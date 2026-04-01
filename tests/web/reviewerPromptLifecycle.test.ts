import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";

import { HistoryStore } from "../../server/utils/historyStore.js";
import {
  finishReviewerPromptEarly,
  handleReviewerOrchestratorUnavailable,
} from "../../server/web/server/ws/reviewerPromptLifecycle.js";

describe("web/ws/reviewerPromptLifecycle", () => {
  it("broadcasts early reviewer output, records history, and cleans up", () => {
    const sent: unknown[] = [];
    const workspaceStateCalls: Array<{ ws: unknown; workspaceRoot: string }> = [];
    const historyStore = new HistoryStore({ namespace: "test-reviewer-lifecycle", maxEntriesPerSession: 20 });
    const interruptControllers = new Map<string, AbortController>([["hk", new AbortController()]]);
    let cleanedUp = 0;
    const ws = { id: "ws-1" } as unknown as WebSocket;

    try {
      finishReviewerPromptEarly({
        output: "read-only response",
        historyStore,
        historyKey: "hk",
        sendToChat: (payload) => sent.push(payload),
        sendWorkspaceState: (socket, workspaceRoot) => workspaceStateCalls.push({ ws: socket, workspaceRoot }),
        ws,
        workspaceRoot: "/tmp/reviewer",
        interruptControllers,
        cleanupAfter: () => {
          cleanedUp += 1;
        },
      });

      assert.deepEqual(sent, [{ type: "result", ok: true, output: "read-only response" }]);
      assert.equal(historyStore.get("hk").at(-1)?.text, "read-only response");
      assert.deepEqual(workspaceStateCalls, [{ ws, workspaceRoot: "/tmp/reviewer" }]);
      assert.equal(interruptControllers.has("hk"), false);
      assert.equal(cleanedUp, 1);
    } finally {
      historyStore.clear("hk");
    }
  });

  it("reports orchestrator unavailability to the client and cleans up", () => {
    const sent: unknown[] = [];
    const logged: string[] = [];
    const interruptControllers = new Map<string, AbortController>([["hk", new AbortController()]]);
    let cleanedUp = 0;

    handleReviewerOrchestratorUnavailable({
      errorMessage: "代理未启用，请配置凭证",
      sessionLogger: {
        logInput: () => {},
        logOutput: () => {},
        logError: (text) => logged.push(text),
        logEvent: () => {},
        attachThreadId: () => {},
      },
      sendToClient: (payload) => sent.push(payload),
      interruptControllers,
      historyKey: "hk",
      cleanupAfter: () => {
        cleanedUp += 1;
      },
    });

    assert.deepEqual(sent, [{ type: "error", message: "代理未启用，请配置凭证" }]);
    assert.deepEqual(logged, ["代理未启用，请配置凭证"]);
    assert.equal(interruptControllers.has("hk"), false);
    assert.equal(cleanedUp, 1);
  });
});
