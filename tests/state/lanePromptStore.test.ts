import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import DatabaseConstructor, { type Database as DatabaseType } from "better-sqlite3";

import { createLanePromptStore } from "../../server/state/lanePromptStore.js";

describe("state/lanePromptStore", () => {
  let db: DatabaseType | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("seeds both lane baselines and exposes the active versions", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createLanePromptStore(db);

    const snapshots = store.listLanePrompts();
    assert.deepEqual(snapshots.map((snapshot) => snapshot.lane), ["advisor", "worker"]);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.current.version, 1);
      assert.equal(snapshot.current.isBase, true);
      assert.equal(snapshot.current.prompt.length > 0, true);
      assert.deepEqual(snapshot.versions.map((version) => version.version), [1]);
    }
  });

  it("appends versions and reset points to the immutable base version", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createLanePromptStore(db);

    const saved = store.setLanePrompt("advisor", "Custom advisor prompt", 1000);
    assert.equal(saved.current.version, 2);
    assert.equal(saved.current.prompt, "Custom advisor prompt");
    assert.equal(saved.base.version, 1);
    assert.equal(saved.versions.length, 2);
    assert.equal(saved.updatedAt, 1000);

    const second = store.setLanePrompt("advisor", "Second advisor prompt", 2000);
    assert.equal(second.current.version, 3);
    assert.deepEqual(second.versions.map((version) => version.version), [3, 2, 1]);

    const reset = store.resetLanePrompt("advisor");
    assert.equal(reset.current.version, 1);
    assert.equal(reset.current.prompt, reset.base.prompt);
    assert.equal(reset.versions.length, 3);
  });

  it("rejects invalid lanes and empty prompts", () => {
    db = new DatabaseConstructor(":memory:");
    const store = createLanePromptStore(db);

    assert.throws(() => store.getLanePrompt("telegram" as never), /Unknown lane/);
    assert.throws(() => store.setLanePrompt("worker", "   "), /Prompt must not be empty/);
  });
});
