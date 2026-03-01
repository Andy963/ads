import type { Database as DatabaseType } from "better-sqlite3";

export function ensureWebProjectTables(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_projects (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      display_name TEXT NOT NULL,
      chat_session_id TEXT NOT NULL DEFAULT 'main',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, project_id),
      UNIQUE(user_id, workspace_root),
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_web_projects_user_updated
      ON web_projects(user_id, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS web_user_settings (
      user_id TEXT NOT NULL PRIMARY KEY,
      active_project_id TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
    );
  `);

  const columns = db.prepare(`PRAGMA table_info('web_projects')`).all() as Array<{ name?: unknown }>;
  const hasSortOrder = columns.some((col) => String(col.name ?? "").trim() === "sort_order");
  if (!hasSortOrder) {
    try {
      db.exec(`ALTER TABLE web_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // ignore
    }
  }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_web_projects_user_sort
        ON web_projects(user_id, sort_order ASC, updated_at DESC, created_at DESC, project_id ASC);
    `);
  } catch {
    // ignore
  }

  // Backfill sort_order for users that still have the default value on every project.
  // This preserves the pre-migration ordering (updated_at DESC) without overriding later user reorders.
  try {
    const candidates = db
      .prepare(
        `
          SELECT
            user_id AS userId,
            COUNT(1) AS projectCount,
            SUM(CASE WHEN sort_order != 0 THEN 1 ELSE 0 END) AS nonZeroCount
          FROM web_projects
          GROUP BY user_id
        `,
      )
      .all() as Array<{ userId?: unknown; projectCount?: unknown; nonZeroCount?: unknown }>;

    const userIds = candidates
      .map((row) => {
        const userId = String(row.userId ?? "").trim();
        const projectCount = Number(row.projectCount ?? 0);
        const nonZeroCount = Number(row.nonZeroCount ?? 0);
        return { userId, projectCount, nonZeroCount };
      })
      .filter((row) => row.userId && Number.isFinite(row.projectCount) && row.projectCount > 0 && row.nonZeroCount === 0)
      .map((row) => row.userId);

    if (userIds.length > 0) {
      const listForUser = db.prepare(
        `
          SELECT project_id AS projectId
          FROM web_projects
          WHERE user_id = ?
          ORDER BY updated_at DESC, created_at DESC, project_id ASC
        `,
      );
      const update = db.prepare(`UPDATE web_projects SET sort_order = ? WHERE user_id = ? AND project_id = ?`);

      const tx = db.transaction(() => {
        for (const userId of userIds) {
          const rows = listForUser.all(userId) as Array<{ projectId?: unknown }>;
          let idx = 0;
          for (const row of rows) {
            const projectId = String(row.projectId ?? "").trim();
            if (!projectId) continue;
            update.run(idx, userId, projectId);
            idx += 1;
          }
        }
      });

      tx();
    }
  } catch {
    // ignore
  }
}
