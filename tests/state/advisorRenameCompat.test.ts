import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveWebConfig } from "../../server/config.js";
import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { HistoryStore } from "../../server/utils/historyStore.js";
import {
  ADVISOR_CHAT_SESSION_ID,
  CANONICAL_ACOPILOT_CHAT_SESSION_ID,
  isAcopilotChatSessionId,
  LEGACY_ADVISOR_CHAT_SESSION_ID,
  normalizeLaneChatSessionId,
  resolveWebSocketChatSessionId,
} from "../../server/web/server/ws/session.js";
import { resolveSyncNamespace } from "../../server/web/server/sync/lane.js";
import { WEB_ADVISOR_NAMESPACE, WEB_WORKER_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";
import { buildWsConnectionIdentity } from "../../server/web/server/ws/connectionIdentity.js";

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


  it("resolves the canonical acopilot lane id to the same stable session id as both legacy spellings", () => {
    assert.equal(CANONICAL_ACOPILOT_CHAT_SESSION_ID, "acopilot");
    // The stable value is a persisted key (it is embedded in historyKey and in
    // the client-side localStorage preference keys), so all three accepted
    // spellings must collapse onto it.
    assert.equal(ADVISOR_CHAT_SESSION_ID, "advisor");
    for (const spelling of ["acopilot", "advisor", "planner", " acopilot "]) {
      assert.equal(
        normalizeLaneChatSessionId(spelling),
        ADVISOR_CHAT_SESSION_ID,
        `expected ${JSON.stringify(spelling)} to resolve to the stable advisor id`,
      );
      assert.equal(isAcopilotChatSessionId(spelling), true);
    }
    assert.equal(
      resolveWebSocketChatSessionId({ protocols: ["ads-v1", "ads-chat.acopilot"] }),
      ADVISOR_CHAT_SESSION_ID,
    );
  });

  it("never routes a non-Acopilot session id into the Acopilot lane", () => {
    // Fail-closed in the other direction: the Actions lane's own project
    // session ids, "main", and the legacy lane word must keep routing to
    // Actions, otherwise a typo would silently execute in the wrong lane.
    for (const other of ["main", "worker", "room-a", "toString", "constructor", "__proto__", "ADVISOR", "Acopilot", ""]) {
      assert.equal(isAcopilotChatSessionId(other), false, `${JSON.stringify(other)} must not be Acopilot`);
    }
    // Matching is exact, not case-folded: an unrecognised casing fails closed
    // and falls through to the Actions lane rather than being guessed at.
    // Non-Acopilot values pass through (trimmed) so they keep addressing their
    // own project session.
    for (const other of ["main", "worker", "room-a", "toString"]) {
      assert.equal(normalizeLaneChatSessionId(other), other);
    }
    assert.equal(normalizeLaneChatSessionId("  room-a  "), "room-a");
    assert.equal(resolveWebSocketChatSessionId({ protocols: ["ads-v1", "ads-chat.worker"] }), "worker");
  });

  it("maps every accepted Acopilot spelling to the advisor sync namespace and nothing else", () => {
    for (const spelling of ["acopilot", "advisor", "planner"]) {
      assert.equal(resolveSyncNamespace(spelling), WEB_ADVISOR_NAMESPACE);
    }
    for (const other of ["main", "worker", "room-a", ""]) {
      assert.equal(resolveSyncNamespace(other), WEB_WORKER_NAMESPACE);
    }
  });

  it("derives identical persisted history keys for canonical and legacy spellings", () => {
    // The whole point of collapsing onto the stable id: a client that starts
    // sending the canonical value must land on the SAME persisted history key,
    // so existing lane history and thread state do not appear to vanish.
    const key = (chatSessionId: string) =>
      buildWsConnectionIdentity({
        authUserId: "user-1",
        sessionId: "proj-1",
        chatSessionId,
        randomHex: () => "",
      }).historyKey;
    // Normalization happens at the WS boundary, before the identity is built,
    // so every accepted spelling must reach buildWsConnectionIdentity already
    // collapsed onto the stable id.
    const canonical = key(normalizeLaneChatSessionId("acopilot"));
    assert.equal(canonical, key(normalizeLaneChatSessionId("advisor")));
    assert.equal(canonical, key(normalizeLaneChatSessionId("planner")));
    assert.equal(canonical, "user-1::proj-1::advisor");
    // And it stays distinct from the Actions lane.
    assert.notEqual(canonical, key("main"));
    // Sanity: the raw legacy value is genuinely a different persisted key,
    // which is why the boundary normalization has to happen first.
    assert.equal(key("planner"), "user-1::proj-1::planner");
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
