import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetStateDatabaseForTests } from "../../server/state/database.js";
import { WEB_WORKER_NAMESPACE } from "../../server/web/server/start/webLaneResources.js";
import {
  COMMAND_SNAPSHOT_EVENT_TYPE,
  createCommandSnapshotCoalescer,
} from "../../server/web/server/sync/commandSnapshot.js";
import { SyncEventStore } from "../../server/web/server/sync/store.js";

describe("server/sync/commandSnapshot", () => {
  let tmpDir: string;
  let stateDbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-snapshot-"));
    stateDbPath = path.join(tmpDir, "state.db");
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("coalesces duplicate output and preserves absolute offsets", () => {
    const store = new SyncEventStore({ stateDbPath });
    const coalescer = createCommandSnapshotCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: "command-lane",
      now: () => 1000,
    });

    const first = coalescer.record({
      type: "command",
      ts: 1000,
      command: { id: "cmd-1", command: "npm test", outputDelta: "$ npm test\nPASS one\n", outputStartOffset: 0, outputEndOffset: 17 },
    });
    const duplicate = coalescer.record({
      type: "command",
      ts: 1001,
      command: { id: "cmd-1", command: "npm test", outputDelta: "$ npm test\nPASS one\n", outputStartOffset: 0, outputEndOffset: 17 },
    });
    const second = coalescer.record({
      type: "command",
      ts: 1002,
      command: { id: "cmd-1", command: "npm test", outputDelta: "PASS two\n", outputStartOffset: 17, outputEndOffset: 27 },
    });

    assert.equal(first?.identity, "cmd-1");
    assert.equal(duplicate?.snapshotSeq, first?.snapshotSeq);
    assert.equal(second?.startOffset, 17);
    assert.equal(second?.endOffset, 27);
    const snapshots = store.readCoalesced({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: "command-lane",
      type: COMMAND_SNAPSHOT_EVENT_TYPE,
    });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.payload.command && (snapshots[0].payload.command as Record<string, unknown>).output, "$ npm test\nPASS one\nPASS two\n");
  });

  it("creates distinct blocks when a command id is reused for another command", () => {
    const store = new SyncEventStore({ stateDbPath });
    const coalescer = createCommandSnapshotCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: "command-lane",
      now: () => 2000,
    });

    const first = coalescer.record({
      type: "command",
      command: { id: "reused", command: "npm test", outputDelta: "$ npm test\n" },
    });
    const second = coalescer.record({
      type: "command",
      command: { id: "reused", command: "npm run build", outputDelta: "$ npm run build\n" },
    });

    assert.notEqual(first?.identity, second?.identity);
    assert.equal(coalescer.getActiveCount(), 2);
    assert.equal(coalescer.getSnapshots().length, 2);
  });

  it("hydrates active snapshots after reconnect and removes them only at turn completion", () => {
    const store = new SyncEventStore({ stateDbPath });
    const args = {
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: "command-lane",
      type: "command" as const,
      command: { id: "cmd-live", command: "npm test", outputDelta: "$ npm test\nPASS\n" },
    };
    const writer = createCommandSnapshotCoalescer({ store, ...args, now: () => 3000 });
    writer.record(args);

    const reconnect = createCommandSnapshotCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey: "command-lane",
      hydrate: true,
    });
    assert.equal(reconnect.getActiveCount(), 1);
    assert.equal(reconnect.getSnapshots()[0]?.command && (reconnect.getSnapshots()[0]!.command as Record<string, unknown>).output, "$ npm test\nPASS\n");

    writer.finish();
    assert.equal(store.readCoalesced({ namespace: WEB_WORKER_NAMESPACE, laneKey: "command-lane", type: COMMAND_SNAPSHOT_EVENT_TYPE }).length, 0);
  });
});
