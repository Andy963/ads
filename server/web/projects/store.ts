import type { Database as DatabaseType } from "better-sqlite3";

export type WebProjectRecord = {
  id: string;
  workspaceRoot: string;
  name: string;
  chatSessionId: string;
  createdAt: number;
  updatedAt: number;
};

export function listWebProjects(db: DatabaseType, userId: string): WebProjectRecord[] {
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
    .all(userId) as Array<Partial<WebProjectRecord>>;

  return rows
    .map((r) => ({
      id: String(r.id ?? "").trim(),
      workspaceRoot: String(r.workspaceRoot ?? "").trim(),
      name: String(r.name ?? "").trim(),
      chatSessionId: String(r.chatSessionId ?? "").trim() || "main",
      createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    }))
    .filter((p) => Boolean(p.id) && Boolean(p.workspaceRoot) && Boolean(p.name));
}

function getNextProjectSortOrder(db: DatabaseType, userId: string): number {
  const uid = String(userId ?? "").trim();
  if (!uid) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder FROM web_projects WHERE user_id = ?`)
    .get(uid) as { nextSortOrder?: unknown } | undefined;
  const next = Number(row?.nextSortOrder ?? 0);
  return Number.isFinite(next) && next >= 0 ? next : 0;
}

export function reorderWebProjects(db: DatabaseType, userId: string, ids: string[]): void {
  const uid = String(userId ?? "").trim();
  if (!uid) return;

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const pid = String(id ?? "").trim();
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
  const uid = String(userId ?? "").trim();
  const pid = String(projectId ?? "").trim();
  if (!uid || !pid) {
    return null;
  }
  const row = db
    .prepare(`SELECT workspace_root AS workspaceRoot FROM web_projects WHERE user_id = ? AND project_id = ? LIMIT 1`)
    .get(uid, pid) as { workspaceRoot?: unknown } | undefined;
  const root = String(row?.workspaceRoot ?? "").trim();
  return root || null;
}

export function getActiveWebProjectId(db: DatabaseType, userId: string): string | null {
  const row = db.prepare(`SELECT active_project_id AS id FROM web_user_settings WHERE user_id = ? LIMIT 1`).get(userId) as
    | { id?: unknown }
    | undefined;
  const id = String(row?.id ?? "").trim();
  return id || null;
}

export function setActiveWebProjectId(db: DatabaseType, userId: string, projectId: string | null, now = Date.now()): void {
  const normalizedUserId = String(userId ?? "").trim();
  if (!normalizedUserId) {
    return;
  }
  const normalizedProjectId = projectId == null ? null : String(projectId).trim();
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
  const userId = String(args.userId ?? "").trim();
  const projectId = String(args.projectId ?? "").trim();
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  const name = String(args.name ?? "").trim();
  const chatSessionId = String(args.chatSessionId ?? "").trim() || "main";
  if (!userId) {
    throw new Error("userId is required");
  }
  if (!projectId) {
    throw new Error("projectId is required");
  }
  if (!workspaceRoot) {
    throw new Error("workspaceRoot is required");
  }
  if (!name) {
    throw new Error("name is required");
  }

  const existing = db
    .prepare(
      `SELECT created_at AS createdAt, sort_order AS sortOrder FROM web_projects WHERE user_id = ? AND project_id = ? LIMIT 1`,
    )
    .get(userId, projectId) as { createdAt?: unknown; sortOrder?: unknown } | undefined;
  const createdAt =
    typeof existing?.createdAt === "number" && Number.isFinite(existing.createdAt) ? existing.createdAt : now;
  const sortOrder =
    typeof existing?.sortOrder === "number" && Number.isFinite(existing.sortOrder)
      ? existing.sortOrder
      : getNextProjectSortOrder(db, userId);

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
  const uid = String(userId ?? "").trim();
  const pid = String(projectId ?? "").trim();
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
  const userId = String(args.userId ?? "").trim();
  const projectId = String(args.projectId ?? "").trim();
  if (!userId || !projectId) {
    return null;
  }

  const current = db
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
    .get(userId, projectId) as Partial<WebProjectRecord> | undefined;

  if (!current) {
    return null;
  }

  const nextName = args.name == null ? String(current.name ?? "").trim() : String(args.name).trim();
  const nextChatSessionId =
    args.chatSessionId == null ? String(current.chatSessionId ?? "").trim() : String(args.chatSessionId).trim();
  const workspaceRoot = String(current.workspaceRoot ?? "").trim();
  const createdAt = typeof current.createdAt === "number" && Number.isFinite(current.createdAt) ? current.createdAt : now;

  const name = nextName || "Project";
  const chatSessionId = nextChatSessionId || "main";

  db.prepare(
    `
      UPDATE web_projects
      SET display_name = ?, chat_session_id = ?, updated_at = ?
      WHERE user_id = ? AND project_id = ?
    `,
  ).run(name, chatSessionId, now, userId, projectId);

  return { id: projectId, workspaceRoot, name, chatSessionId, createdAt, updatedAt: now };
}
