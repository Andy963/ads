import fs from "node:fs";
import path from "node:path";

export interface LocalSearchHit {
  file: string;
  line: number;
  preview: string;
}

function normalizeRelPath(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(workspaceRoot, absolutePath);
  return rel.split(path.sep).join("/");
}

function listFilesRecursive(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".ads" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function safeReadTextFile(filePath: string, maxBytes: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size <= 0) return null;
  if (stat.size > maxBytes) return null;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function collectSearchFiles(workspaceRoot: string): string[] {
  const root = path.resolve(String(workspaceRoot ?? "").trim());
  if (!root) return [];

  const candidates: string[] = [];

  const rootReadme = path.join(root, "README.md");
  if (fs.existsSync(rootReadme)) {
    candidates.push(rootReadme);
  }

  const specDir = path.join(root, "docs", "spec");
  if (fs.existsSync(specDir)) {
    candidates.push(...listFilesRecursive(specDir));
  }

  const adrDir = path.join(root, "docs", "adr");
  if (fs.existsSync(adrDir)) {
    try {
      candidates.push(...fs.readdirSync(adrDir).map((name) => path.join(adrDir, name)));
    } catch {
      // ignore
    }
  }

  return candidates
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .filter((file) => {
      if (path.basename(file).toLowerCase() !== "readme.md") {
        return true;
      }
      return path.resolve(file) === path.resolve(rootReadme);
    });
}

export function searchWorkspaceFiles(params: {
  workspaceRoot: string;
  query: string;
  maxResults?: number;
  maxFileBytes?: number;
  maxPreviewChars?: number;
}): { hits: LocalSearchHit[]; scanned: number } {
  const query = String(params.query ?? "").trim();
  if (!query) return { hits: [], scanned: 0 };

  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 12));
  const maxFileBytes = Math.max(8 * 1024, Math.floor(params.maxFileBytes ?? 512 * 1024));
  const maxPreviewChars = Math.max(60, Math.floor(params.maxPreviewChars ?? 220));

  const workspaceRoot = path.resolve(String(params.workspaceRoot ?? "").trim());
  const queryLower = query.toLowerCase();

  const files = collectSearchFiles(workspaceRoot);
  const hits: LocalSearchHit[] = [];
  let scanned = 0;

  for (const absolutePath of files) {
    if (hits.length >= maxResults) break;
    scanned += 1;

    const content = safeReadTextFile(absolutePath, maxFileBytes);
    if (!content) continue;
    if (!content.toLowerCase().includes(queryLower)) continue;

    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (hits.length >= maxResults) break;
      const lineText = lines[idx] ?? "";
      if (!lineText.toLowerCase().includes(queryLower)) continue;
      hits.push({
        file: normalizeRelPath(workspaceRoot, absolutePath),
        line: idx + 1,
        preview: truncate(lineText, maxPreviewChars),
      });
    }
  }

  return { hits, scanned };
}

export function formatLocalSearchOutput(params: {
  query: string;
  hits: LocalSearchHit[];
  scanned: number;
  maxChars?: number;
}): string {
  const query = String(params.query ?? "").trim();
  const maxChars = Math.max(400, Math.floor(params.maxChars ?? 6000));
  const hits = params.hits ?? [];

  const header = `🔎 Search "${truncate(query, 64)}" (local)`;
  if (hits.length === 0) {
    const out = `${header}\n(0 results; scanned ${params.scanned} files)`;
    return out.length > maxChars ? out.slice(0, maxChars - 1) + "…" : out;
  }

  const lines: string[] = [header];
  for (let idx = 0; idx < hits.length; idx += 1) {
    const hit = hits[idx]!;
    lines.push(`${idx + 1}. ${hit.file}:${hit.line} ${hit.preview}`);
  }
  const out = lines.join("\n");
  return out.length > maxChars ? out.slice(0, maxChars - 1) + "…" : out;
}
