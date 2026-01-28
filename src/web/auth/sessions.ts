import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase, resolveStateDbPath } from "../../state/database.js";
import { ensureWebAuthTables } from "./schema.js";

export const ADS_SESSION_COOKIE_NAME = "ads_session";

export type WebUser = {
  id: string;
  username: string;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
};

export type WebUserCredential = WebUser & { password_hash: string };

export type WebSession = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_seen_ip: string | null;
  user_agent: string | null;
};

function getDb(explicitPath?: string): DatabaseType {
  const dbPath = resolveStateDbPath(explicitPath);
  const db = getStateDatabase(dbPath);
  ensureWebAuthTables(db);
  return db;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.floor(n);
}

export function resolveSessionTtlSeconds(): number {
  return Math.max(60, parseIntEnv("ADS_WEB_SESSION_TTL_SECONDS", 604800));
}

export function resolveSessionPepper(): string {
  return String(process.env.ADS_WEB_SESSION_PEPPER ?? "").trim();
}

export function resolveSessionSlidingEnabled(): boolean {
  const raw = String(process.env.ADS_WEB_SESSION_SLIDING ?? "").trim().toLowerCase();
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, pepper?: string): string {
  const material = pepper ? `${token}:${pepper}` : token;
  return crypto.createHash("sha256").update(material).digest("hex");
}

export function findUserByUsername(db: DatabaseType, username: string): WebUser | null {
  const row = db
    .prepare(
      `SELECT id, username, created_at, updated_at, last_login_at, disabled_at
       FROM web_users
       WHERE username = ?`,
    )
    .get(username) as WebUser | undefined;
  return row ?? null;
}

export function findUserCredentialByUsername(db: DatabaseType, username: string): WebUserCredential | null {
  const row = db
    .prepare(
      `SELECT id, username, password_hash, created_at, updated_at, last_login_at, disabled_at
       FROM web_users
       WHERE username = ?`,
    )
    .get(username) as WebUserCredential | undefined;
  return row ?? null;
}

export function findUserById(db: DatabaseType, userId: string): WebUser | null {
  const row = db
    .prepare(
      `SELECT id, username, created_at, updated_at, last_login_at, disabled_at
       FROM web_users
       WHERE id = ?`,
    )
    .get(userId) as WebUser | undefined;
  return row ?? null;
}

export function countUsers(dbPath?: string): number {
  const db = getDb(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS c FROM web_users").get() as { c: number };
  return row?.c ?? 0;
}

export function createWebSession(options: {
  dbPath?: string;
  userId: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  pepper?: string;
  lastSeenIp?: string | null;
  userAgent?: string | null;
}): { token: string; expiresAt: number; session: WebSession } {
  const db = getDb(options.dbPath);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, options.ttlSeconds ?? resolveSessionTtlSeconds());
  const pepper = options.pepper ?? resolveSessionPepper();

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token, pepper);
  const sessionId = crypto.randomUUID();
  const expiresAt = nowSeconds + ttlSeconds;

  db.prepare(
    `INSERT INTO web_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, last_seen_ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    options.userId,
    tokenHash,
    nowSeconds,
    expiresAt,
    nowSeconds,
    options.lastSeenIp ?? null,
    options.userAgent ?? null,
  );

  const session: WebSession = {
    id: sessionId,
    user_id: options.userId,
    token_hash: tokenHash,
    created_at: nowSeconds,
    expires_at: expiresAt,
    revoked_at: null,
    last_seen_at: nowSeconds,
    last_seen_ip: options.lastSeenIp ?? null,
    user_agent: options.userAgent ?? null,
  };
  return { token, expiresAt, session };
}

export type SessionLookup =
  | { ok: true; dbPath: string; user: WebUser; session: WebSession; shouldRefresh: boolean }
  | { ok: false; dbPath: string; reason: "missing" | "revoked" | "expired" | "unknown" };

export function lookupSessionByToken(options: {
  dbPath?: string;
  token: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  pepper?: string;
}): SessionLookup {
  const dbPath = resolveStateDbPath(options.dbPath);
  const db = getStateDatabase(dbPath);
  ensureWebAuthTables(db);

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, options.ttlSeconds ?? resolveSessionTtlSeconds());
  const pepper = options.pepper ?? resolveSessionPepper();

  const tokenHash = hashSessionToken(options.token, pepper);
  const row = db
    .prepare(
      `SELECT id, user_id, token_hash, created_at, expires_at, revoked_at, last_seen_at, last_seen_ip, user_agent
       FROM web_sessions
       WHERE token_hash = ?`,
    )
    .get(tokenHash) as WebSession | undefined;

  if (!row) {
    return { ok: false, dbPath, reason: "missing" };
  }
  if (row.revoked_at) {
    return { ok: false, dbPath, reason: "revoked" };
  }
  if (row.expires_at <= nowSeconds) {
    return { ok: false, dbPath, reason: "expired" };
  }
  const user = findUserById(db, row.user_id);
  if (!user) {
    return { ok: false, dbPath, reason: "unknown" };
  }
  const shouldRefresh = resolveSessionSlidingEnabled() && row.expires_at - nowSeconds < Math.floor(ttlSeconds / 2);
  return { ok: true, dbPath, user, session: row, shouldRefresh };
}

export function refreshSessionIfNeeded(options: {
  dbPath?: string;
  tokenHash: string;
  nowSeconds: number;
  ttlSeconds: number;
  lastSeenIp?: string | null;
  userAgent?: string | null;
  refresh: boolean;
}): { updatedExpiresAt: number } {
  const db = getDb(options.dbPath);
  const expiresAt = options.refresh ? options.nowSeconds + Math.max(60, options.ttlSeconds) : 0;

  if (options.refresh) {
    db.prepare(
      `UPDATE web_sessions
       SET last_seen_at = ?, last_seen_ip = ?, user_agent = ?, expires_at = ?
       WHERE token_hash = ?`,
    ).run(options.nowSeconds, options.lastSeenIp ?? null, options.userAgent ?? null, expiresAt, options.tokenHash);
    return { updatedExpiresAt: expiresAt };
  }

  db.prepare(
    `UPDATE web_sessions
     SET last_seen_at = ?, last_seen_ip = ?, user_agent = ?
     WHERE token_hash = ?`,
  ).run(options.nowSeconds, options.lastSeenIp ?? null, options.userAgent ?? null, options.tokenHash);

  const row = db.prepare("SELECT expires_at AS e FROM web_sessions WHERE token_hash = ?").get(options.tokenHash) as
    | { e: number }
    | undefined;
  return { updatedExpiresAt: row?.e ?? options.nowSeconds };
}

export function revokeSessionByTokenHash(options: { dbPath?: string; tokenHash: string; nowSeconds?: number }): boolean {
  const db = getDb(options.dbPath);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const res = db
    .prepare(
      `UPDATE web_sessions
       SET revoked_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(nowSeconds, options.tokenHash);
  return (res.changes ?? 0) > 0;
}
