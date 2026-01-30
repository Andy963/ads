import type { VectorQueryHit } from "./types.js";

export function takeLastWins(entries: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.key || !entry.value) continue;
    map.set(entry.key, entry.value);
  }
  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
}

export function toHit(raw: unknown): VectorQueryHit | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const hit: VectorQueryHit = { id };
  const scoreRaw = record.score;
  if (typeof scoreRaw === "number") hit.score = scoreRaw;
  if (typeof scoreRaw === "string") {
    const parsed = Number.parseFloat(scoreRaw);
    if (Number.isFinite(parsed)) hit.score = parsed;
  }
  const metadataRaw = record.metadata;
  if (metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)) {
    hit.metadata = metadataRaw as Record<string, unknown>;
  }
  if (typeof record.snippet === "string") hit.snippet = record.snippet;
  if (typeof record.text_preview === "string" && !hit.snippet) hit.snippet = record.text_preview;
  if (typeof record.text === "string") hit.text = record.text;
  return hit;
}

export function isStaleFileHit(hit: VectorQueryHit, fileHashes: Map<string, string>): boolean {
  const md = hit.metadata ?? {};
  const sourceType = md["source_type"];
  if (sourceType !== "spec" && sourceType !== "adr") return false;
  const path = typeof md["path"] === "string" ? md["path"] : "";
  const contentHash = typeof md["content_hash"] === "string" ? md["content_hash"] : "";
  if (!path || !contentHash) return false;
  const current = fileHashes.get(path);
  if (!current) return false;
  return current !== contentHash;
}

export function splitBatches<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export function applyRerankOrder(hits: VectorQueryHit[], ranked: Array<{ id: string; score?: number }>): VectorQueryHit[] {
  const remaining = new Map<string, VectorQueryHit>();
  hits.forEach((hit) => remaining.set(hit.id, hit));

  const ordered: VectorQueryHit[] = [];
  for (const entry of ranked) {
    const hit = remaining.get(entry.id);
    if (!hit) {
      continue;
    }
    remaining.delete(entry.id);
    if (entry.score !== undefined) {
      hit.rerankScore = entry.score;
    }
    ordered.push(hit);
  }

  for (const hit of hits) {
    if (!remaining.has(hit.id)) {
      continue;
    }
    ordered.push(hit);
    remaining.delete(hit.id);
  }

  return ordered;
}

