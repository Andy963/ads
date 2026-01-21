import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { createLogger } from "../utils/logger.js";
import { truncateToWidth } from "../utils/terminalText.js";
import { chunkText } from "./chunking.js";
import { sha256Hex, workspaceNamespaceFor } from "./hash.js";
import { getVectorState, resolveWorkspaceStateDbPath } from "./state.js";
import type { VectorUpsertItem } from "./types.js";

const logger = createLogger("VectorSearchIndexer");

function snippetFrom(text: string): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateToWidth(normalized, 260);
}

function normalizeRelPath(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(workspaceRoot, absolutePath);
  return rel.split(path.sep).join("/");
}

function listFilesRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function loadHistoryRows(params: {
  db: DatabaseType;
  namespace: string;
  afterId: number;
  limit: number;
}): Array<{ id: number; session_id: string; role: string; text: string; ts: number; kind: string | null }> {
  const stmt = params.db.prepare(
    `SELECT id, session_id, role, text, ts, kind
     FROM history_entries
     WHERE namespace = ?
       AND id > ?
       AND role IN ('user','ai')
       AND (kind IS NULL OR kind NOT IN ('command','error'))
     ORDER BY id ASC
     LIMIT ?`,
  );
  return stmt.all(params.namespace, params.afterId, params.limit) as Array<{
    id: number;
    session_id: string;
    role: string;
    text: string;
    ts: number;
    kind: string | null;
  }>;
}

export interface IndexPrepareResult {
  workspaceNamespace: string;
  fileHashes: Map<string, string>;
  items: VectorUpsertItem[];
  warnings: string[];
  stateUpdates: Array<{ key: string; value: string }>;
}

export function prepareVectorUpserts(params: {
  workspaceRoot: string;
  namespaces: string[];
  historyScanLimit: number;
  chunkMaxChars: number;
  chunkOverlapChars: number;
}): IndexPrepareResult {
  const workspaceRoot = path.resolve(String(params.workspaceRoot ?? "").trim());
  const workspaceNamespace = workspaceNamespaceFor(workspaceRoot);
  const warnings: string[] = [];

  const items: VectorUpsertItem[] = [];
  const stateUpdates: Array<{ key: string; value: string }> = [];
  const fileHashes = new Map<string, string>();

  // Collect file hashes for filtering stale results, and optionally upsert changed files.
  const specDir = path.join(workspaceRoot, "docs", "spec");
  const adrDir = path.join(workspaceRoot, "docs", "adr");

  const specFiles = fs.existsSync(specDir) ? listFilesRecursive(specDir) : [];
  const adrFiles = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).map((f) => path.join(adrDir, f)) : [];

  const includeSpecNames = new Set(["requirements.md", "design.md", "implementation.md", "task.md"]);
  const filteredSpec = specFiles.filter((file) => includeSpecNames.has(path.basename(file)));
  const filteredAdr = adrFiles.filter((file) => {
    const base = path.basename(file).toLowerCase();
    return base.endsWith(".md") && base !== "readme.md";
  });

  const dbPath = resolveWorkspaceStateDbPath(workspaceRoot);
  if (!dbPath) {
    warnings.push("workspace is not initialized (missing .ads/workspace.json); skipping history incremental state");
  }

  const canUseState = Boolean(dbPath);

  for (const filePath of [...filteredSpec, ...filteredAdr]) {
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      logger.warn(`[VectorSearchIndexer] Failed to read file ${filePath}`, error);
      continue;
    }
    const relPath = normalizeRelPath(workspaceRoot, filePath);
    const contentHash = sha256Hex(content);
    fileHashes.set(relPath, contentHash);

    if (canUseState) {
      const key = `ws:${workspaceNamespace}:file:${relPath}`;
      const previousHash = getVectorState(workspaceRoot, key);
      if (previousHash && previousHash === contentHash) {
        continue;
      }
      stateUpdates.push({ key, value: contentHash });
    }

    const sourceType = filePath.startsWith(specDir) ? "spec" : "adr";
    const chunks = chunkText(content, { maxChars: params.chunkMaxChars, overlapChars: params.chunkOverlapChars });
    for (const chunk of chunks) {
      items.push({
        id: `file:${relPath}:${contentHash}:${chunk.index}`,
        text: chunk.text,
        metadata: {
          source_type: sourceType,
          path: relPath,
          content_hash: contentHash,
          chunk_index: chunk.index,
          snippet: snippetFrom(chunk.text),
        },
      });
    }
  }

  // Collect incremental history entries.
  if (dbPath) {
    const db = getStateDatabase(dbPath);
    const scanLimit = Math.max(1, params.historyScanLimit);
    for (const ns of params.namespaces) {
      const key = `ws:${workspaceNamespace}:history:${ns}:last_id`;
      const lastIdRaw = getVectorState(workspaceRoot, key);
      const lastId = lastIdRaw ? Number.parseInt(lastIdRaw, 10) : 0;
      const afterId = Number.isFinite(lastId) ? lastId : 0;

      const rows = loadHistoryRows({ db, namespace: ns, afterId, limit: scanLimit });
      if (rows.length === 0) {
        continue;
      }

      const maxId = rows[rows.length - 1]!.id;
      stateUpdates.push({ key, value: String(maxId) });

      for (const row of rows) {
        const chunks = chunkText(row.text, { maxChars: params.chunkMaxChars, overlapChars: params.chunkOverlapChars });
        for (const chunk of chunks) {
          items.push({
            id: `hist:${ns}:${row.id}:${chunk.index}`,
            text: chunk.text,
            metadata: {
              source_type: "chat",
              namespace: ns,
              session_id: row.session_id,
              row_id: row.id,
              role: row.role,
              ts: row.ts,
              kind: row.kind ?? undefined,
              snippet: snippetFrom(chunk.text),
            },
          });
        }
      }
    }
  }

  return { workspaceNamespace, fileHashes, items, warnings, stateUpdates };
}
