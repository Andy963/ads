import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceLockPool } from "../../server/web/server/workspaceLockPool.js";

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("web/workspaceLockPool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-lock-pool-"));
    fs.mkdirSync(path.join(tmpDir, "a"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "b"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "c"), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("evicts the oldest idle lock when maxEntries is exceeded", () => {
    const pool = new WorkspaceLockPool({ maxEntries: 2 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    const dirC = path.join(tmpDir, "c");

    const lockA = pool.get(dirA);
    const lockB = pool.get(dirB);
    pool.get(dirC);

    assert.equal(pool.get(dirB), lockB);
    assert.notEqual(pool.get(dirA), lockA);
  });

  it("refreshes LRU order on get() hit", () => {
    const pool = new WorkspaceLockPool({ maxEntries: 2 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    const dirC = path.join(tmpDir, "c");

    const lockA = pool.get(dirA);
    const lockB = pool.get(dirB);
    assert.equal(pool.get(dirA), lockA);
    pool.get(dirC);

    assert.equal(pool.get(dirA), lockA);
    assert.notEqual(pool.get(dirB), lockB);
  });

  it("does not evict busy locks", async () => {
    const pool = new WorkspaceLockPool({ maxEntries: 1 });
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");

    const lockA = pool.get(dirA);
    const gate = createDeferred<void>();
    const running = lockA.runExclusive(async () => {
      await gate.promise;
    });

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lockA.isBusy(), true);

    pool.get(dirB);
    assert.equal(pool.get(dirA), lockA);

    gate.resolve();
    await running;
    assert.equal(lockA.isBusy(), false);
  });
});

