import fs from "node:fs";
import path from "node:path";

import type { Statement as StatementType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { createLogger } from "./logger.js";
import type { HistoryEntry } from "./historyStore.js";

type SqliteStatement = StatementType<unknown[], unknown>;

const logger = createLogger("WorkspaceHistory");

export interface WorkspaceHistoryQuery {
  workspaceRoot: string;
  includeNamespaces: string[];
  sessionIdByNamespace?: Record<string, string[] | undefined>;
  limit?: number;
}

export interface WorkspaceHistoryRow {
  id: number;
  namespace: string;
  session_id: string;
  role: string;
  text: string;
  ts: number;
  kind?: string;
}

export interface WorkspaceHistoryRowsQuery {
  workspaceRoot: string;
  roles?: string[];
  namespaces?: string[];
  limit?: number;
}

function resolveWorkspaceStateDbPath(workspaceRoot: string): string | null {
  const resolvedRoot = path.resolve(String(workspaceRoot ?? "").trim());
  if (!resolvedRoot) {
    return null;
  }
  const marker = path.join(resolvedRoot, ".ads", "workspace.json");
  if (!fs.existsSync(marker)) {
    return null;
  }
  const adsDir = path.join(resolvedRoot, ".ads");
  if (!fs.existsSync(adsDir)) {
    return null;
  }
  return path.join(adsDir, "state.db");
}

function normalizeStrings(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .map((value) => String(value ?? "").trim())
    .filter((value) => Boolean(value));
  return Array.from(new Set(normalized));
}

function placeholders(count: number): string {
  return count > 0 ? Array.from({ length: count }).map(() => "?").join(", ") : "";
}

export function loadWorkspaceHistoryEntries(query: WorkspaceHistoryQuery): HistoryEntry[] {
  const workspaceRoot = path.resolve(String(query.workspaceRoot ?? "").trim());
  const includeNamespaces = normalizeStrings(query.includeNamespaces);
  const limit = Math.max(1, Number.isFinite(query.limit) ? Math.floor(query.limit!) : 400);
  if (!workspaceRoot || includeNamespaces.length === 0) {
    return [];
  }

  const dbPath = resolveWorkspaceStateDbPath(workspaceRoot);
  if (!dbPath) {
    return [];
  }

  let db;
  try {
    db = getStateDatabase(dbPath);
  } catch (error) {
    logger.warn(`[WorkspaceHistory] Failed to open state db at ${dbPath}`, error);
    return [];
  }

  const sessionIdByNamespace = query.sessionIdByNamespace ?? {};
  const restrictedNamespaces = new Set(
    Object.keys(sessionIdByNamespace).filter((ns) => normalizeStrings(sessionIdByNamespace[ns]).length > 0),
  );

  const unrestrictedNamespaces = includeNamespaces.filter((ns) => !restrictedNamespaces.has(ns));

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (unrestrictedNamespaces.length > 0) {
    clauses.push(`namespace IN (${placeholders(unrestrictedNamespaces.length)})`);
    params.push(...unrestrictedNamespaces);
  }

  for (const [namespace, sessionIds] of Object.entries(sessionIdByNamespace)) {
    const normalizedSessionIds = normalizeStrings(sessionIds);
    if (!normalizedSessionIds.length) {
      continue;
    }
    clauses.push(`(namespace = ? AND session_id IN (${placeholders(normalizedSessionIds.length)}))`);
    params.push(String(namespace ?? "").trim(), ...normalizedSessionIds);
  }

  if (clauses.length === 0) {
    return [];
  }

  let stmt: SqliteStatement;
  try {
    stmt = db.prepare(
      `SELECT role, text, ts, kind
       FROM history_entries
       WHERE ${clauses.join(" OR ")}
       ORDER BY id DESC
       LIMIT ?`,
    );
  } catch (error) {
    logger.warn("[WorkspaceHistory] Failed to prepare history query", error);
    return [];
  }

  try {
    const rows = stmt.all(...params, limit) as Array<{
      role: string;
      text: string;
      ts: number;
      kind: string | null;
    }>;
    return rows
      .slice()
      .reverse()
      .map((row) => ({
        role: row.role,
        text: row.text,
        ts: row.ts,
        kind: row.kind ?? undefined,
      }));
  } catch (error) {
    logger.warn("[WorkspaceHistory] Failed to query workspace history entries", error);
    return [];
  }
}

export function loadWorkspaceHistoryRows(query: WorkspaceHistoryRowsQuery): WorkspaceHistoryRow[] {
  const workspaceRoot = path.resolve(String(query.workspaceRoot ?? "").trim());
  const roles = normalizeStrings(query.roles);
  const namespaces = normalizeStrings(query.namespaces);
  const limit = Math.max(1, Number.isFinite(query.limit) ? Math.floor(query.limit!) : 400);
  if (!workspaceRoot) {
    return [];
  }

  const dbPath = resolveWorkspaceStateDbPath(workspaceRoot);
  if (!dbPath) {
    return [];
  }

  let db;
  try {
    db = getStateDatabase(dbPath);
  } catch (error) {
    logger.warn(`[WorkspaceHistory] Failed to open state db at ${dbPath}`, error);
    return [];
  }

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (roles.length > 0) {
    clauses.push(`role IN (${placeholders(roles.length)})`);
    params.push(...roles);
  }

  if (namespaces.length > 0) {
    clauses.push(`namespace IN (${placeholders(namespaces.length)})`);
    params.push(...namespaces);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  let stmt: SqliteStatement;
  try {
    stmt = db.prepare(
      `SELECT id, namespace, session_id, role, text, ts, kind
       FROM history_entries
       ${where}
       ORDER BY id DESC
       LIMIT ?`,
    );
  } catch (error) {
    logger.warn("[WorkspaceHistory] Failed to prepare history rows query", error);
    return [];
  }

  try {
    const rows = stmt.all(...params, limit) as Array<{
      id: number;
      namespace: string;
      session_id: string;
      role: string;
      text: string;
      ts: number;
      kind: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      namespace: row.namespace,
      session_id: row.session_id,
      role: row.role,
      text: row.text,
      ts: row.ts,
      kind: row.kind ?? undefined,
    }));
  } catch (error) {
    logger.warn("[WorkspaceHistory] Failed to query workspace history rows", error);
    return [];
  }
}
