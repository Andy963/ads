import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { initializeWorkspace } from "../../src/workspace/detector.js";
import { HistoryStore } from "../../src/utils/historyStore.js";
import {
  buildCandidateMemory,
  parseRecallDecision,
  shouldTriggerRecall,
} from "../../src/utils/workspaceRecall.js";

describe("utils/workspaceRecall", () => {
  let tmpDir: string;

  beforeEach(() => {
    resetStateDatabaseForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-recall-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds candidate memory from recent turns", () => {
    initializeWorkspace(tmpDir, "WorkspaceRecall Test");
    const dbPath = path.join(tmpDir, ".ads", "state.db");
    const store = new HistoryStore({ storagePath: dbPath, namespace: "cli" });
    store.add("default", { role: "user", text: "please implement caching", ts: 1 });
    store.add("default", { role: "ai", text: "we will use an LRU cache", ts: 2 });
    store.add("default", { role: "user", text: "unrelated", ts: 3 });
    store.add("default", { role: "ai", text: "ok", ts: 4 });

    const candidate = buildCandidateMemory({
      workspaceRoot: tmpDir,
      inputText: "implement caching for requests",
      config: { lookbackTurns: 100, maxChars: 2000 },
      excludeLatestUserText: "implement caching for requests",
    });

    assert.ok(candidate);
    assert.match(candidate.memoryForPrompt, /caching/i);
    assert.match(candidate.previewForUser, /候选记忆/);
  });

  it("parses recall confirmation decisions", () => {
    assert.deepEqual(parseRecallDecision("yes"), { action: "accept" });
    assert.deepEqual(parseRecallDecision("no"), { action: "ignore" });
    assert.deepEqual(parseRecallDecision("修改: foo bar"), { action: "edit", text: "foo bar" });
  });

  it("detects task-like inputs", () => {
    assert.equal(
      shouldTriggerRecall({ text: "please implement X", classifyEnabled: true, classification: "task" }),
      true,
    );
    assert.equal(
      shouldTriggerRecall({ text: "hello", classifyEnabled: true, classification: "chat" }),
      false,
    );
    assert.equal(
      shouldTriggerRecall({ text: "/search foo", classifyEnabled: false }),
      false,
    );
  });
});

