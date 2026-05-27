import { describe, it } from "node:test";
import assert from "node:assert/strict";

import DatabaseConstructor from "better-sqlite3";

import { forceCompact, shouldCompact } from "../../server/context/compactor.js";

describe("context/compactor", () => {
  it("creates structured handoff and persists snapshot", () => {
    const db = new DatabaseConstructor(":memory:");
    db.exec(`
      CREATE TABLE compaction_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        tokens_before INTEGER,
        tokens_after INTEGER,
        content TEXT NOT NULL,
        truncated TEXT NOT NULL
      )
    `);

    const result = forceCompact({
      workspaceId: "ws",
      sessionId: "s",
      trigger: "manual",
      db,
      messages: [
        { role: "user", content: "Goal: build feature" },
        { role: "assistant", content: "Done: edited file" },
        { role: "user", content: "Next request" },
      ],
      keepTurns: 1,
    });

    assert.match(result.content, /## Goal/);
    assert.equal(result.messages[0]?.role, "system");
    const row = db.prepare("SELECT trigger, content FROM compaction_snapshots").get() as { trigger: string; content: string };
    assert.equal(row.trigger, "manual");
    assert.match(row.content, /Critical Context/);
    db.close();
  });

  it("honors compact thresholds", () => {
    assert.equal(shouldCompact({ tokens: 70, maxTokens: 100 }), true);
    assert.equal(shouldCompact({ tokens: 10, maxTokens: 100 }), false);
  });
});
