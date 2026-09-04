import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEventStore } from '../../server/web/server/sync/store.js';
import { createDeltaStreamCoalescer } from '../../server/web/server/sync/deltaStream.js';
import { resetStateDatabaseForTests } from '../../server/state/database.js';
import { WEB_WORKER_NAMESPACE } from '../../server/web/server/start/webLaneResources.js';

describe('server/sync/deltaStream phase segmentation and lifecycle with real SyncEventStore', () => {
  let tmpDir: string;
  let stateDbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-deltastream-sync-'));
    stateDbPath = path.join(tmpDir, 'state.db');
    process.env.ADS_STATE_DB_PATH = stateDbPath;
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('yields independently replayable snapshots and preserves append/replay sequence in SQLite', () => {
    const store = new SyncEventStore({ stateDbPath });
    const laneKey = 'lane-phase-test';
    const coalescer = createDeltaStreamCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      flushIntervalMs: 0,
    });

    // Phase 1 streams and completes
    coalescer.appendDelta('Phase 1 explanation');
    coalescer.finishPhase();
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: 'phase_complete',
      payload: { type: 'phase_complete', phase: 'assistant' },
    });

    // Phase 2 streams and completes
    coalescer.appendDelta('Phase 2 explanation');
    coalescer.finishPhase();
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: 'phase_complete',
      payload: { type: 'phase_complete', phase: 'assistant' },
    });

    // Phase 3 streams (active)
    coalescer.appendDelta('Phase 3 active');

    // Read catch-up sequence from real SQLite
    const result = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(result.events.length, 5);
    const sequence = result.events.map((e) => `${e.type}:${(e.payload as any).text ?? (e.payload as any).phase}`);
    assert.deepEqual(sequence, [
      'delta_snapshot:Phase 1 explanation',
      'phase_complete:assistant',
      'delta_snapshot:Phase 2 explanation',
      'phase_complete:assistant',
      'delta_snapshot:Phase 3 active',
    ]);
    assert.match(String(result.events[0]?.eventId), /^stream:lane-phase-test:[^:]+:0$/);
    assert.match(String(result.events[2]?.eventId), /^stream:lane-phase-test:[^:]+:1$/);
    assert.match(String(result.events[4]?.eventId), /^stream:lane-phase-test:[^:]+:2$/);

    // Terminal event finish() only retires active Phase 3, keeping sealed Phase 1 and 2
    coalescer.finish();
    const afterTerminal = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(afterTerminal.events.length, 4);
    const terminalSeq = afterTerminal.events.map((e) => `${e.type}:${(e.payload as any).text ?? (e.payload as any).phase}`);
    assert.deepEqual(terminalSeq, [
      'delta_snapshot:Phase 1 explanation',
      'phase_complete:assistant',
      'delta_snapshot:Phase 2 explanation',
      'phase_complete:assistant',
    ]);
  });

  it('does not collide IDs or overwrite sealed snapshots across turns after finish()', () => {
    const store = new SyncEventStore({ stateDbPath });
    const laneKey = 'lane-turn-collision-test';
    const coalescer = createDeltaStreamCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      flushIntervalMs: 0,
    });

    // Turn 1 Phase 0 streams and seals
    coalescer.appendDelta('Turn 1 Phase 0 sealed');
    coalescer.finishPhase();
    store.append({
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      type: 'phase_complete',
      payload: { type: 'phase_complete', phase: 'assistant' },
    });

    // Turn 1 finishes
    coalescer.finish();

    // Verify Turn 1 sealed snapshot exists
    let read = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(read.events.length, 2);
    assert.match(String(read.events[0]?.eventId), /^stream:lane-turn-collision-test:[^:]+:0$/);
    assert.equal((read.events[0]?.payload as any).text, 'Turn 1 Phase 0 sealed');

    // Turn 2 begins!
    coalescer.appendDelta('Turn 2 Phase 0');
    read = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });

    // Turn 2 must NOT overwrite Turn 1 sealed phase 0
    assert.equal(read.events.length, 3);
    assert.match(String(read.events[0]?.eventId), /^stream:lane-turn-collision-test:[^:]+:0$/);
    assert.equal((read.events[0]?.payload as any).text, 'Turn 1 Phase 0 sealed');
    assert.match(String(read.events[2]?.eventId), /^stream:lane-turn-collision-test:[^:]+:1$/);
    assert.equal((read.events[2]?.payload as any).text, 'Turn 2 Phase 0');

    // Turn 2 completes and terminal finish() cleans active Turn 2 snapshot
    coalescer.finish();
    read = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });
    assert.equal(read.events.length, 2);
    assert.match(String(read.events[0]?.eventId), /^stream:lane-turn-collision-test:[^:]+:0$/);

    // Now simulate reconnect: a brand new coalescer is created on the same lane
    const coalescerReconnect = createDeltaStreamCoalescer({
      store,
      namespace: WEB_WORKER_NAMESPACE,
      laneKey,
      flushIntervalMs: 0,
    });
    coalescerReconnect.appendDelta('Reconnect turn delta');
    read = store.readAfter({ namespace: WEB_WORKER_NAMESPACE, laneKey, afterSeq: 0 });

    // Reconnected coalescer must pick non-colliding phase beyond existing sealed phases
    assert.equal(read.events.length, 3);
    assert.match(String(read.events[0]?.eventId), /^stream:lane-turn-collision-test:[^:]+:0$/);
    assert.equal((read.events[0]?.payload as any).text, 'Turn 1 Phase 0 sealed');
    assert.match(String(read.events[2]?.eventId), /^stream:lane-turn-collision-test:[^:]+:0$/);
    assert.equal((read.events[2]?.payload as any).text, 'Reconnect turn delta');
  });
});
