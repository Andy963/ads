import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryBootstrapPayload } from "../../server/web/server/ws/bootstrapReplay.js";

describe("web/ws/bootstrapReplay", () => {
  it("restores only the command from legacy execute history", () => {
    const entry = { role: "status", kind: "execute", text: "$ npm test\nprivate output\nprivate error", ts: 1 };
    assert.deepEqual(buildHistoryBootstrapPayload([entry])?.items, [{ ...entry, text: "$ npm test" }]);
    assert.match(entry.text, /private output/);
  });

  it("does not replay legacy thought or plan history entries", () => {
    const payload = buildHistoryBootstrapPayload([
      { role: "user", text: "hello", ts: 1 },
      { role: "thought", text: "internal reasoning", ts: 2, kind: "thought" },
      { role: "status", text: "old plan", ts: 3, kind: "plan:in_progress" },
      { role: "ai", text: "done", ts: 4 },
    ]);

    assert.deepEqual(payload?.items, [
      { role: "user", text: "hello", ts: 1 },
      { role: "ai", text: "done", ts: 4 },
    ]);
  });

  it("sanitizes ai history and keeps only the latest /cd command", () => {
    const payload = buildHistoryBootstrapPayload([
      { role: "user", text: "/cd /tmp/a", ts: 1 },
      { role: "user", text: "hello", ts: 2 },
      { role: "ai", text: "English translation:\n\nActual reply", ts: 3 },
      { role: "user", text: "/cd /tmp/b", ts: 4 },
    ]);

    assert.deepEqual(payload, {
      type: "history",
      items: [
        { role: "user", text: "hello", ts: 2 },
        { role: "ai", text: "Actual reply", ts: 3 },
        { role: "user", text: "/cd /tmp/b", ts: 4 },
      ],
    });
  });
});
