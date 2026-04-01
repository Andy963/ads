import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTaskResumeHistorySnapshot } from "../../server/web/server/ws/taskResumeHistory.js";

describe("web/ws/taskResumeHistory", () => {
  it("strips translation prefixes from ai history entries", () => {
    const result = buildTaskResumeHistorySnapshot([
      { role: "user", text: "你好", ts: 1 },
      { role: "ai", text: "Idiomatic English:\nHello there", ts: 2 },
    ]);

    assert.equal(result.length, 2);
    assert.equal(result[1]?.text, "Hello there");
  });

  it("keeps only the most recent /cd command", () => {
    const result = buildTaskResumeHistorySnapshot([
      { role: "user", text: "/cd /workspace/one", ts: 1 },
      { role: "ai", text: "ok", ts: 2 },
      { role: "user", text: "/cd /workspace/two", ts: 3 },
      { role: "user", text: "继续", ts: 4 },
    ]);

    assert.deepEqual(
      result.map((entry) => entry.text),
      ["ok", "/cd /workspace/two", "继续"],
    );
  });
});
