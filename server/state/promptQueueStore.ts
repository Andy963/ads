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

export type EnqueuePromptInput = PromptQueueLane & {
  clientMessageId: string;
  userId: number;
  workspaceRoot: string;
  payload: Record<string, unknown>;
  createdAt?: number;
};

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
  `);
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
      workspace_root, payload_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `);
  const getByClientMessageIdStmt = db.prepare(`
    SELECT *, 0 AS position
    FROM prompt_queue
    WHERE client_message_id = ?
    LIMIT 1
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
  const listRecoverableStmt = db.prepare(`
    SELECT *, 0 AS position
    FROM prompt_queue
    WHERE status = 'queued'
    ORDER BY id ASC
  `);
  const markRunningStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?,
        lease_owner = ?, lease_expires_at = ?, last_error = NULL
    WHERE id = ? AND status = 'queued'
  `);
  const markCompletedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'completed', updated_at = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status = 'running'
  `);
  const markFailedStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'failed', updated_at = ?, completed_at = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ? AND status IN ('queued', 'running')
  `);
  const recoverStmt = db.prepare(`
    UPDATE prompt_queue
    SET status = 'queued', updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
    WHERE status = 'running'
  `);

  const getByClientMessageId = (clientMessageId: string): PromptQueueEntry | null => {
    const id = requiredText(clientMessageId, "clientMessageId");
    const row = getByClientMessageIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? toEntry(row) : null;
  };

  const enqueue = (input: EnqueuePromptInput): { entry: PromptQueueEntry; duplicate: boolean } => {
    const clientMessageId = requiredText(input.clientMessageId, "clientMessageId");
    const existing = getByClientMessageId(clientMessageId);
    if (existing) {
      return { entry: existing, duplicate: true };
    }
    const now = Number.isFinite(input.createdAt) ? Math.floor(Number(input.createdAt)) : Date.now();
    const result = insertStmt.run(
      clientMessageId,
      requiredText(input.authUserId, "authUserId"),
      Math.floor(Number(input.userId)),
      requiredText(input.sessionId, "sessionId"),
      requiredText(input.chatSessionId, "chatSessionId"),
      requiredText(input.historyKey, "historyKey"),
      requiredText(input.logicalHistoryKey, "logicalHistoryKey"),
      requiredText(input.laneNamespace, "laneNamespace"),
      Math.max(1, Math.floor(Number(input.laneGeneration))),
      requiredText(input.workspaceRoot, "workspaceRoot"),
      JSON.stringify(input.payload),
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

  const listRecoverable = (): PromptQueueEntry[] =>
    (listRecoverableStmt.all() as Record<string, unknown>[]).map(toEntry);

  const markRunning = (id: number, leaseOwner: string, now = Date.now(), leaseMs = 60_000): boolean =>
    markRunningStmt.run(now, now, requiredText(leaseOwner, "leaseOwner"), now + leaseMs, id).changes === 1;

  const markCompleted = (id: number, now = Date.now()): boolean =>
    markCompletedStmt.run(now, now, id).changes === 1;

  const markFailed = (id: number, error: unknown, now = Date.now()): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return markFailedStmt.run(now, now, message.slice(0, 2_000), id).changes === 1;
  };

  const recoverInterrupted = (now = Date.now()): number => recoverStmt.run(now).changes;

  return {
    enqueue,
    getByClientMessageId,
    listLane,
    listRecoverable,
    markRunning,
    markCompleted,
    markFailed,
    recoverInterrupted,
  };
}

export type PromptQueueStore = ReturnType<typeof createPromptQueueStore>;
