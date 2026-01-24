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
import { initializeWorkspace } from "../../src/workspace/detector.js";

describe("state/workspaceSessionStore", () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    resetStateDatabaseForTests();
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workspace-session-store-"));
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it("stores and loads active_thread_id when workspace is initialized", () => {
    initializeWorkspace(tmpWorkspace, "SessionStore Test");

    assert.equal(getActiveThreadId(tmpWorkspace), undefined);
    setActiveThreadId(tmpWorkspace, " thread_abc123 ");
    assert.equal(getActiveThreadId(tmpWorkspace), "thread_abc123");
  });

  it("clears active_thread_id", () => {
    initializeWorkspace(tmpWorkspace, "SessionStore Clear Test");

    setActiveThreadId(tmpWorkspace, "thread_to_clear");
    assert.equal(getActiveThreadId(tmpWorkspace), "thread_to_clear");

    clearActiveThreadId(tmpWorkspace);
    assert.equal(getActiveThreadId(tmpWorkspace), undefined);
  });

  it("is a no-op when workspace is not initialized", () => {
    const adsDir = path.join(tmpWorkspace, ".ads");
    assert.equal(fs.existsSync(adsDir), false);

    setActiveThreadId(tmpWorkspace, "thread_ignored");
    assert.equal(getActiveThreadId(tmpWorkspace), undefined);
    clearActiveThreadId(tmpWorkspace);
    assert.equal(getActiveThreadId(tmpWorkspace), undefined);

    assert.equal(
      fs.existsSync(adsDir),
      false,
      "workspaceSessionStore should not create .ads for uninitialized workspaces",
    );
  });
});

