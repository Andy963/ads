import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { initializeWorkspace } from "../../src/workspace/detector.js";
import { HistoryStore } from "../../src/utils/historyStore.js";
import { loadWorkspaceHistoryEntries } from "../../src/utils/workspaceHistory.js";
import { resolveWorkspaceStateDir, resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("utils/workspaceHistory", () => {
  let tmpDir: string;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    resetStateDatabaseForTests();
    adsState = installTempAdsStateDir("ads-state-workspace-history-");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-history-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    adsState?.restore();
    adsState = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty and does not create .ads for uninitialized workspace", () => {
    const result = loadWorkspaceHistoryEntries({
      workspaceRoot: tmpDir,
      includeNamespaces: ["cli", "telegram", "web"],
      sessionIdByNamespace: { web: ["token::a"] },
      limit: 50,
    });
    assert.deepEqual(result, []);
    assert.equal(fs.existsSync(resolveWorkspaceStateDir(tmpDir)), false);
  });

  it("merges namespaces and respects per-namespace session filters", () => {
    initializeWorkspace(tmpDir, "WorkspaceHistory Test");
    const dbPath = resolveWorkspaceStatePath(tmpDir, "state.db");

    const cliStore = new HistoryStore({ storagePath: dbPath, namespace: "cli" });
    const tgStore = new HistoryStore({ storagePath: dbPath, namespace: "telegram" });
    const webStore = new HistoryStore({ storagePath: dbPath, namespace: "web" });

    cliStore.add("default", { role: "user", text: "cli msg", ts: 1 });
    tgStore.add("123", { role: "user", text: "tg msg", ts: 2 });
    webStore.add("token::a", { role: "user", text: "web a", ts: 3 });
    webStore.add("token::b", { role: "user", text: "web b", ts: 4 });

    const merged = loadWorkspaceHistoryEntries({
      workspaceRoot: tmpDir,
      includeNamespaces: ["cli", "telegram", "web"],
      sessionIdByNamespace: { web: ["token::a"] },
      limit: 50,
    });

    assert.deepEqual(
      merged.map((entry) => entry.text),
      ["cli msg", "tg msg", "web a"],
    );
  });
});
