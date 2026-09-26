import { createHash } from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

export type PromptQueueStatus = "queued" | "running" | "completed" | "failed";

export type PromptQueueEntry = {
  id: number;
  clientMessageId: string;
  authUserId: string;
  userId: number;
  sessionId: string;
  chatSessionId: string;
  historyKey: string;
  logicalHistoryKey: string;
  laneNamespace: string;
  laneGeneration: number;
  workspaceRoot: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: PromptQueueStatus;
  position: number;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type PromptQueueLane = {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  historyKey: string;
  logicalHistoryKey: string;
  laneNamespace: string;
  laneGeneration: number;
};

export type CancelPromptInput = PromptQueueLane & {
  clientMessageId: string;
  userId: number;
};

export type CancelPromptResult = {
  cancelled: boolean;
  reason: "cancelled" | "already_cancelled" | "not_queued";
  entry: PromptQueueEntry | null;
};

export type EnqueuePromptInput = PromptQueueLane & {
  clientMessageId: string;
  userId: number;
  workspaceRoot: string;
  payload: Record<string, unknown>;
  retryFailed?: boolean;
  createdAt?: number;
};

export type PromptQueueOwnershipClaim = {
  claimed: boolean;
  previousOwnerId: string | null;
};

export const INTERRUPTED_PROMPT_ERROR =
  "Prompt execution was interrupted before completion. Retry explicitly to resume with incomplete-turn recovery.";

export function ensurePromptQueueTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_message_id TEXT NOT NULL UNIQUE,
      auth_user_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      history_key TEXT NOT NULL,
      logical_history_key TEXT NOT NULL,
      lane_namespace TEXT NOT NULL,
      lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
      workspace_root TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      lease_owner TEXT,
      lease_expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_queue_lane_fifo
      ON prompt_queue(auth_user_id, session_id, chat_session_id, logical_history_key, lane_generation, status, id);

    CREATE INDEX IF NOT EXISTS idx_prompt_queue_active
      ON prompt_queue(status, id);

    CREATE TABLE IF NOT EXISTS prompt_queue_ownership (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      owner_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
      lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_queue_cancellations (
      client_message_id TEXT PRIMARY KEY,
      auth_user_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      chat_session_id TEXT NOT NULL,
      logical_history_key TEXT NOT NULL,
      lane_namespace TEXT NOT NULL,
      lane_generation INTEGER NOT NULL CHECK(lane_generation >= 1),
      cancelled_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_queue_cancellations_scope
      ON prompt_queue_cancellations(auth_user_id, session_id, chat_session_id, logical_history_key);
  `);

  const columns = db.prepare("PRAGMA table_info(prompt_queue)").all() as Array<{ name?: unknown }>;
  if (!columns.some((column) => String(column.name ?? "") === "payload_hash")) {
    db.exec("ALTER TABLE prompt_queue ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
  }
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
}

function parsePayload(value: unknown): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "{}"));
  } catch {
    throw new Error("Stored prompt payload is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored prompt payload must be an object");
  }
  return parsed as Record<string, unknown>;
}

function canonicalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizePayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "replay_incomplete") continue;
    normalized[key] = canonicalizePayload(record[key]);
  }
  return normalized;
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalizePayload(payload))).digest("hex");
}

function samePromptScope(entry: Pick<PromptQueueEntry, "authUserId" | "userId" | "sessionId" | "chatSessionId" | "logicalHistoryKey" | "laneNamespace" | "laneGeneration">, input: CancelPromptInput): boolean {
  return entry.authUserId === input.authUserId
    && entry.userId === Math.floor(Number(input.userId))
    && entry.sessionId === input.sessionId
    && entry.chatSessionId === input.chatSessionId
    && entry.logicalHistoryKey === input.logicalHistoryKey
    && entry.laneNamespace === input.laneNamespace;
}

function toEntry(row: Record<string, unknown>): PromptQueueEntry {
  const status = String(row.status ?? "queued") as PromptQueueStatus;
  return {
    id: Number(row.id),
    clientMessageId: String(row.client_message_id),
    authUserId: String(row.auth_user_id),
    userId: Number(row.user_id),
    sessionId: String(row.session_id),
    chatSessionId: String(row.chat_session_id),
    historyKey: String(row.history_key),
    logicalHistoryKey: String(row.logical_history_key),
    laneNamespace: String(row.lane_namespace),
    laneGeneration: Number(row.lane_generation),
    workspaceRoot: String(row.workspace_root),
    payload: parsePayload(row.payload_json),
    payloadHash: String(row.payload_hash ?? ""),
    status,
    position: Number(row.position ?? 0),
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

export function createPromptQueueStore(db: DatabaseType) {
  ensurePromptQueueTables(db);

  const insertStmt = db.prepare(`
    INSERT INTO prompt_queue (
      client_message_id, auth_user_id, user_id, session_id, chat_session_id,
      history_key, logical_history_key, lane_namespace, lane_generation,
      workspace_root, payload_json, payload_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `);
  const getByClientMessageIdStmt = db.prepare(`
    SELECT *, 0 AS position
    FROM prompt_queue
    WHERE client_message_id = ?
    LIMIT 1
  `);
  const getCancellationStmt = db.prepare(`
    SELECT *
    FROM prompt_queue_cancellations
    WHERE client_message_id = ?
    LIMIT 1
  `);
  const insertCancellationStmt = db.prepare(`
    INSERT INTO prompt_queue_cancellations (
      client_message_id, auth_user_id, user_id, session_id, chat_session_id,
      logical_history_key, lane_namespace, lane_generation, cancelled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deletePromptStmt = db.prepare(`
    DELETE FROM prompt_queue
    WHERE client_message_id = ? AND status = 'queued'
  `);
  const listLaneStmt = db.prepare(`
    SELECT *, (
      SELECT COUNT(*)
      FROM prompt_queue earlier
      WHERE earlier.auth_user_id = prompt_queue.auth_user_id
        AND earlier.session_id = prompt_queue.session_id
        AND earlier.chat_session_id = prompt_queue.chat_session_id
        AND earlier.logical_history_key = prompt_queue.logical_history_key
        AND earlier.lane_generation = prompt_queue.lane_generation
        AND earlier.status IN ('queued', 'running')
        AND earlier.id <= prompt_queue.id
    ) AS position
    FROM prompt_queue
    WHERE auth_user_id = ?
      AND session_id = ?
      AND chat_session_id = ?
      AND logical_history_key = ?
      AND lane_generation = ?
      AND status IN ('queued', 'running', 'completed', 'failed')
    ORDER BY id ASC
  `);
  const listLogicalLaneStmt = db.prepare(`
    SELECT *, (
      SELECT COUNT(*)
      FROM prompt_queue earlier
      WHERE earlier.auth_user_id = prompt_queue.auth_user_id
        AND earlier.session_id = prompt_queue.session_id
        AND earlier.chat_session_id = prompt_queue.chat_session_id
        AND earlier.logical_history_key = prompt_queue.logical_history_key
        AND earlier.status IN ('queued', 'running')
        AND earlier.id <= prompt_queue.id
    ) AS position
    FROM prompt_queue
    WHERE auth_user_id = ?
      AND session_id = ?
      AND chat_session_id = ?
      AND logical_history_key = ?
      AND status IN ('queued', 'running', 'completed', 'failed')
    ORDER BY id ASC
  `);
  const listRecoverableStmt = db.prepare(`
    SELECT *, 0 AS position
    FROM prompt_queue
    WHERE status = 'queued'
    ORDER BY id ASC
  `);
  const listInterruptedStmt = db.prepare(`
    SELECT *, 0 AS position
    FROM prompt_queue
    WHERE status = 'running'
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
    ORDER BY id ASC
  `);
  const markRunningStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?,
        lease_owner = ?, lease_expires_at = ?, last_error = NULL
    WHERE id = ? AND status = 'queued'
      AND EXISTS (
        SELECT 1 FROM prompt_queue_ownership
        WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
      )
  `);
  const markCompletedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'completed', payload_json = '{}', updated_at = ?, completed_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running' AND lease_owner = ?
      AND EXISTS (
        SELECT 1 FROM prompt_queue_ownership
        WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
      )
  `);
  const markFailedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'failed', updated_at = ?, completed_at = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status IN ('queued', 'running')
      AND EXISTS (
        SELECT 1 FROM prompt_queue_ownership
        WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
      )
  `);
  const retryFailedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'queued', payload_json = ?, payload_hash = ?,
        last_error = NULL, created_at = ?, updated_at = ?, started_at = NULL, completed_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'failed'
  `);
  const completeInterruptedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'completed', payload_json = '{}', updated_at = ?, completed_at = ?,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running'
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
      AND EXISTS (
        SELECT 1 FROM prompt_queue_ownership
        WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
      )
  `);
  const failInterruptedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'failed', updated_at = ?, completed_at = ?, last_error = ?,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running'
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
      AND EXISTS (
        SELECT 1 FROM prompt_queue_ownership
        WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
      )
  `);
  const getOwnershipStmt = db.prepare(`
    SELECT owner_id, owner_pid, lease_expires_at
    FROM prompt_queue_ownership
    WHERE id = 1
  `);
  const insertOwnershipStmt = db.prepare(`
    INSERT INTO prompt_queue_ownership (id, owner_id, owner_pid, lease_expires_at, updated_at)
    VALUES (1, ?, ?, ?, ?)
  `);
  const updateOwnershipStmt = db.prepare(`
    UPDATE prompt_queue_ownership
    SET owner_id = ?, owner_pid = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = 1 AND owner_id = ?
  `);
  const releaseOwnershipStmt = db.prepare(`
    DELETE FROM prompt_queue_ownership
    WHERE id = 1 AND owner_id = ?
  `);
  const isOwnershipCurrentStmt = db.prepare(`
    SELECT 1
    FROM prompt_queue_ownership
    WHERE id = 1 AND owner_id = ? AND lease_expires_at > ?
    LIMIT 1
  `);

  const getByClientMessageId = (clientMessageId: string): PromptQueueEntry | null => {
    const id = requiredText(clientMessageId, "clientMessageId");
    const row = getByClientMessageIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? toEntry(row) : null;
  };

  const isCancelled = (clientMessageId: string, input: CancelPromptInput): boolean => {
    const row = getCancellationStmt.get(requiredText(clientMessageId, "clientMessageId")) as Record<string, unknown> | undefined;
    if (!row) return false;
    const cancellation = {
      authUserId: String(row.auth_user_id),
      userId: Number(row.user_id),
      sessionId: String(row.session_id),
      chatSessionId: String(row.chat_session_id),
      logicalHistoryKey: String(row.logical_history_key),
      laneNamespace: String(row.lane_namespace),
      laneGeneration: Number(row.lane_generation),
    };
    if (!samePromptScope(cancellation, input)) {
      throw new Error("clientMessageId is already associated with a different prompt scope");
    }
    return true;
  };

  const enqueue = (input: EnqueuePromptInput): { entry: PromptQueueEntry; duplicate: boolean } => {
    const clientMessageId = requiredText(input.clientMessageId, "clientMessageId");
    const payloadHash = hashPayload(input.payload);
    const scope = {
      authUserId: requiredText(input.authUserId, "authUserId"),
      userId: Math.floor(Number(input.userId)),
      sessionId: requiredText(input.sessionId, "sessionId"),
      chatSessionId: requiredText(input.chatSessionId, "chatSessionId"),
      historyKey: requiredText(input.historyKey, "historyKey"),
      logicalHistoryKey: requiredText(input.logicalHistoryKey, "logicalHistoryKey"),
      laneNamespace: requiredText(input.laneNamespace, "laneNamespace"),
      laneGeneration: Math.max(1, Math.floor(Number(input.laneGeneration))),
      workspaceRoot: requiredText(input.workspaceRoot, "workspaceRoot"),
    };
    if (isCancelled(clientMessageId, { ...scope, clientMessageId, userId: scope.userId })) {
      throw new Error("clientMessageId was cancelled");
    }
    const existing = getByClientMessageId(clientMessageId);
    if (existing) {
      const sameScope = existing.authUserId === scope.authUserId
        && existing.userId === scope.userId
        && existing.sessionId === scope.sessionId
        && existing.chatSessionId === scope.chatSessionId
        && existing.historyKey === scope.historyKey
        && existing.logicalHistoryKey === scope.logicalHistoryKey
        && existing.laneNamespace === scope.laneNamespace
        && existing.laneGeneration === scope.laneGeneration
        && existing.workspaceRoot === scope.workspaceRoot;
      if (!sameScope) {
        throw new Error("clientMessageId is already associated with a different prompt scope");
      }
      if (existing.payloadHash && existing.payloadHash !== payloadHash) {
        throw new Error("clientMessageId is already associated with a different prompt payload");
      }
      if (existing.status === "failed" && input.retryFailed) {
        const now = Date.now();
        const changed = retryFailedStmt.run(JSON.stringify(input.payload), payloadHash, now, now, existing.id).changes;
        if (changed === 1) {
          return {
            entry: getByClientMessageId(clientMessageId) ?? { ...existing, status: "queued" },
            duplicate: false,
          };
        }
      }
      return { entry: existing, duplicate: true };
    }
    const now = Number.isFinite(input.createdAt) ? Math.floor(Number(input.createdAt)) : Date.now();
    const result = insertStmt.run(
      clientMessageId,
      scope.authUserId,
      scope.userId,
      scope.sessionId,
      scope.chatSessionId,
      scope.historyKey,
      scope.logicalHistoryKey,
      scope.laneNamespace,
      scope.laneGeneration,
      scope.workspaceRoot,
      JSON.stringify(input.payload),
      payloadHash,
      now,
      now,
    );
    const entry = getByClientMessageId(clientMessageId);
    if (!entry) {
      throw new Error(`Prompt queue insert failed: ${String(result.lastInsertRowid ?? "unknown")}`);
    }
    return { entry, duplicate: false };
  };

  const listLane = (lane: PromptQueueLane): PromptQueueEntry[] => {
    const rows = listLaneStmt.all(
      requiredText(lane.authUserId, "authUserId"),
      requiredText(lane.sessionId, "sessionId"),
      requiredText(lane.chatSessionId, "chatSessionId"),
      requiredText(lane.logicalHistoryKey, "logicalHistoryKey"),
      Math.max(1, Math.floor(Number(lane.laneGeneration))),
    ) as Record<string, unknown>[];
    return rows.map(toEntry);
  };

  const listLogicalLane = (lane: PromptQueueLane): PromptQueueEntry[] => {
    const rows = listLogicalLaneStmt.all(
      requiredText(lane.authUserId, "authUserId"),
      requiredText(lane.sessionId, "sessionId"),
      requiredText(lane.chatSessionId, "chatSessionId"),
      requiredText(lane.logicalHistoryKey, "logicalHistoryKey"),
    ) as Record<string, unknown>[];
    return rows.map(toEntry);
  };

  const listRecoverable = (): PromptQueueEntry[] =>
    (listRecoverableStmt.all() as Record<string, unknown>[]).map(toEntry);

  const listInterrupted = (previousOwnerId: string | null, now = Date.now()): PromptQueueEntry[] =>
    (listInterruptedStmt.all(now, previousOwnerId) as Record<string, unknown>[]).map(toEntry);

  const markRunning = (id: number, leaseOwner: string, now = Date.now(), leaseMs = 60_000): boolean =>
    markRunningStmt.run(
      now,
      now,
      requiredText(leaseOwner, "leaseOwner"),
      now + leaseMs,
      id,
      requiredText(leaseOwner, "leaseOwner"),
      now,
    ).changes === 1;

  const markCompleted = (id: number, leaseOwner: string, now = Date.now()): boolean =>
    markCompletedStmt.run(
      now,
      now,
      id,
      requiredText(leaseOwner, "leaseOwner"),
      requiredText(leaseOwner, "leaseOwner"),
      now,
    ).changes === 1;

  const markFailed = (id: number, error: unknown, leaseOwner: string, now = Date.now()): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    const trimmed = message.slice(0, 2_000);
    const owner = requiredText(leaseOwner, "leaseOwner");
    return markFailedStmt.run(now, now, trimmed, id, owner, now).changes === 1;
  };

  const claimOwnership = (
    ownerId: string,
    ownerPid: number,
    now = Date.now(),
    leaseMs = 60_000,
    isOwnerAlive: (pid: number) => boolean = () => false,
  ): PromptQueueOwnershipClaim => {
    const normalizedOwnerId = requiredText(ownerId, "ownerId");
    const normalizedPid = Math.floor(Number(ownerPid));
    if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
      throw new Error("ownerPid must be a positive integer");
    }
    const claimTx = db.transaction((): PromptQueueOwnershipClaim => {
      const row = getOwnershipStmt.get() as
        | { owner_id?: unknown; owner_pid?: unknown; lease_expires_at?: unknown }
        | undefined;
      if (!row) {
        insertOwnershipStmt.run(normalizedOwnerId, normalizedPid, now + leaseMs, now);
        return { claimed: true, previousOwnerId: null };
      }
      const existingOwnerId = String(row.owner_id ?? "");
      if (existingOwnerId === normalizedOwnerId) {
        updateOwnershipStmt.run(normalizedOwnerId, normalizedPid, now + leaseMs, now, existingOwnerId);
        return { claimed: true, previousOwnerId: null };
      }
      const existingPid = Math.floor(Number(row.owner_pid));
      const leaseExpiresAt = Number(row.lease_expires_at);
      const ownerIsAlive = leaseExpiresAt > now && Number.isInteger(existingPid) && isOwnerAlive(existingPid);
      if (ownerIsAlive) {
        return { claimed: false, previousOwnerId: existingOwnerId };
      }
      const changed = updateOwnershipStmt.run(
        normalizedOwnerId,
        normalizedPid,
        now + leaseMs,
        now,
        existingOwnerId,
      ).changes;
      return { claimed: changed === 1, previousOwnerId: changed === 1 ? existingOwnerId : null };
    });
    return claimTx.immediate();
  };

  const releaseOwnership = (ownerId: string): boolean =>
    releaseOwnershipStmt.run(requiredText(ownerId, "ownerId")).changes === 1;

  const isOwnershipCurrent = (ownerId: string, now = Date.now()): boolean =>
    isOwnershipCurrentStmt.get(requiredText(ownerId, "ownerId"), now) !== undefined;

  const completeInterrupted = (
    id: number,
    ownerId: string,
    previousOwnerId: string | null,
    now = Date.now(),
  ): boolean => completeInterruptedStmt.run(
    now,
    now,
    id,
    now,
    previousOwnerId,
    requiredText(ownerId, "ownerId"),
    now,
  ).changes === 1;

  const failInterrupted = (
    id: number,
    ownerId: string,
    previousOwnerId: string | null,
    error: unknown,
    now = Date.now(),
  ): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return failInterruptedStmt.run(
      now,
      now,
      message.slice(0, 2_000),
      id,
      now,
      previousOwnerId,
      requiredText(ownerId, "ownerId"),
      now,
    ).changes === 1;
  };

  const cancel = (input: CancelPromptInput, now = Date.now()): CancelPromptResult => {
    const clientMessageId = requiredText(input.clientMessageId, "clientMessageId");
    const normalizedInput: CancelPromptInput = {
      ...input,
      clientMessageId,
      authUserId: requiredText(input.authUserId, "authUserId"),
      userId: Math.floor(Number(input.userId)),
      sessionId: requiredText(input.sessionId, "sessionId"),
      chatSessionId: requiredText(input.chatSessionId, "chatSessionId"),
      historyKey: requiredText(input.historyKey, "historyKey"),
      logicalHistoryKey: requiredText(input.logicalHistoryKey, "logicalHistoryKey"),
      laneNamespace: requiredText(input.laneNamespace, "laneNamespace"),
      laneGeneration: Math.max(1, Math.floor(Number(input.laneGeneration))),
    };
    const cancelTx = db.transaction((): CancelPromptResult => {
      const existing = getByClientMessageIdStmt.get(clientMessageId) as Record<string, unknown> | undefined;
      const existingEntry = existing ? toEntry(existing) : null;
      if (existingEntry && !samePromptScope(existingEntry, normalizedInput)) {
        throw new Error("clientMessageId is already associated with a different prompt scope");
      }
      // A prompt leaves the queue the moment the lane marks it running, so the
      // frontend can only ever cancel a row that is still waiting. Touching a
      // running row here would pull the floor out from under an in-flight turn.
      if (existingEntry && existingEntry.status !== "queued") {
        return { cancelled: false, reason: "not_queued", entry: existingEntry };
      }
      if (isCancelled(clientMessageId, normalizedInput)) {
        return { cancelled: false, reason: "already_cancelled", entry: existingEntry };
      }
      insertCancellationStmt.run(
        clientMessageId,
        normalizedInput.authUserId,
        normalizedInput.userId,
        normalizedInput.sessionId,
        normalizedInput.chatSessionId,
        normalizedInput.logicalHistoryKey,
        normalizedInput.laneNamespace,
        normalizedInput.laneGeneration,
        now,
      );
      if (existingEntry) deletePromptStmt.run(clientMessageId);
      return { cancelled: true, reason: "cancelled", entry: existingEntry };
    });
    return cancelTx.immediate();
  };

  return {
    enqueue,
    getByClientMessageId,
    listLane,
    listLogicalLane,
    listRecoverable,
    listInterrupted,
    markRunning,
    markCompleted,
    markFailed,
    claimOwnership,
    releaseOwnership,
    isOwnershipCurrent,
    completeInterrupted,
    failInterrupted,
    cancel,
  };
}

export type PromptQueueStore = ReturnType<typeof createPromptQueueStore>;
