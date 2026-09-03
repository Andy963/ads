function readSequence(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const seq = Number((payload as Record<string, unknown>).seq);
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : null;
}

function normalizeCursor(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export type SyncEventSequencer = ReturnType<typeof createSyncEventSequencer>;

export function createSyncEventSequencer(args: {
  initialCursor: number;
  writeCursor: (seq: number) => void;
}) {
  let lastAppliedSeq = normalizeCursor(args.initialCursor);
  let buffering = false;
  const buffered = new Map<number, () => void>();

  const commit = (seq: number, apply: () => void): boolean => {
    if (seq <= lastAppliedSeq) return false;
    apply();
    lastAppliedSeq = seq;
    args.writeCursor(lastAppliedSeq);
    return true;
  };

  const observe = (payload: unknown, apply: () => void): void => {
    const seq = readSequence(payload);
    if (seq === null) {
      apply();
      return;
    }
    if (seq <= lastAppliedSeq) return;
    if (buffering) {
      if (!buffered.has(seq)) buffered.set(seq, apply);
      return;
    }
    commit(seq, apply);
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
  };

  const completeCatchUp = (): void => {
    const entries = [...buffered.entries()].sort(([left], [right]) => left - right);
    for (const [seq, apply] of entries) {
      commit(seq, apply);
      buffered.delete(seq);
    }
    buffering = false;
  };

  const abortCatchUp = (): void => {
    buffered.clear();
    buffering = false;
  };

  const resetCursor = (): void => {
    lastAppliedSeq = 0;
    buffering = false;
    buffered.clear();
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
  };
}
