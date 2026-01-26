import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import { initializeWorkspace } from "../../src/workspace/detector.js";
import { HistoryStore } from "../../src/utils/historyStore.js";
import { searchWorkspaceHistory } from "../../src/utils/workspaceSearch.js";
import { resolveWorkspaceStateDir, resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("utils/workspaceSearch", () => {
  let tmpDir: string;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    resetStateDatabaseForTests();
    adsState = installTempAdsStateDir("ads-state-workspace-search-");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-search-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    adsState?.restore();
    adsState = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result for fresh workspace state", () => {
    const outcome = searchWorkspaceHistory({
      workspaceRoot: tmpDir,
      query: "hello",
      engine: "fts5",
      scanLimit: 100,
      maxResults: 5,
      maxChars: 2000,
    });
    assert.doesNotMatch(outcome.output, /工作空间未初始化/);
    assert.match(outcome.output, /\(0 results\)/);
    assert.equal(fs.existsSync(resolveWorkspaceStateDir(tmpDir)), true);
  });

  it("returns results via window-scan", () => {
    initializeWorkspace(tmpDir, "WorkspaceSearch Test");
    const dbPath = resolveWorkspaceStatePath(tmpDir, "state.db");
    const store = new HistoryStore({ storagePath: dbPath, namespace: "cli" });
    store.add("default", { role: "user", text: "hello world", ts: 1 });
    store.add("default", { role: "ai", text: "ok", ts: 2 });

    const outcome = searchWorkspaceHistory({
      workspaceRoot: tmpDir,
      query: "hello",
      engine: "window-scan",
      scanLimit: 100,
      maxResults: 5,
      maxChars: 2000,
    });
    assert.match(outcome.output, /engine: window-scan/);
    assert.match(outcome.output, /hello world/);
  });

  it("returns results via fts5 when available (or degrades)", () => {
    initializeWorkspace(tmpDir, "WorkspaceSearch FTS Test");
    const dbPath = resolveWorkspaceStatePath(tmpDir, "state.db");
    const store = new HistoryStore({ storagePath: dbPath, namespace: "cli" });
    store.add("default", { role: "user", text: "hello world", ts: 1 });
    store.add("default", { role: "ai", text: "ok", ts: 2 });

    const outcome = searchWorkspaceHistory({
      workspaceRoot: tmpDir,
      query: "hello",
      engine: "fts5",
      scanLimit: 100,
      maxResults: 5,
      maxChars: 2000,
    });
    assert.match(outcome.output, /hello world/);
    assert.match(outcome.output, /engine: (fts5|window-scan)/);
  });
});
