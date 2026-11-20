import type { Database as DatabaseType } from "better-sqlite3";

export interface ReviewQueueLeaseRecord {
  project_id: string;
  owner_id: string;
  expires_at: number;
  updated_at: number;
}

function normalizeTtl(ttlMs: number): number {
  return Number.isFinite(ttlMs) ? Math.max(1, Math.floor(ttlMs)) : 1;
}

export function getReviewQueueLease(
  db: DatabaseType,
  projectId: string,
): ReviewQueueLeaseRecord | null {
  return (db.prepare(`
    SELECT project_id, owner_id, expires_at, updated_at
    FROM review_queue_leases
    WHERE project_id = ?
  `).get(projectId) as ReviewQueueLeaseRecord | undefined) ?? null;
}

/**
 * Acquire or renew a project-level lease. SQLite serializes the write, so two
 * processes cannot both observe an expired lease and take ownership.
 */
export function acquireReviewQueueLease(
  db: DatabaseType,
  projectId: string,
  ownerId: string,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const expiresAt = now + normalizeTtl(ttlMs);
  const result = db.prepare(`
    INSERT INTO review_queue_leases (project_id, owner_id, expires_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE review_queue_leases.owner_id = ?
       OR review_queue_leases.expires_at <= ?
  `).run(projectId, ownerId, expiresAt, now, ownerId, now) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function renewReviewQueueLease(
  db: DatabaseType,
  projectId: string,
  ownerId: string,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const result = db.prepare(`
    UPDATE review_queue_leases
    SET expires_at = ?, updated_at = ?
    WHERE project_id = ? AND owner_id = ?
  `).run(now + normalizeTtl(ttlMs), now, projectId, ownerId) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function releaseReviewQueueLease(
  db: DatabaseType,
  projectId: string,
  ownerId: string,
): void {
  db.prepare(`
    DELETE FROM review_queue_leases
    WHERE project_id = ? AND owner_id = ?
  `).run(projectId, ownerId);
}
