import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../../server/tasks/store.js";
import { resetDatabaseForTests } from "../../server/storage/database.js";
import { searchSessionMessages } from "../../server/skills/builtinTools.js";

describe("storage/fts", () => {
  let workspace: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-fts-"));
    delete process.env.ADS_DATABASE_PATH;
    resetDatabaseForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("indexes conversation messages for session search", () => {
    const store = new TaskStore({ workspacePath: workspace });
    store.addConversationMessage({
      conversationId: "chat-1",
      role: "user",
      content: "The tavily request failed with error 429",
      createdAt: 123,
    });

    const matches = searchSessionMessages({ workspaceRoot: workspace, query: "tavily" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sessionId, "chat-1");
    assert.match(matches[0]?.snippet ?? "", /tavily/i);
  });
});
