import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryBootstrapPayload } from "../../server/web/server/ws/bootstrapReplay.js";

describe("web/ws/bootstrapReplay", () => {
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
