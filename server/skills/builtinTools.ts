import type { Database as DatabaseType } from "better-sqlite3";

import { getDatabase } from "../storage/database.js";
import { updateMemory } from "../memory/memory.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("BuiltinTools");

export interface ToolDirective {
  name: string;
  attrs: Record<string, string>;
  body: string;
  raw: string;
}

export function extractToolDirectives(text: string): ToolDirective[] {
  const directives: ToolDirective[] = [];
  const pattern = /<<<tool\.([a-z0-9_.-]+)([^>]*)>>>\s*([\s\S]*?)\s*>>>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    directives.push({
      name: String(match[1] ?? "").trim().toLowerCase(),
      attrs: parseAttrs(match[2] ?? ""),
      body: String(match[3] ?? "").trim(),
      raw: match[0],
    });
  }
  return directives;
}

export function stripToolDirectives(text: string): string {
  let out = text;
  for (const directive of extractToolDirectives(text)) {
    out = out.replace(directive.raw, "");
  }
  return out.trim();
}

export async function executeToolDirectives(args: {
  text: string;
  workspaceRoot: string;
  sessionId?: string;
  db?: DatabaseType;
}): Promise<string[]> {
  const results: string[] = [];
  for (const directive of extractToolDirectives(args.text)) {
    try {
      if (directive.name === "memory.update") {
        const op = normalizeMemoryOp(directive.attrs.op);
        updateMemory({ workspaceRoot: args.workspaceRoot, op, content: directive.body, key: directive.attrs.key });
        results.push(`tool.memory.update: ok (${op})`);
        continue;
      }
      if (directive.name === "session_search") {
        const query = directive.attrs.query || directive.body;
        const limit = parseLimit(directive.attrs.limit);
        const matches = searchSessionMessages({ workspaceRoot: args.workspaceRoot, query, limit, db: args.db });
        results.push(formatSessionSearchResult(matches));
        continue;
      }
      logger.warn(`Rejected unknown tool directive: ${directive.name}`);
      results.push(`tool.${directive.name}: rejected (unknown tool)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Tool directive failed: ${directive.name}: ${message}`);
      results.push(`tool.${directive.name}: failed: ${message}`);
    }
  }
  return results;
}

export function searchSessionMessages(args: { workspaceRoot: string; query: string; limit?: number; db?: DatabaseType }): Array<{
  sessionId: string;
  role: string;
  createdAt: number;
  snippet: string;
}> {
  const query = String(args.query ?? "").trim();
  if (!query) return [];
  const db = args.db ?? getDatabase(args.workspaceRoot);
  const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 5)));
  const rows = db.prepare(`
    SELECT conversation_messages.conversation_id AS session_id,
           conversation_messages.role AS role,
           conversation_messages.created_at AS created_at,
           snippet(conversation_messages_fts, 0, '[', ']', '…', 12) AS snippet
    FROM conversation_messages_fts
    JOIN conversation_messages ON conversation_messages.id = conversation_messages_fts.rowid
    WHERE conversation_messages_fts MATCH ?
    ORDER BY bm25(conversation_messages_fts)
    LIMIT ?
  `).all(query, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    sessionId: String(row.session_id ?? ""),
    role: String(row.role ?? ""),
    createdAt: Number(row.created_at ?? 0),
    snippet: String(row.snippet ?? ""),
  }));
}

function formatSessionSearchResult(matches: ReturnType<typeof searchSessionMessages>): string {
  if (matches.length === 0) return "tool.session_search: no matches";
  return [
    "tool.session_search:",
    ...matches.map((m) => `- ${m.sessionId} ${m.role} ${m.createdAt}: ${m.snippet}`),
  ].join("\n");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_][\w.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    attrs[String(match[1])] = String(match[2] ?? "");
  }
  return attrs;
}

function normalizeMemoryOp(raw: string | undefined): "add" | "remove" | "replace" {
  return raw === "remove" || raw === "replace" ? raw : "add";
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(String(raw ?? "5"), 10);
  return Number.isFinite(parsed) ? parsed : 5;
}
