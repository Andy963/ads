import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { runHistoryMaintenance } from "../../server/state/historyMaintenance.js";
import { HistoryStore } from "../../server/utils/historyStore.js";

describe("state/history maintenance", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-history-maintenance-"));
    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
    process.env.CODEX_HOME = path.join(tmpDir, "codex-home");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps prompts larger than the old 4000 character limit by default", () => {
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-worker" });
    const text = "x".repeat(32_000);

    assert.equal(history.add("chat-1", { role: "user", text, ts: 1 }), true);
    assert.equal(history.get("chat-1")[0]?.text, text);
  });

  it("associates a chat with provider-local sessions without copying their contents", () => {
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-worker" });
    history.add("chat-1", { role: "user", text: "hello", ts: 1 });

    assert.equal(history.linkAgentSession("chat-1", {
      agentId: "codex",
      providerSessionId: "thread-123",
      cwd: "/workspace/project",
    }), true);

    const links = history.getAgentSessionLinks("chat-1");
    assert.equal(links.length, 1);
    assert.equal(links[0]?.agentId, "codex");
    assert.equal(links[0]?.providerSessionId, "thread-123");
    assert.equal(links[0]?.cwd, "/workspace/project");
    assert.deepEqual(links[0]?.locator, {
      kind: "codex_sessions",
      root: process.env.CODEX_HOME,
      pattern: "sessions/**/rollout-*.jsonl",
    });
  });

  it("removes expired sessions and then enforces the global history byte budget", () => {
    const db = getStateDatabase(dbPath);
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-worker" });
    const now = 100 * 24 * 60 * 60 * 1000;

    history.add("expired", { role: "user", text: "old", ts: now - 91 * 24 * 60 * 60 * 1000 });
    history.linkAgentSession("expired", {
      agentId: "claude",
      providerSessionId: "session-old",
      cwd: "/workspace/project",
    });
    history.add("older-large", { role: "user", text: "a".repeat(60), ts: now - 2000 });
    history.add("newer-large", { role: "user", text: "b".repeat(60), ts: now - 1000 });

    const result = runHistoryMaintenance(db, {
      retentionDays: 90,
      maxStoredBytes: 100,
    }, now);

    assert.equal(result.deletedSessions, 2);
    assert.equal(result.deletedEntries, 2);
    assert.equal(result.remainingStoredBytes, 60);
    assert.deepEqual(history.get("expired"), []);
    assert.deepEqual(history.get("older-large"), []);
    assert.equal(history.get("newer-large").length, 1);
    assert.deepEqual(history.getAgentSessionLinks("expired"), []);
  });
});
