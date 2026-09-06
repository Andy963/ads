import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getWorkspacesDatabase, resetDatabaseForTests, resolveWorkspaceId } from "../../server/storage/database.js";
import { searchSessionMessages } from "../../server/skills/builtinTools.js";

describe("storage/fts", () => {
  let workspace: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-fts-"));
    delete process.env.ADS_DATABASE_PATH;
    process.env.ADS_WORKSPACES_DATABASE_PATH = path.join(workspace, "workspaces.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("indexes conversation messages for session search", () => {
    const db = getWorkspacesDatabase(undefined, workspace);
    const workspaceId = resolveWorkspaceId(workspace);
    db.prepare(
      "INSERT INTO conversations (workspace_id, id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(workspaceId, "chat-1", "Chat", "active", 123, 123);
    db.prepare(
      "INSERT INTO conversation_messages (workspace_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "chat-1", "user", "The tavily request failed with error 429", 123);

    const matches = searchSessionMessages({ workspaceRoot: workspace, query: "tavily" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.sessionId, "chat-1");
    assert.match(matches[0]?.snippet ?? "", /tavily/i);
  });
});
