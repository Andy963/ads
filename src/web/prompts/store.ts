import type { Database as DatabaseType } from "better-sqlite3";

export type WebPromptRecord = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

export function listWebPrompts(db: DatabaseType, userId: string): WebPromptRecord[] {
  const uid = String(userId ?? "").trim();
  if (!uid) return [];
  const rows = db
    .prepare(
      `
        SELECT
          prompt_id AS id,
          name AS name,
          content AS content,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM web_prompts
        WHERE user_id = ?
        ORDER BY updated_at DESC, created_at DESC, prompt_id ASC
      `,
    )
    .all(uid) as Array<Partial<WebPromptRecord>>;

  return rows
    .map((r) => ({
      id: String(r.id ?? "").trim(),
      name: String(r.name ?? "").trim(),
      content: String(r.content ?? ""),
      createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    }))
    .filter((p) => Boolean(p.id) && Boolean(p.name));
}

export function createWebPrompt(
  db: DatabaseType,
  args: { userId: string; promptId: string; name: string; content: string },
  now = Date.now(),
): WebPromptRecord {
  const userId = String(args.userId ?? "").trim();
  const promptId = String(args.promptId ?? "").trim();
  const name = String(args.name ?? "").trim();
  const content = String(args.content ?? "");

  if (!userId) throw new Error("userId is required");
  if (!promptId) throw new Error("promptId is required");
  if (!name) throw new Error("name is required");

  db.prepare(
    `
      INSERT INTO web_prompts (user_id, prompt_id, name, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(userId, promptId, name, content, now, now);

  return { id: promptId, name, content, createdAt: now, updatedAt: now };
}

export function updateWebPrompt(
  db: DatabaseType,
  args: { userId: string; promptId: string; name?: string; content?: string },
  now = Date.now(),
): WebPromptRecord | null {
  const userId = String(args.userId ?? "").trim();
  const promptId = String(args.promptId ?? "").trim();
  if (!userId || !promptId) return null;

  const current = db
    .prepare(
      `
        SELECT
          prompt_id AS id,
          name AS name,
          content AS content,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM web_prompts
        WHERE user_id = ? AND prompt_id = ?
        LIMIT 1
      `,
    )
    .get(userId, promptId) as Partial<WebPromptRecord> | undefined;

  if (!current) return null;

  const nextName = args.name == null ? String(current.name ?? "").trim() : String(args.name).trim();
  const nextContent = args.content == null ? String(current.content ?? "") : String(args.content ?? "");
  const createdAt =
    typeof current.createdAt === "number" && Number.isFinite(current.createdAt) ? current.createdAt : now;
  const name = nextName || "Prompt";

  db.prepare(
    `
      UPDATE web_prompts
      SET name = ?, content = ?, updated_at = ?
      WHERE user_id = ? AND prompt_id = ?
    `,
  ).run(name, nextContent, now, userId, promptId);

  return { id: promptId, name, content: nextContent, createdAt, updatedAt: now };
}

export function deleteWebPrompt(db: DatabaseType, userId: string, promptId: string): boolean {
  const uid = String(userId ?? "").trim();
  const pid = String(promptId ?? "").trim();
  if (!uid || !pid) return false;
  const result = db.prepare(`DELETE FROM web_prompts WHERE user_id = ? AND prompt_id = ?`).run(uid, pid) as { changes?: number };
  return Boolean(result && result.changes === 1);
}

