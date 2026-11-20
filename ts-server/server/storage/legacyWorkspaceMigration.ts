import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { resolveAdsWorkspacesDir } from "../workspace/adsPaths.js";

const TABLES = [
  "tasks", "task_plans", "task_messages", "task_contexts", "task_runs",
  "schedules", "schedule_runs", "attachments", "conversations",
  "conversation_messages", "review_snapshots", "review_queue_items", "review_artifacts",
  "review_settings", "review_action_audits",
] as const;
const OPTIONAL_TABLES = new Set(["review_settings", "review_action_audits"]);
const MAX_SUPPORTED_SOURCE_SCHEMA_VERSION = 29;

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Invalid identifier: " + value);
  return String.fromCharCode(34) + value + String.fromCharCode(34);
}

function columns(db: DatabaseType, schema: "main" | "legacy_db", table: string): string[] {
  return (db.prepare("PRAGMA " + schema + ".table_info(" + quoteIdentifier(table) + ")").all() as Array<{ name?: unknown }>)
    .map((row) => String(row.name ?? ""))
    .filter(Boolean);
}

function legacySources(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "ads.db"))
    .filter((file) => fs.existsSync(file));
}

function validateLegacySchema(db: DatabaseType, source: string): void {
  const versionRow = db.prepare(
    "SELECT version FROM legacy_db.schema_version WHERE id = 1",
  ).get() as { version?: unknown } | undefined;
  const version = Number(versionRow?.version);
  if (!Number.isInteger(version) || version < 1 || version > MAX_SUPPORTED_SOURCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported legacy schema version at ${source}: ${String(versionRow?.version ?? "missing")}`);
  }

  for (const table of TABLES) {
    const sourceColumns = columns(db, "legacy_db", table);
    if (sourceColumns.length === 0) {
      if (OPTIONAL_TABLES.has(table)) continue;
      throw new Error(`Legacy workspace database is missing required table ${table}: ${source}`);
    }
    const targetColumns = new Set(columns(db, "main", table));
    const unsupported = sourceColumns.filter((column) => column !== "workspace_id" && !targetColumns.has(column));
    if (unsupported.length > 0) {
      throw new Error(`Legacy table ${table} has unsupported columns at ${source}: ${unsupported.join(", ")}`);
    }
  }
}

export function migrateLegacyWorkspacesToCentralDb(
  targetDb: DatabaseType,
  options?: { workspacesDir?: string },
): Array<{ workspaceId: string; source: string; rows: Record<string, number> }> {
  const summaries: Array<{ workspaceId: string; source: string; rows: Record<string, number> }> = [];
  for (const source of legacySources(options?.workspacesDir ?? resolveAdsWorkspacesDir())) {
    const workspaceId = path.basename(path.dirname(source));
    if (targetDb.prepare("SELECT 1 FROM legacy_workspace_migrations WHERE source_path = ? LIMIT 1").get(source)) continue;
    targetDb.exec("ATTACH DATABASE '" + source.replace(/'/g, "''") + "' AS legacy_db");
    try {
      validateLegacySchema(targetDb, source);
      const rows: Record<string, number> = {};
      const taskPlanIds = new Map<number, number>();
      const tx = targetDb.transaction(() => {
        if (targetDb.prepare("SELECT 1 FROM legacy_workspace_migrations WHERE source_path = ? LIMIT 1").get(source)) return;
        for (const table of TABLES) {
          const sourceColumns = columns(targetDb, "legacy_db", table);
          const targetColumns = columns(targetDb, "main", table);
          if (!sourceColumns.length || !targetColumns.includes("workspace_id")) continue;
          const autoId = ["task_plans", "task_messages", "task_contexts", "schedule_runs", "conversation_messages"].includes(table);
          const shared = sourceColumns.filter((column) => column !== "workspace_id" && targetColumns.includes(column) && !(autoId && column === "id"));
          if (!shared.length) continue;
          const targetList = ["workspace_id", ...shared].map(quoteIdentifier).join(", ");
          const sourceList = shared.map(quoteIdentifier).join(", ");
          const sourceSelect = table === "task_plans" ? "id, " + sourceList : sourceList;
          const sourceRows = targetDb.prepare("SELECT " + sourceSelect + " FROM legacy_db." + quoteIdentifier(table)).all() as Array<Record<string, unknown>>;
          const insert = targetDb.prepare("INSERT INTO " + quoteIdentifier(table) + " (" + targetList + ") VALUES (" + ["?", ...shared.map(() => "?")].join(", ") + ")");
          const keyColumn = !autoId && shared.includes("id") ? "id" : null;
          const collision = keyColumn ? targetDb.prepare("SELECT 1 FROM " + quoteIdentifier(table) + " WHERE " + quoteIdentifier(keyColumn) + " = ? AND workspace_id <> ? LIMIT 1") : null;
          let inserted = 0;
          for (const row of sourceRows) {
            const values = shared.map((column) => row[column]);
            if (collision && keyColumn && row[keyColumn] != null && collision.get(row[keyColumn], workspaceId)) throw new Error("Cross-workspace primary key collision: " + table + "." + keyColumn + "=" + String(row[keyColumn]));
            if (table === "task_messages") {
              const planStepIndex = shared.indexOf("plan_step_id");
              if (planStepIndex >= 0 && values[planStepIndex] != null) {
                values[planStepIndex] = taskPlanIds.get(Number(values[planStepIndex])) ?? null;
              }
            }
            const result = insert.run(workspaceId, ...values);
            if (table === "task_plans") {
              const oldId = row.id;
              const newId = Number(result.lastInsertRowid);
              if (oldId != null && Number.isSafeInteger(newId)) taskPlanIds.set(Number(oldId), newId);
            }
            inserted += 1;
          }
          rows[table] = inserted;
        }
        const foreignKeyErrors = targetDb.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyErrors.length > 0) {
          throw new Error("Legacy workspace migration failed foreign key validation");
        }
        targetDb.prepare("INSERT INTO legacy_workspace_migrations (workspace_id, source_path, summary_json, completed_at) VALUES (?, ?, ?, ?)")
          .run(workspaceId, source, JSON.stringify(rows), Date.now());
      });
      tx.immediate();
      if (Object.keys(rows).length > 0) summaries.push({ workspaceId, source, rows });
    } finally {
      targetDb.exec("DETACH DATABASE legacy_db");
    }
  }
  return summaries;
}
