import crypto from "node:crypto";

import { getStateDatabase, resolveStateDbPath } from "../../state/database.js";
import { ensureWebAuthTables } from "./schema.js";
import { hashPasswordScrypt } from "./password.js";

export type ResetAdminOutcome =
  | { status: "created"; dbPath: string; userId: string; username: string }
  | { status: "updated"; dbPath: string; userId: string; username: string; previousUsername: string };

type ResetAdminInput = {
  username: string;
  password: string;
  dbPath?: string;
  nowSeconds?: number;
};

export function resetAdmin(input: ResetAdminInput): ResetAdminOutcome {
  const dbPath = resolveStateDbPath(input.dbPath);
  const db = getStateDatabase(dbPath);
  ensureWebAuthTables(db);

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const username = String(input.username ?? "").trim();
  if (!username) {
    throw new Error("username is required");
  }
  const password = String(input.password ?? "");
  if (!password) {
    throw new Error("password is required");
  }

  const passwordHash = hashPasswordScrypt(password);

  const tx = db.transaction(() => {
    const firstUser = db
      .prepare(
        `SELECT id, username
         FROM web_users
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as { id: string; username: string } | undefined;

    if (!firstUser) {
      const userId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userId, username, passwordHash, nowSeconds, nowSeconds);
      return { status: "created" as const, userId, previousUsername: "" };
    }

    const userId = firstUser.id;
    const previousUsername = String(firstUser.username ?? "");

    const collision = db
      .prepare(
        `SELECT 1
         FROM web_users
         WHERE username = ? AND id <> ?
         LIMIT 1`,
      )
      .get(username, userId);
    if (collision) {
      throw new Error(`username already exists: ${username}`);
    }

    db.prepare(
      `UPDATE web_users
       SET username = ?, password_hash = ?, updated_at = ?, disabled_at = NULL
       WHERE id = ?`,
    ).run(username, passwordHash, nowSeconds, userId);

    db.prepare(
      `UPDATE web_sessions
       SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
    ).run(nowSeconds, userId);

    return { status: "updated" as const, userId, previousUsername };
  });

  const outcome = tx();
  if (outcome.status === "created") {
    return { status: "created", dbPath, userId: outcome.userId, username };
  }
  return { status: "updated", dbPath, userId: outcome.userId, username, previousUsername: outcome.previousUsername };
}

