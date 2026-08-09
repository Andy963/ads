import type { Database as DatabaseType } from "better-sqlite3";

/** Rule severities, ordered from weakest to strongest enforcement. */
export const RULE_SEVERITIES = ["advisory", "required", "approval_required", "blocked"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

/** Known categories. Free-form strings are accepted so operators can add their own. */
export const RULE_CATEGORIES = ["instruction", "safety", "execution"] as const;

export type RuleAgent = "codex" | "claude" | "gemini";
export type RuleChannel = "web" | "telegram" | "cli";

/**
 * Structured matcher used by the enforcement gate.
 *
 * The architecture doc only specifies the prose columns; a gate that has to
 * decide on `tool` / `command` cannot work without a machine-readable matcher,
 * so `match_json` is stored alongside them. Rules without a matcher are
 * injection-only.
 */
export interface RuleMatch {
  agents?: string[];
  channels?: string[];
  tools?: string[];
  commandPatterns?: string[];
  pathPatterns?: string[];
}

export interface GlobalRule {
  id: string;
  title: string;
  body: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  match: RuleMatch | null;
}

export type GlobalRuleInput = {
  id?: string;
  title: string;
  body: string;
  category?: string;
  severity?: RuleSeverity;
  enabled?: boolean;
  priority?: number;
  updatedBy?: string | null;
  match?: RuleMatch | null;
};

export type GlobalRuleAuditAction = "create" | "update" | "enable" | "disable" | "delete";

export interface GlobalRuleAuditEntry {
  id: number;
  ruleId: string;
  action: GlobalRuleAuditAction;
  before: GlobalRule | null;
  after: GlobalRule | null;
  actor: string | null;
  ts: number;
}

/** Cheap fingerprint of the enabled rule set, used to invalidate caches across processes. */
export interface GlobalRuleRevision {
  count: number;
  updatedAt: number;
}

function normalizeSeverity(value: unknown): RuleSeverity {
  const raw = String(value ?? "").trim().toLowerCase();
  return (RULE_SEVERITIES as readonly string[]).includes(raw) ? (raw as RuleSeverity) : "advisory";
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  return list.length > 0 ? list : undefined;
}

export function normalizeRuleMatch(value: unknown): RuleMatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const match: RuleMatch = {
    agents: normalizeStringList(raw.agents),
    channels: normalizeStringList(raw.channels),
    tools: normalizeStringList(raw.tools),
    commandPatterns: normalizeStringList(raw.commandPatterns),
    pathPatterns: normalizeStringList(raw.pathPatterns),
  };
  const hasAny = Object.values(match).some((entry) => entry !== undefined);
  return hasAny ? match : null;
}

function parseMatch(value: unknown): RuleMatch | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return normalizeRuleMatch(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toGlobalRule(row: Record<string, unknown>): GlobalRule {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    category: String(row.category ?? "instruction"),
    severity: normalizeSeverity(row.severity),
    enabled: Boolean(row.enabled),
    priority: Number(row.priority ?? 100),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
    match: parseMatch(row.match_json),
  };
}

function parseRuleJson(value: unknown): GlobalRule | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GlobalRule;
  } catch {
    return null;
  }
}

export function createGlobalRuleStore(db: DatabaseType) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_rules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      match_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_global_rules_enabled
      ON global_rules(enabled, priority, created_at);

    CREATE TABLE IF NOT EXISTS global_rule_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      actor TEXT,
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_global_rule_audit_rule
      ON global_rule_audit_log(rule_id, ts DESC);

    CREATE INDEX IF NOT EXISTS idx_global_rule_audit_ts
      ON global_rule_audit_log(ts DESC);
  `);
  const columns = db.prepare("PRAGMA table_info(global_rules)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "match_json")) {
    db.exec("ALTER TABLE global_rules ADD COLUMN match_json TEXT");
  }

  const ORDER_BY = "ORDER BY priority ASC, created_at ASC, id ASC";
  const listStmt = db.prepare(`SELECT * FROM global_rules ${ORDER_BY}`);
  const listEnabledStmt = db.prepare(`SELECT * FROM global_rules WHERE enabled = 1 ${ORDER_BY}`);
  const getStmt = db.prepare("SELECT * FROM global_rules WHERE id = ? LIMIT 1");
  const countStmt = db.prepare("SELECT COUNT(*) AS total FROM global_rules");
  const revisionStmt = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), 0) AS latest FROM global_rules",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO global_rules
      (id, title, body, category, severity, enabled, priority, created_at, updated_at, updated_by, match_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      category = excluded.category,
      severity = excluded.severity,
      enabled = excluded.enabled,
      priority = excluded.priority,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by,
      match_json = excluded.match_json
  `);
  const deleteStmt = db.prepare("DELETE FROM global_rules WHERE id = ?");
  const auditInsertStmt = db.prepare(`
    INSERT INTO global_rule_audit_log (rule_id, action, before_json, after_json, actor, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const auditListStmt = db.prepare(
    "SELECT * FROM global_rule_audit_log ORDER BY ts DESC, id DESC LIMIT ?",
  );
  const auditListForRuleStmt = db.prepare(
    "SELECT * FROM global_rule_audit_log WHERE rule_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
  );

  const listRules = (): GlobalRule[] =>
    (listStmt.all() as Record<string, unknown>[]).map(toGlobalRule);

  const listEnabledRules = (): GlobalRule[] =>
    (listEnabledStmt.all() as Record<string, unknown>[]).map(toGlobalRule);

  const getRule = (ruleId: string): GlobalRule | null => {
    const id = String(ruleId ?? "").trim();
    if (!id) return null;
    const row = getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? toGlobalRule(row) : null;
  };

  const countRules = (): number => Number((countStmt.get() as { total?: number })?.total ?? 0);

  const getRevision = (): GlobalRuleRevision => {
    const row = revisionStmt.get() as { total?: number; latest?: number } | undefined;
    return { count: Number(row?.total ?? 0), updatedAt: Number(row?.latest ?? 0) };
  };

  const appendAudit = (
    entry: {
      ruleId: string;
      action: GlobalRuleAuditAction;
      before: GlobalRule | null;
      after: GlobalRule | null;
      actor?: string | null;
    },
    now = Date.now(),
  ): void => {
    auditInsertStmt.run(
      entry.ruleId,
      entry.action,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      entry.actor ?? null,
      now,
    );
  };

  const saveRule = (input: GlobalRuleInput, now = Date.now()): GlobalRule => {
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("rule title is required");
    const body = String(input.body ?? "").trim();
    if (!body) throw new Error("rule body is required");
    const id = String(input.id ?? "").trim();
    if (!id) throw new Error("rule id is required");

    const existing = getRule(id);
    const match = input.match === undefined ? existing?.match ?? null : normalizeRuleMatch(input.match);
    const next: GlobalRule = {
      id,
      title,
      body,
      category: String(input.category ?? existing?.category ?? "instruction").trim() || "instruction",
      severity: normalizeSeverity(input.severity ?? existing?.severity ?? "advisory"),
      enabled: input.enabled ?? existing?.enabled ?? true,
      priority: Number.isFinite(Number(input.priority))
        ? Math.trunc(Number(input.priority))
        : existing?.priority ?? 100,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: input.updatedBy === undefined ? existing?.updatedBy ?? null : input.updatedBy,
      match,
    };

    const action: GlobalRuleAuditAction = !existing
      ? "create"
      : existing.enabled !== next.enabled
        ? next.enabled
          ? "enable"
          : "disable"
        : "update";

    const tx = db.transaction(() => {
      upsertStmt.run(
        next.id,
        next.title,
        next.body,
        next.category,
        next.severity,
        next.enabled ? 1 : 0,
        next.priority,
        next.createdAt,
        next.updatedAt,
        next.updatedBy,
        next.match ? JSON.stringify(next.match) : null,
      );
      appendAudit({ ruleId: next.id, action, before: existing, after: next, actor: next.updatedBy }, now);
    });
    tx();

    const saved = getRule(next.id);
    if (!saved) throw new Error("failed to load saved global rule");
    return saved;
  };

  const deleteRule = (ruleId: string, actor?: string | null, now = Date.now()): boolean => {
    const id = String(ruleId ?? "").trim();
    if (!id) return false;
    const existing = getRule(id);
    if (!existing) return false;
    const tx = db.transaction(() => {
      deleteStmt.run(id);
      appendAudit({ ruleId: id, action: "delete", before: existing, after: null, actor: actor ?? null }, now);
    });
    tx();
    return true;
  };

  const listAudit = (options: { ruleId?: string; limit?: number } = {}): GlobalRuleAuditEntry[] => {
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(options.limit ?? 50)) || 50));
    const ruleId = String(options.ruleId ?? "").trim();
    const rows = (ruleId ? auditListForRuleStmt.all(ruleId, limit) : auditListStmt.all(limit)) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      id: Number(row.id ?? 0),
      ruleId: String(row.rule_id ?? ""),
      action: String(row.action ?? "update") as GlobalRuleAuditAction,
      before: parseRuleJson(row.before_json),
      after: parseRuleJson(row.after_json),
      actor: row.actor == null ? null : String(row.actor),
      ts: Number(row.ts ?? 0),
    }));
  };

  return {
    listRules,
    listEnabledRules,
    getRule,
    countRules,
    getRevision,
    saveRule,
    deleteRule,
    listAudit,
  };
}

export type GlobalRuleStore = ReturnType<typeof createGlobalRuleStore>;
