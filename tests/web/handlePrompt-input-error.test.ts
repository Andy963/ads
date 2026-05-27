import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildHistoryBootstrapPayload } from "../../server/web/server/ws/bootstrapReplay.js";
import { handlePromptMessage } from "../../server/web/server/ws/handlePrompt.js";

type HistoryEntry = { role: string; text: string; ts: number; kind?: string };

class MemoryHistoryStore {
  private readonly store = new Map<string, HistoryEntry[]>();

  get(sessionId: string): HistoryEntry[] {
    return this.store.get(sessionId) ?? [];
  }

  add(sessionId: string, entry: HistoryEntry): boolean {
    this.store.set(sessionId, [...this.get(sessionId), entry]);
    return true;
  }
}

describe("web/server/ws handlePrompt input errors", () => {
  it("persists prompt input failures so reconnect history explains the failed turn", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-web-prompt-input-error-"));
    const historyStore = new MemoryHistoryStore();
    const clientMessages: unknown[] = [];
    const chatMessages: unknown[] = [];

    try {
      const result = await handlePromptMessage({
        request: {
          parsed: {
            type: "prompt",
            payload: {
              text: "hello",
              images: [{ name: "bad.txt", mime: "text/plain", data: "abc" }],
            },
          },
          requestId: "req-1",
          clientMessageId: null,
          receivedAt: 123,
        },
        transport: {
          ws: {} as any,
          safeJsonSend: (_ws, payload) => clientMessages.push(payload),
          broadcastJson: (payload) => chatMessages.push(payload),
          sendWorkspaceState: () => {},
        },
        observability: {
          logger: { info: () => {}, warn: () => {}, debug: () => {} },
          sessionLogger: {
            logInput: () => {},
            logOutput: () => {},
            logError: () => {},
            logEvent: () => {},
            attachThreadId: () => {},
          },
          traceWsDuplication: false,
        },
        context: {
          authUserId: "test-user",
          sessionId: "session-1",
          chatSessionId: "main",
          userId: 1,
          historyKey: "history-1",
          currentCwd: workspaceRoot,
        },
        sessions: {
          sessionManager: {},
          orchestrator: {},
          getWorkspaceLock: () => ({ runExclusive: async (fn: () => Promise<void>) => await fn() }),
          interruptControllers: new Map<string, AbortController>(),
          promptRunEpochs: new Map<string, number>(),
        },
        history: {
          historyStore,
        },
        tasks: {},
        scheduler: {},
      } as any);

      assert.equal(result.handled, true);
      assert.deepEqual(clientMessages, []);
      assert.deepEqual(chatMessages, [{ type: "error", message: "不支持的图片类型: text/plain" }]);
      assert.deepEqual(
        historyStore.get("history-1").map((entry) => ({
          role: entry.role,
          text: entry.text,
          kind: entry.kind,
        })),
        [{ role: "status", text: "不支持的图片类型: text/plain", kind: "error" }],
      );
      assert.deepEqual(buildHistoryBootstrapPayload(historyStore.get("history-1"))?.items, historyStore.get("history-1"));
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
