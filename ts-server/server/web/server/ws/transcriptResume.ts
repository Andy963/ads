import type { SyncEventStore } from "../sync/store.js";

export type TranscriptResume = { afterSeq: number; laneGeneration: number };

export function parseTranscriptResume(url: string | undefined): TranscriptResume | undefined {
  let query: URLSearchParams;
  try { query = new URL(url ?? "/ws", "http://localhost").searchParams; } catch { return undefined; }
  const afterSeq = query.get("afterSeq");
  const generation = query.get("laneGeneration");
  if (!afterSeq || !generation || !/^\d+$/.test(afterSeq) || !/^\d+$/.test(generation)) return undefined;
  const value = { afterSeq: Number(afterSeq), laneGeneration: Number(generation) };
  return Number.isSafeInteger(value.afterSeq) && Number.isSafeInteger(value.laneGeneration) && value.laneGeneration >= 1
    ? value : undefined;
}

export function canResumeTranscript(args: {
  resume?: TranscriptResume;
  laneGeneration?: number;
  hasHistory: boolean;
  sync?: { store: Pick<SyncEventStore, "readAfterLanes">; namespace: string; laneKeys: string[] };
}): boolean {
  const { resume, sync } = args;
  if (!resume || !sync || resume.laneGeneration !== args.laneGeneration) return false;
  // A zero cursor cannot prove coverage of imported/legacy unsequenced history.
  if (resume.afterSeq === 0 && args.hasHistory) return false;
  const result = sync.store.readAfterLanes({
    namespace: sync.namespace, laneKeys: sync.laneKeys, afterSeq: resume.afterSeq, limit: 1,
  });
  return !result.truncated && resume.afterSeq <= result.latestSeq;
}
