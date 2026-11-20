import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

type SqliteStatement = StatementType<unknown[], unknown>;

export interface MigrationMarkerStatements {
  getMigrationMarkerStmt: SqliteStatement;
  setMigrationMarkerStmt: SqliteStatement;
}

const migrationMarkerStatementsCache = new WeakMap<DatabaseType, MigrationMarkerStatements>();

export function prepareMigrationMarkerStatements(db: DatabaseType): MigrationMarkerStatements {
  const cached = migrationMarkerStatementsCache.get(db);
  if (cached) {
    return cached;
  }
  const getMigrationMarkerStmt: SqliteStatement = db.prepare(
    `SELECT value FROM kv_state WHERE namespace = 'migrations' AND key = ?`,
  );
  const setMigrationMarkerStmt: SqliteStatement = db.prepare(
    `INSERT INTO kv_state (namespace, key, value, updated_at)
     VALUES ('migrations', ?, ?, ?)
     ON CONFLICT(namespace, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const statements = { getMigrationMarkerStmt, setMigrationMarkerStmt };
  migrationMarkerStatementsCache.set(db, statements);
  return statements;
}
