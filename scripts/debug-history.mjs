import Database from "better-sqlite3";

function usage() {
  console.log("Usage: node scripts/debug-history.mjs [dbPath] [sessionFilter] [limit]");
  console.log("  dbPath: default .ads/state.db");
  console.log("  sessionFilter: optional, matches session_id via LIKE (e.g. '::abc' or 'u-1::')");
  console.log("  limit: default 50");
}

const dbPath = process.argv[2] ?? ".ads/state.db";
const sessionFilter = process.argv[3] ?? "";
const limit = Number(process.argv[4] ?? 50);
if (!Number.isFinite(limit) || limit <= 0) {
  usage();
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const params = ["web", Math.max(1, Math.floor(limit))];
let where = "namespace = ? ";
if (sessionFilter && String(sessionFilter).trim()) {
  where += "AND session_id LIKE ? ";
  params.splice(1, 0, `%${String(sessionFilter).trim()}%`);
}

const rows = db
  .prepare(
    `SELECT id, session_id, role, kind, ts, substr(text, 1, 160) AS preview
     FROM history_entries
     WHERE ${where}
     ORDER BY id DESC
     LIMIT ?`,
  )
  .all(...params);

for (const r of rows) {
  const id = String(r.id ?? "");
  const sessionId = String(r.session_id ?? "");
  const role = String(r.role ?? "");
  const kind = String(r.kind ?? "");
  const ts = String(r.ts ?? "");
  const preview = String(r.preview ?? "").replace(/\s+/g, " ").trim();
  console.log(`${id}\t${ts}\t${role}\t${kind}\t${sessionId}\t${preview}`);
}

