import crypto from "node:crypto";

import { getStateDatabase, resolveStateDbPath } from "../../state/database.js";
import { ensureWebAuthTables } from "./schema.js";
import { hashPasswordScrypt } from "./password.js";

export type InitAdminOutcome =
  | { status: "created"; dbPath: string; userId: string; username: string }
  | { status: "already_initialized"; dbPath: string };

type InitAdminInput = {
  username: string;
  password: string;
  dbPath?: string;
  nowSeconds?: number;
};

export function initAdmin(input: InitAdminInput): InitAdminOutcome {
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

  const existing = db.prepare("SELECT 1 FROM web_users LIMIT 1").get();
  if (existing) {
    return { status: "already_initialized", dbPath };
  }

  const userId = crypto.randomUUID();
  const passwordHash = hashPasswordScrypt(password);

  try {
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT 1 FROM web_users LIMIT 1").get();
      if (row) {
        return false;
      }
      db.prepare(
        `INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userId, username, passwordHash, nowSeconds, nowSeconds);
      return true;
    });

    const created = tx();
    if (!created) {
      return { status: "already_initialized", dbPath };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("constraint")) {
      return { status: "already_initialized", dbPath };
    }
    throw error;
  }

  return { status: "created", dbPath, userId, username };
}
