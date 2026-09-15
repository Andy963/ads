import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveWebConfig } from "../../server/config.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import {
  LEGACY_ADVISOR_CHAT_SESSION_ID,
  normalizeLaneChatSessionId,
  resolveWebSocketChatSessionId,
} from "../../server/web/server/ws/session.js";

describe("advisor rename compatibility", () => {
  let tmpDir: string;
  let dbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-advisor-rename-"));
    dbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = dbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maps the legacy planner lane id to advisor at the ws boundary", () => {
    assert.equal(LEGACY_ADVISOR_CHAT_SESSION_ID, "planner");
    assert.equal(normalizeLaneChatSessionId("planner"), "advisor");
    assert.equal(normalizeLaneChatSessionId(" advisor "), "advisor");
    assert.equal(normalizeLaneChatSessionId("worker"), "worker");
    assert.equal(normalizeLaneChatSessionId("room-a"), "room-a");
    assert.equal(
      resolveWebSocketChatSessionId({ protocols: ["ads-v1", "ads-chat.planner"] }),
      "advisor",
    );
    assert.equal(resolveWebSocketChatSessionId({ protocols: ["ads-v1"] }), "main");
  });

  it("replays legacy planner history when the advisor key has no entries", () => {
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-advisor" });
    history.add("user-1::proj-1::planner", { role: "user", text: "legacy turn", ts: 1 });

    const fallback = history.get("user-1::proj-1::advisor");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]?.text, "legacy turn");

    // Writes go to the advisor key; once it has entries the legacy key is ignored.
    history.add("user-1::proj-1::advisor", { role: "user", text: "new turn", ts: 2 });
    const primary = history.get("user-1::proj-1::advisor");
    assert.equal(primary.length, 1);
    assert.equal(primary[0]?.text, "new turn");
  });

  it("replays legacy planner history for fenced generation keys", () => {
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-advisor" });
    history.add("user-1::proj-1::planner:generation:2", { role: "user", text: "fenced legacy", ts: 1 });

    const fallback = history.get("user-1::proj-1::advisor:generation:2");
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0]?.text, "fenced legacy");
  });

  it("does not fall back for non-advisor keys", () => {
    const history = new HistoryStore({ storagePath: dbPath, namespace: "web-advisor" });
    history.add("user-1::proj-1::main", { role: "user", text: "worker lane", ts: 1 });

    assert.equal(history.get("user-1::proj-1::main").length, 1);
    assert.equal(history.get("user-1::proj-1::room-a").length, 0);
  });

  it("falls back to ADS_PLANNER_CODEX_MODEL when the advisor variable is unset", () => {
    delete process.env.ADS_ADVISOR_CODEX_MODEL;
    delete process.env.ADS_PLANNER_CODEX_MODEL;
    process.env.ADS_PLANNER_CODEX_MODEL = "gpt-legacy";
    assert.equal(resolveWebConfig({ env: process.env }).advisorCodexModel, "gpt-legacy");

    process.env.ADS_ADVISOR_CODEX_MODEL = "gpt-new";
    assert.equal(resolveWebConfig({ env: process.env }).advisorCodexModel, "gpt-new");
  });
});
