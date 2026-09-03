import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryInjectionDetails } from "../../server/web/server/ws/promptModelConfig.js";
import { buildHistoryStoreResumeTranscript } from "../../server/web/server/ws/taskResumeConversation.js";
import { handleBuiltinCommand, parseCommandRequest } from "../../server/web/server/ws/commandBuiltins.js";

describe("web/ws/sessionBoundary", () => {
  it("excludes pre-divider entries from history injection to protect clean model context", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "secret prompt from old session", ts: 100 },
      { role: "ai", text: "old response", ts: 200 },
      {
        role: "status",
        kind: "session_divider",
        text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
        ts: 300,
      },
      { role: "user", text: "fresh prompt in new session", ts: 400 },
      { role: "ai", text: "fresh response", ts: 500 },
    ]);

    assert.ok(details);
    assert.equal(details.entryCount, 2);
    assert.ok(!details.text.includes("secret prompt from old session"));
    assert.ok(!details.text.includes("old response"));
    assert.ok(details.text.includes("fresh prompt in new session"));
    assert.ok(details.text.includes("fresh response"));
  });

  it("returns null history injection details when all entries precede the divider", () => {
    const details = buildHistoryInjectionDetails([
      { role: "user", text: "old user prompt", ts: 100 },
      { role: "ai", text: "old ai reply", ts: 200 },
      {
        role: "status",
        kind: "session_divider",
        text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
        ts: 300,
      },
    ]);

    assert.equal(details, null);
  });

  it("excludes pre-divider entries from task resume transcript", () => {
    const transcript = buildHistoryStoreResumeTranscript([
      { role: "user", text: "old task command", ts: 100 },
      { role: "ai", text: "old task output", ts: 200 },
      {
        role: "status",
        kind: "session_divider",
        text: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
        ts: 300,
      },
      { role: "user", text: "new task command", ts: 400 },
      { role: "ai", text: "new task output", ts: 500 },
    ]);

    assert.ok(!transcript.includes("old task command"));
    assert.ok(!transcript.includes("old task output"));
    assert.ok(transcript.includes("new task command"));
    assert.ok(transcript.includes("new task output"));
  });

  it("handles /clear builtin command by wiping historyStore and sending result", () => {
    const cleared: string[] = [];
    const sent: unknown[] = [];
    const logged: string[] = [];

    const mockHistoryStore = {
      clear: (key: string) => {
        cleared.push(key);
      },
      add: () => true,
    };

    const parsed = parseCommandRequest({
      payload: "/clear",
      sanitizeInput: (p) => String(p ?? ""),
    });
    assert.ok(parsed.ok);

    const result = handleBuiltinCommand({
      request: parsed.request,
      userId: 123,
      historyKey: "test-history-key",
      currentCwd: "/workspace",
      orchestrator: {} as any,
      state: {} as any,
      sessionManager: {} as any,
      historyStore: mockHistoryStore as any,
      sendToCommandScope: (payload) => sent.push(payload),
      transport: {
        ws: {} as any,
        sendWorkspaceState: () => {},
        broadcastWorkspaceState: () => {},
      },
      logger: { warn: () => {} } as any,
      sessionLogger: { logOutput: (msg: string) => logged.push(msg) } as any,
      syncWorkspaceTemplates: () => {},
    });

    assert.equal(result.handled, true);
    assert.deepEqual(cleared, ["test-history-key"]);
    assert.deepEqual(sent, [
      { type: "result", ok: true, output: "已清空当前会话历史", kind: "clear_history" },
    ]);
    assert.deepEqual(logged, ["已清空当前会话历史"]);
  });
});
