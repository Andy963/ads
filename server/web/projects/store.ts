import type { Database as DatabaseType } from "better-sqlite3";

export type WebProjectRecord = {
  id: string;
  workspaceRoot: string;
  name: string;
  chatSessionId: string;
  createdAt: number;
  updatedAt: number;
};

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeTimestamp(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requireStringField(field: string, value: unknown): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function toWebProjectRecord(row: Partial<WebProjectRecord> | null | undefined): WebProjectRecord | null {
  if (!row) {
    return null;
  }
  const id = normalizeString(row.id);
  const workspaceRoot = normalizeString(row.workspaceRoot);
  const name = normalizeString(row.name);
  if (!id || !workspaceRoot || !name) {
    return null;
  }
  return {
    id,
    workspaceRoot,
    name,
    chatSessionId: normalizeString(row.chatSessionId) || "main",
    createdAt: normalizeTimestamp(row.createdAt),
    updatedAt: normalizeTimestamp(row.updatedAt),
  };
}

function getWebProjectRecord(db: DatabaseType, userId: string, projectId: string): WebProjectRecord | null {
  const userKey = normalizeString(userId);
  const projectKey = normalizeString(projectId);
  if (!userKey || !projectKey) {
    return null;
  }
  const row = db
    .prepare(
      `
        SELECT
          project_id AS id,
          workspace_root AS workspaceRoot,
          display_name AS name,
          chat_session_id AS chatSessionId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM web_projects
        WHERE user_id = ? AND project_id = ?
        LIMIT 1
      `,
    )
    .get(userKey, projectKey) as Partial<WebProjectRecord> | undefined;
  return toWebProjectRecord(row);
}

export function listWebProjects(db: DatabaseType, userId: string): WebProjectRecord[] {
  const userKey = normalizeString(userId);
  if (!userKey) {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT
          project_id AS id,
          workspace_root AS workspaceRoot,
          display_name AS name,
          chat_session_id AS chatSessionId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM web_projects
        WHERE user_id = ?
        ORDER BY sort_order ASC, updated_at DESC, created_at DESC, project_id ASC
      `,
    )
    .all(userKey) as Array<Partial<WebProjectRecord>>;

  return rows.flatMap((row) => {
    const project = toWebProjectRecord(row);
    return project ? [project] : [];
  });
}

function getNextProjectSortOrder(db: DatabaseType, userId: string): number {
  const uid = normalizeString(userId);
  if (!uid) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM web_projects WHERE user_id = ?`)
    .get(uid) as { nextSortOrder?: unknown } | undefined;
  const next = Number(row?.nextSortOrder ?? 0);
  return Number.isFinite(next) && next >= 0 ? next : 0;
}

export function reorderWebProjects(db: DatabaseType, userId: string, ids: string[]): void {
  const uid = normalizeString(userId);
  if (!uid) return;

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const pid = normalizeString(id);
    if (!pid) continue;
    if (pid === "default") {
      throw new Error("default project cannot be reordered");
    }
    if (seen.has(pid)) continue;
    seen.add(pid);
    ordered.push(pid);
  }
  if (ordered.length === 0) return;

  const existingRows = db
    .prepare(`SELECT project_id AS id FROM web_projects WHERE user_id = ? ORDER BY sort_order ASC, updated_at DESC, created_at DESC, project_id ASC`)
    .all(uid) as Array<{ id?: unknown }>;
  const existing = existingRows.map((row) => String(row.id ?? "").trim()).filter(Boolean);
  if (existing.length === 0) return;

  const existingSet = new Set(existing);
  for (const id of ordered) {
    if (!existingSet.has(id)) {
      throw new Error(`Unknown project id: ${id}`);
    }
  }
  const nextOrder = [...ordered, ...existing.filter((id) => !seen.has(id))].filter((id) => existingSet.has(id));

  const update = db.prepare(`UPDATE web_projects SET sort_order = ? WHERE user_id = ? AND project_id = ?`);
  const tx = db.transaction(() => {
    let idx = 0;
    for (const id of nextOrder) {
      update.run(idx, uid, id);
      idx += 1;
    }
  });
  tx();
}

export function getWebProjectWorkspaceRoot(db: DatabaseType, userId: string, projectId: string): string | null {
  return getWebProjectRecord(db, userId, projectId)?.workspaceRoot ?? null;
}

export function getActiveWebProjectId(db: DatabaseType, userId: string): string | null {
  const userKey = normalizeString(userId);
  if (!userKey) {
    return null;
  }
  const row = db.prepare(`SELECT active_project_id AS id FROM web_user_settings WHERE user_id = ? LIMIT 1`).get(userKey) as
    | { id?: unknown }
    | undefined;
  const id = normalizeString(row?.id);
  return id || null;
}

export function setActiveWebProjectId(db: DatabaseType, userId: string, projectId: string | null, now = Date.now()): void {
  const normalizedUserId = normalizeString(userId);
  if (!normalizedUserId) {
    return;
  }
  const normalizedProjectId = projectId == null ? null : normalizeString(projectId);
  db.prepare(
    `
      INSERT INTO web_user_settings (user_id, active_project_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        active_project_id = excluded.active_project_id,
        updated_at = excluded.updated_at
    `,
  ).run(normalizedUserId, normalizedProjectId, now);
}

export function upsertWebProject(
  db: DatabaseType,
  args: { userId: string; projectId: string; workspaceRoot: string; name: string; chatSessionId?: string },
  now = Date.now(),
): WebProjectRecord {
  const userId = requireStringField("userId", args.userId);
  const projectId = requireStringField("projectId", args.projectId);
  const workspaceRoot = requireStringField("workspaceRoot", args.workspaceRoot);
  const name = requireStringField("name", args.name);
  const chatSessionId = normalizeString(args.chatSessionId) || "main";

  const existing = db
    .prepare(
      `SELECT created_at AS createdAt, sort_order AS sortOrder FROM web_projects WHERE user_id = ? AND project_id = ? LIMIT 1`,
    )
    .get(userId, projectId) as { createdAt?: unknown; sortOrder?: unknown } | undefined;
  const createdAt = normalizeTimestamp(existing?.createdAt, now);
  const sortOrder =
    typeof existing?.sortOrder === "number" && Number.isFinite(existing.sortOrder) ? existing.sortOrder : getNextProjectSortOrder(db, userId);

  db.prepare(
    `
      INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET
        workspace_root = excluded.workspace_root,
        display_name = excluded.display_name,
        chat_session_id = excluded.chat_session_id,
        updated_at = excluded.updated_at
    `,
  ).run(userId, projectId, workspaceRoot, name, chatSessionId, sortOrder, createdAt, now);

  return { id: projectId, workspaceRoot, name, chatSessionId, createdAt, updatedAt: now };
}

export function deleteWebProject(db: DatabaseType, userId: string, projectId: string): boolean {
  const uid = normalizeString(userId);
  const pid = normalizeString(projectId);
  if (!uid || !pid) {
    return false;
  }
  const result = db.prepare(`DELETE FROM web_projects WHERE user_id = ? AND project_id = ?`).run(uid, pid) as { changes?: number };
  return Boolean(result && result.changes === 1);
}

export function updateWebProject(
  db: DatabaseType,
  args: { userId: string; projectId: string; name?: string; chatSessionId?: string },
  now = Date.now(),
): WebProjectRecord | null {
  const userId = normalizeString(args.userId);
  const projectId = normalizeString(args.projectId);
  if (!userId || !projectId) {
    return null;
  }

  const current = getWebProjectRecord(db, userId, projectId);
  if (!current) {
    return null;
  }

  const name = normalizeString(args.name) || current.name || "Project";
  const chatSessionId = normalizeString(args.chatSessionId) || current.chatSessionId || "main";

  db.prepare(
    `
      UPDATE web_projects
      SET display_name = ?, chat_session_id = ?, updated_at = ?
      WHERE user_id = ? AND project_id = ?
    `,
  ).run(name, chatSessionId, now, userId, projectId);

  return {
    id: current.id,
    workspaceRoot: current.workspaceRoot,
    name,
    chatSessionId,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}
