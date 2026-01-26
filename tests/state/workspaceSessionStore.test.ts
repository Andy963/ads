import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../src/state/database.js";
import {
  clearActiveThreadId,
  getActiveThreadId,
  setActiveThreadId,
} from "../../src/state/workspaceSessionStore.js";
import { resolveWorkspaceStateDir, resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("state/workspaceSessionStore", () => {
  let tmpWorkspace: string;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    resetStateDatabaseForTests();
    adsState = installTempAdsStateDir("ads-state-session-store-");
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-session-store-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    adsState?.restore();
    adsState = null;
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it("stores and loads active_thread_id without explicit init", () => {
    assert.equal(getActiveThreadId(tmpWorkspace), undefined);
    setActiveThreadId(tmpWorkspace, " thread_abc123 ");
    assert.equal(getActiveThreadId(tmpWorkspace), "thread_abc123");

    assert.equal(fs.existsSync(resolveWorkspaceStateDir(tmpWorkspace)), true);
    assert.equal(fs.existsSync(resolveWorkspaceStatePath(tmpWorkspace, "workspace.json")), true);
  });

  it("clears active_thread_id", () => {
    setActiveThreadId(tmpWorkspace, "thread_to_clear");
    assert.equal(getActiveThreadId(tmpWorkspace), "thread_to_clear");

    clearActiveThreadId(tmpWorkspace);
    assert.equal(getActiveThreadId(tmpWorkspace), undefined);
  });
});
