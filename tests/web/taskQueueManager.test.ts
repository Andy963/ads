import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTaskQueueManager } from "../../server/web/server/taskQueue/manager.js";

describe("web/taskQueue manager workspace resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-task-queue-manager-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createManager(allowedDirs: string[]) {
    return createTaskQueueManager({
      workspaceRoot: tmpDir,
      allowedDirs,
      adsStateDir: tmpDir,
      lockForWorkspace: () =>
        ({
          isBusy: () => false,
          runExclusive: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
        }) as any,
      available: false,
      autoStart: false,
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      broadcastToSession: () => {},
      recordToSessionHistories: () => {},
    });
  }

  it("resolves nested workspace paths to the shared workspace root", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const nestedDir = path.join(tmpDir, "packages", "worker");
    fs.mkdirSync(nestedDir, { recursive: true });

    const manager = createManager([tmpDir]);
    const resolved = manager.resolveTaskWorkspaceRoot(
      new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`),
    );

    assert.equal(resolved, path.resolve(tmpDir));
  });

  it("rejects nested workspace paths when the detected workspace root is outside the allow list", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const allowedRoot = path.join(tmpDir, "sandbox");
    const nestedDir = path.join(allowedRoot, "workspace");
    fs.mkdirSync(nestedDir, { recursive: true });

    const manager = createManager([allowedRoot]);

    assert.throws(
      () => manager.resolveTaskWorkspaceRoot(new URL(`http://localhost/api/task-queue/status?workspace=${encodeURIComponent(nestedDir)}`)),
      /Workspace is not allowed/,
    );
  });
});
