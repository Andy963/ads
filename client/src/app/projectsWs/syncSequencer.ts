function readSequence(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const seq = Number((payload as Record<string, unknown>).seq);
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : null;
}

function readAfterSequence(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = Number((payload as Record<string, unknown>).afterSeq);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function normalizeCursor(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

type PendingLive = {
  afterSeq: number | null;
  arrivalOrder: number;
  apply: () => void;
};

export type SyncEventSequencer = ReturnType<typeof createSyncEventSequencer>;

/**
 * Serializes cursor-based HTTP catch-up with frames arriving on the live
 * socket at the same time.
 *
 * A transient frame carrying `afterSeq = N` was produced after all persisted
 * events through N. It is therefore released only after the cursor reaches N.
 * Frames without a barrier are held until the catch-up transaction completes.
 * The caller can explicitly mark protocol/control frames as `immediate`; this
 * is used for `welcome`, which must establish the catch-up boundary before any
 * other frame is observed.
 */
export function createSyncEventSequencer(args: {
  initialCursor: number;
  writeCursor: (seq: number) => void;
}) {
  let lastAppliedSeq = normalizeCursor(args.initialCursor);
  let buffering = false;
  let nextArrivalOrder = 0;
  const buffered = new Map<number, () => void>();
  const pendingLive: PendingLive[] = [];

  const sortPendingLive = (): void => {
    pendingLive.sort((left, right) => {
      const leftBarrier = left.afterSeq === null ? Number.POSITIVE_INFINITY : left.afterSeq;
      const rightBarrier = right.afterSeq === null ? Number.POSITIVE_INFINITY : right.afterSeq;
      return leftBarrier - rightBarrier || left.arrivalOrder - right.arrivalOrder;
    });
  };

  const flushReadyLive = (includeUnbarriered = false): void => {
    // Keep future-barrier frames queued. This matters when a live delta is
    // received just after the HTTP page was read: applying it immediately
    // could put it before the command whose sequence is in its barrier.
    sortPendingLive();
    for (let index = 0; index < pendingLive.length;) {
      const entry = pendingLive[index]!;
      if (entry.afterSeq === null && !includeUnbarriered) {
        index += 1;
        continue;
      }
      if (entry.afterSeq !== null && entry.afterSeq > lastAppliedSeq) {
        index += 1;
        continue;
      }
      pendingLive.splice(index, 1);
      entry.apply();
    }
  };

  const flushLiveBefore = (seq: number): void => {
    sortPendingLive();
    for (let index = 0; index < pendingLive.length;) {
      const entry = pendingLive[index]!;
      if (entry.afterSeq === null || entry.afterSeq >= seq) {
        index += 1;
        continue;
      }
      pendingLive.splice(index, 1);
      entry.apply();
    }
  };

  const commit = (seq: number, apply: () => void): boolean => {
    const normalizedSeq = normalizeCursor(seq);
    if (normalizedSeq <= lastAppliedSeq) {
      // Duplicate delivery is intentionally ignored. It is still useful to
      // release a frame whose barrier equals the already committed cursor.
      flushReadyLive();
      return false;
    }
    flushLiveBefore(normalizedSeq);
    apply();
    lastAppliedSeq = normalizedSeq;
    args.writeCursor(lastAppliedSeq);
    flushReadyLive();
    return true;
  };

  const observe = (
    payload: unknown,
    apply: () => void,
    options?: { immediate?: boolean },
  ): void => {
    if (options?.immediate) {
      apply();
      return;
    }

    const seq = readSequence(payload);
    if (seq !== null) {
      if (buffering) {
        if (seq > lastAppliedSeq && !buffered.has(seq)) buffered.set(seq, apply);
        return;
      }
      commit(seq, apply);
      return;
    }

    if (buffering) {
      pendingLive.push({
        afterSeq: readAfterSequence(payload),
        arrivalOrder: nextArrivalOrder++,
        apply,
      });
      return;
    }
    apply();
  };

  const applyCatchUp = (payload: unknown, apply: () => void): void => {
    const seq = readSequence(payload);
    if (seq === null) return;
    commit(seq, apply);
  };

  const beginCatchUp = (): void => {
    buffering = true;
  };

  const replaceWithSnapshot = (seq: number, apply: () => void): void => {
    apply();
    lastAppliedSeq = normalizeCursor(seq);
    args.writeCursor(lastAppliedSeq);
    for (const bufferedSeq of buffered.keys()) {
      if (bufferedSeq <= lastAppliedSeq) buffered.delete(bufferedSeq);
    }
    // A full snapshot covers all barriers through its cursor. Future-barrier
    // frames remain queued for the next observed sequence.
    for (let index = pendingLive.length - 1; index >= 0; index -= 1) {
      const barrier = pendingLive[index]!.afterSeq;
      if (barrier !== null && barrier <= lastAppliedSeq) pendingLive.splice(index, 1);
    }
    flushReadyLive();
  };

  const completeCatchUp = (): void => {
    const entries = [...buffered.entries()].sort(([left], [right]) => left - right);
    buffered.clear();
    for (const [seq, apply] of entries) {
      commit(seq, apply);
    }
    buffering = false;
    // Unbarriered frames are safe only after the complete catch-up
    // transaction (including all buffered sequenced events) has committed.
    flushReadyLive(true);
  };

  /**
   * Abort a request attempt. By default all queued frames are discarded (lane
   * teardown/reset semantics). `preserveLive` keeps the barrier queue and
   * leaves the sequencer buffering so a retry can replay it after the missing
   * persisted range has been fetched.
   */
  const abortCatchUp = (options?: { preserveLive?: boolean }): void => {
    buffered.clear();
    if (!options?.preserveLive) {
      pendingLive.length = 0;
      buffering = false;
      return;
    }
    buffering = true;
  };

  const resetCursor = (): void => {
    lastAppliedSeq = 0;
    buffered.clear();
    pendingLive.length = 0;
    buffering = false;
    args.writeCursor(0);
  };

  return {
    observe,
    applyCatchUp,
    beginCatchUp,
    replaceWithSnapshot,
    completeCatchUp,
    abortCatchUp,
    resetCursor,
    getLastAppliedSeq: () => lastAppliedSeq,
    isBuffering: () => buffering,
    getPendingCount: () => buffered.size + pendingLive.length,
  };
}
