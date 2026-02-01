import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatWriteExploredSummary } from "../../src/web/server/ws/handlePrompt.js";

describe("web/server/ws/handlePrompt Write summary", () => {
  it("appends a git-style diffstat when patch stats are available", () => {
    const longPath = `${"a/".repeat(40)}file.txt`;
    const changes = [
      { kind: "modify", path: longPath },
      { kind: "create", path: "src/short.ts" },
      { kind: "modify", path: "src/third.ts" },
      { kind: "delete", path: "src/fourth.ts" },
      { kind: "modify", path: "src/fifth.ts" },
    ];
    const patchFiles = [
      { path: "src/short.ts", added: 5, removed: 1 },
      { path: "src/third.ts", added: 2, removed: 0 },
    ];

    const summary = formatWriteExploredSummary(changes, patchFiles);

    assert.ok(summary.includes("modify file.txt"), summary);
    assert.ok(summary.includes("(+1 more)"), summary);
    assert.ok(summary.endsWith("(+7 -1)"), summary);
  });
});

