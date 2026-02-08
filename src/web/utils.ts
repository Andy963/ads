import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";

import type { Input } from "../agents/protocol/types.js";
import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

import type { ImagePersistOutcome, IncomingImage, PromptInputOutcome, PromptPayload, WorkspaceState } from "./types.js";

import { createLogger } from "../utils/logger.js";
import { getStateDatabase } from "../state/database.js";
import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";

export { truncateForLog } from "../utils/text.js";

export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
]);

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const logger = createLogger("WebUtils");

type SqliteStatement = StatementType<unknown[], unknown>;

function isSqlitePath(storagePath: string): boolean {
  const lowered = storagePath.trim().toLowerCase();
  return lowered.endsWith(".db") || lowered.endsWith(".sqlite") || lowered.endsWith(".sqlite3");
}

function migrateLegacyCwdJson(db: DatabaseType, stateDbPath: string): void {
  const legacyPath = path.join(path.dirname(stateDbPath), "web-cwd.json");
  if (!fs.existsSync(legacyPath)) {
    return;
  }

  const marker = `cwd:web:${path.basename(legacyPath)}`;
  const getMarkerStmt: SqliteStatement = db.prepare(
    `SELECT value FROM kv_state WHERE namespace = 'migrations' AND key = ?`,
  );
  const setMarkerStmt: SqliteStatement = db.prepare(
    `INSERT INTO kv_state (namespace, key, value, updated_at)
     VALUES ('migrations', ?, ?, ?)
     ON CONFLICT(namespace, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  try {
    const existing = getMarkerStmt.get(marker) as { value?: string } | undefined;
    if (existing?.value) {
      return;
    }
  } catch (error) {
    logger.warn(`[WebUtils] Failed to read cwd migration marker ${marker}`, error);
  }

  const upsertStmt: SqliteStatement = db.prepare(
    `INSERT INTO kv_state (namespace, key, value, updated_at)
     VALUES ('web_cwd', ?, ?, ?)
     ON CONFLICT(namespace, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  try {
    const raw = fs.readFileSync(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(obj)) {
        const normalizedKey = String(key ?? "").trim();
        const cwd = typeof value === "string" ? value.trim() : "";
        if (!normalizedKey || !cwd) {
          continue;
        }
        upsertStmt.run(normalizedKey, cwd, Date.now());
      }
    });
    tx();
    setMarkerStmt.run(marker, "1", Date.now());
    logger.info(`[WebUtils] Migrated legacy cwd store from ${legacyPath} -> state.db`);
  } catch (error) {
    logger.warn(`[WebUtils] Failed to migrate legacy cwd store ${legacyPath}`, error);
  }
}

export function loadCwdStore(filePath: string): Map<string, string> {
  if (isSqlitePath(filePath)) {
    const db = getStateDatabase(filePath);
    migrateLegacyCwdJson(db, filePath);
    try {
      const rows = db.prepare(`SELECT key, value FROM kv_state WHERE namespace = 'web_cwd'`).all() as Array<{
        key: string;
        value: string;
      }>;
      return new Map(rows.map((row) => [row.key, row.value]));
    } catch (error) {
      logger.warn(`[WebUtils] Failed to load cwd store from state.db ${filePath}`, error);
      return new Map();
    }
  }

  try {
    if (!fs.existsSync(filePath)) return new Map();
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(data || {}));
  } catch (error) {
    logger.warn(`[WebUtils] Failed to load cwd store ${filePath}`, error);
    return new Map();
  }
}

export function persistCwdStore(filePath: string, store: Map<string, string>): void {
  if (isSqlitePath(filePath)) {
    const db = getStateDatabase(filePath);
    const upsertStmt: SqliteStatement = db.prepare(
      `INSERT INTO kv_state (namespace, key, value, updated_at)
       VALUES ('web_cwd', ?, ?, ?)
       ON CONFLICT(namespace, key)
       DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    try {
      const tx = db.transaction(() => {
        for (const [key, cwd] of store.entries()) {
          const normalizedKey = String(key ?? "").trim();
          const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";
          if (!normalizedKey || !normalizedCwd) {
            continue;
          }
          upsertStmt.run(normalizedKey, normalizedCwd, Date.now());
        }
      });
      tx();
    } catch (error) {
      logger.warn(`[WebUtils] Failed to persist cwd store to state.db ${filePath}`, error);
    }
    return;
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [key, value] of store.entries()) {
      obj[key] = value;
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (error) {
    logger.warn(`[WebUtils] Failed to persist cwd store ${filePath}`, error);
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    return process.kill(pid, 0), true;
  } catch {
    return false;
  }
}

export function readCmdline(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

export function isLikelyWebProcess(pid: number): boolean {
  const cmdline = readCmdline(pid);
  if (!cmdline) return false;
  return (
    cmdline.includes("dist/src/web/server.js") ||
    cmdline.includes("src/web/server.ts") ||
    cmdline.includes("ads web") ||
    cmdline.includes("web/server")
  );
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deriveWebUserId(token: string, sessionId: string): number {
  const base = `${token || "default"}::${sessionId || "default"}`;
  const hash = crypto.createHash("sha256").update(base).digest();
  const value = hash.readUInt32BE(0);
  return 0x70000000 + value;
}

export function resolveAllowedDirs(workspaceRoot: string): string[] {
  const raw = process.env.ALLOWED_DIRS;
  const list = (raw ? raw.split(",") : [workspaceRoot]).map((dir) => dir.trim()).filter(Boolean);
  const resolved = list.map((dir) => path.resolve(dir));
  return resolved.length > 0 ? resolved : [workspaceRoot];
}

export function sanitizeInput(input: unknown): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "command" in (input as Record<string, unknown>)) {
    const command = (input as Record<string, unknown>).command;
    return typeof command === "string" ? command : null;
  }
  return null;
}

export function getWorkspaceState(workspaceRoot: string): WorkspaceState {
  migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
  const rulesPath = resolveWorkspaceStatePath(workspaceRoot, "rules.md");
  let modified: string[] = [];
  let branch = "";

  try {
    const gitStatus = childProcess.execSync("git status --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    modified = gitStatus
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z?]{1,2}\s+/, "").trim())
      .filter(Boolean);
  } catch {
    modified = [];
  }

  try {
    branch = childProcess
      .execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
  } catch {
    branch = "";
  }

  return { path: workspaceRoot, rules: rulesPath, modified, branch };
}

export function resolveImageExt(name: string | undefined, mime: string | undefined): string {
  const safeName = name ? path.basename(name) : "";
  const extFromName = safeName.includes(".") ? path.extname(safeName).toLowerCase() : "";
  if (extFromName) return extFromName;
  if (!mime) return ".jpg";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  if (mime === "image/svg+xml") return ".svg";
  return ".jpg";
}

export function decodeBase64Data(data: string): Buffer {
  const base64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
  return Buffer.from(base64, "base64");
}

export function persistIncomingImage(image: IncomingImage, imageDir: string): ImagePersistOutcome {
  if (!image.data) {
    return { ok: false, message: "图片缺少数据" };
  }
  const mime = typeof image.mime === "string" ? image.mime : "";
  if (mime && !ALLOWED_IMAGE_MIME.has(mime)) {
    return { ok: false, message: `不支持的图片类型: ${mime}` };
  }
  const buffer = decodeBase64Data(image.data);
  const size = buffer.byteLength;
  if (size <= 0) {
    return { ok: false, message: "图片内容为空" };
  }
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, message: `图片超过 25MB 限制 (${Math.round(size / 1024)}KB)` };
  }
  const ext = resolveImageExt(image.name, mime);
  const filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
  fs.mkdirSync(imageDir, { recursive: true });
  const filePath = path.join(imageDir, filename);
  fs.writeFileSync(filePath, buffer);
  return { ok: true, path: filePath };
}

export function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

export function buildPromptInput(payload: unknown, imageDir: string): PromptInputOutcome {
  const tempPaths: string[] = [];
  if (typeof payload === "string") {
    const text = sanitizeInput(payload);
    if (!text) {
      return { ok: false, message: "Payload must be a text prompt" };
    }
    return { ok: true, input: text, attachments: tempPaths };
  }

  const inputParts: Exclude<Input, string> = [];
  const parsed = (payload ?? {}) as PromptPayload;
  const text = sanitizeInput(parsed.text);
  if (text) {
    inputParts.push({ type: "text", text });
  }

  if (Array.isArray(parsed.images) && parsed.images.length > 0) {
    for (const image of parsed.images) {
      const result = persistIncomingImage(image, imageDir);
      if (!result.ok) {
        cleanupTempFiles(tempPaths);
        return { ok: false, message: result.message };
      }
      tempPaths.push(result.path);
      inputParts.push({ type: "local_image", path: result.path });
    }
  }

  if (inputParts.length === 0) {
    cleanupTempFiles(tempPaths);
    return { ok: false, message: "payload 不能为空" };
  }

  if (inputParts.length === 1 && inputParts[0].type === "text") {
    return { ok: true, input: inputParts[0].text, attachments: tempPaths };
  }
  return { ok: true, input: inputParts, attachments: tempPaths };
}

export function formatAttachmentList(paths: string[], cwd: string): string {
  return paths
    .map((p) => {
      const rel = path.relative(cwd, p);
      if (rel && !rel.startsWith("..")) {
        return rel;
      }
      return path.basename(p);
    })
    .join(", ");
}

export function buildUserLogEntry(input: Input, cwd: string): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed || "(no text)";
  }

  const lines: string[] = [];
  const textParts = input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean);
  if (textParts.length) {
    lines.push(textParts.join("\n"));
  }

  const imageParts = input
    .filter((part): part is { type: "local_image"; path: string } => part.type === "local_image")
    .map((part) => part.path);
  if (imageParts.length) {
    lines.push(`Images: ${formatAttachmentList(imageParts, cwd)}`);
  }

  return lines.length ? lines.join("\n") : "(no text)";
}
