import type { Database as DatabaseType } from "better-sqlite3";

import type { Usage } from "../agents/protocol/types.js";
import type { NativeChatMessage } from "../runtime/openAiCompatibleClient.js";

export type NativeTranscriptTurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NativeTranscriptEntry =
  | {
      kind: "message";
      message: NativeChatMessage;
    }
  | {
      kind: "command";
      toolCallId: string;
      command: string;
      status: "completed" | "failed";
      exitCode?: number;
      output?: string;
    }
  | {
      kind: "file_change";
      toolCallId: string;
      changes: Array<{
        path: string;
        kind: string;
      }>;
    };

export interface NativeTranscriptProviderMetadata {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface NativeTranscriptTurnRecord {
  turnId: string;
  status: NativeTranscriptTurnStatus;
  messages: NativeChatMessage[];
  entries: NativeTranscriptEntry[];
  usage: Usage | null;
  provider: NativeTranscriptProviderMetadata | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NativeTranscriptStoreOptions {
  redactions?: string[];
}

export class NativeTranscriptWriterSupersededError extends Error {
  constructor() {
    super("Native transcript writer was superseded by a newer session instance.");
    this.name = "NativeTranscriptWriterSupersededError";
  }
}

type StoredTurnRow = {
  turn_id: string;
  status: NativeTranscriptTurnStatus;
  messages_json: string;
  entries_json: string;
  usage_json: string | null;
  provider_json: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

const INTERRUPTED_ERROR = "Native turn was interrupted before completion.";
const MAX_TRANSCRIPT_ERROR_LENGTH = 64 * 1024;
const CREDENTIAL_ASSIGNMENT = /(\b[A-Za-z_][A-Za-z0-9_.-]*\b\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;&}]+)/g;
const CREDENTIAL_KEY_PARTS = [
  "auth",
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "credential",
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "signingkey",
  "pepper",
];

function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "token"
    || normalized.endsWith("token")
    || CREDENTIAL_KEY_PARTS.some((part) => normalized.includes(part))
    || (
      normalized.endsWith("key")
      && (normalized.includes("client") || normalized.includes("private") || normalized.includes("signing"))
    );
}

function collectExplicitRedactions(options: NativeTranscriptStoreOptions): string[] {
  const values = (options.redactions ?? [])
    .map((value) => String(value ?? ""))
    .filter((value) => value.length > 0);
  const variants = new Set<string>();
  for (const value of values) {
    variants.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    variants.add(escaped);
    variants.add(JSON.stringify(escaped).slice(1, -1));
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function redactSensitiveText(value: string, redactions: string[], depth = 0): string {
  let result = String(value ?? "");
  const trimmed = result.trimStart();
  if (depth < 5 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      return JSON.stringify(sanitizeTranscriptValue(JSON.parse(result), redactions, depth + 1));
    } catch {
      // Fall through to delimiter-aware redaction for malformed JSON-like text.
    }
  }
  for (const secret of redactions) {
    result = result.replaceAll(secret, "[redacted]");
  }
  result = result
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(
      /(-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g,
      "$1[redacted]$2",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(
      CREDENTIAL_ASSIGNMENT,
      (match: string, prefix: string, secretValue: string) => {
        const key = prefix.match(/^[A-Za-z_][A-Za-z0-9_.-]*/)?.[0] ?? "";
        if (!isCredentialField(key)) return match;
        const quote = secretValue.startsWith("\"") || secretValue.startsWith("'") ? secretValue[0] : "";
        return `${prefix}${quote}[redacted]${quote}`;
      },
    );
  return result;
}

function sanitizeTranscriptValue(value: unknown, redactions: string[], depth = 0): unknown {
  if (depth > 20) return "[truncated]";
  if (typeof value === "string") return redactSensitiveText(value, redactions);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTranscriptValue(item, redactions, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value ?? "");

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialField(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitizeTranscriptValue(item, redactions, depth + 1);
  }
  return result;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const usage: Usage = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    const item = Number(record[key]);
    if (Number.isFinite(item)) usage[key] = item;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

export class NativeTranscriptStore {
  private redactions: string[];

  constructor(
    private readonly db: DatabaseType,
    options: NativeTranscriptStoreOptions = {},
  ) {
    this.redactions = collectExplicitRedactions(options);
  }

  addRedactions(values: string[]): void {
    this.redactions = collectExplicitRedactions({
      redactions: [...this.redactions, ...values],
    });
  }

  claimTranscript(transcriptId: string, writerId: string): void {
    this.db.prepare(`
      INSERT INTO native_transcript_leases (transcript_id, writer_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(transcript_id) DO UPDATE SET writer_id = excluded.writer_id, updated_at = excluded.updated_at
    `).run(transcriptId, writerId, Date.now());
  }

  beginTurn(input: {
    transcriptId: string;
    turnId: string;
    messages: NativeChatMessage[];
    entries: NativeTranscriptEntry[];
    provider: NativeTranscriptProviderMetadata;
    writerId?: string;
  }): void {
    const writerId = String(input.writerId ?? "");
    const lease = this.db.prepare(`
      SELECT writer_id FROM native_transcript_leases WHERE transcript_id = ?
    `).get(input.transcriptId) as { writer_id?: string } | undefined;
    if (lease && lease.writer_id !== writerId) {
      throw new NativeTranscriptWriterSupersededError();
    }
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO native_transcript_turns (
        transcript_id, turn_id, status, messages_json, entries_json,
        usage_json, provider_json, error_message, writer_id, created_at, updated_at
      ) VALUES (?, ?, 'running', ?, ?, NULL, ?, NULL, ?, ?, ?)
    `).run(
      input.transcriptId,
      input.turnId,
      this.stringify(input.messages),
      this.stringify(input.entries),
      this.stringify(input.provider),
      String(input.writerId ?? ""),
      now,
      now,
    );
  }

  updateTurn(input: {
    transcriptId: string;
    turnId: string;
    status: NativeTranscriptTurnStatus;
    messages: NativeChatMessage[];
    entries: NativeTranscriptEntry[];
    usage: Usage | null;
    errorMessage?: string | null;
    writerId?: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE native_transcript_turns
      SET status = ?, messages_json = ?, entries_json = ?, usage_json = ?, error_message = ?, updated_at = ?
      WHERE transcript_id = ? AND turn_id = ? AND status = 'running' AND writer_id = ?
    `).run(
      input.status,
      this.stringify(input.messages),
      this.stringify(input.entries),
      input.usage ? this.stringify(input.usage) : null,
      input.errorMessage
        ? redactSensitiveText(input.errorMessage, this.redactions).slice(0, MAX_TRANSCRIPT_ERROR_LENGTH)
        : null,
      Date.now(),
      input.transcriptId,
      input.turnId,
      String(input.writerId ?? ""),
    );
    if (result.changes !== 1) {
      throw new Error(`Native transcript turn not found: ${input.turnId}`);
    }
  }

  listTurns(transcriptId: string): NativeTranscriptTurnRecord[] {
    this.markRunningTurnsInterrupted(transcriptId);
    const rows = this.db.prepare(`
      SELECT turn_id, status, messages_json, entries_json, usage_json,
             provider_json, error_message, created_at, updated_at
      FROM native_transcript_turns
      WHERE transcript_id = ?
      ORDER BY id ASC
    `).all(transcriptId) as StoredTurnRow[];

    return rows.map((row) => ({
      turnId: row.turn_id,
      status: row.status,
      messages: parseJson<NativeChatMessage[]>(row.messages_json, []),
      entries: parseJson<NativeTranscriptEntry[]>(row.entries_json, []),
      usage: normalizeUsage(parseJson<unknown>(row.usage_json, null)),
      provider: parseJson<NativeTranscriptProviderMetadata | null>(row.provider_json, null),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  loadCompletedMessages(transcriptId: string): NativeChatMessage[] {
    return this.listTurns(transcriptId)
      .filter((turn) => turn.status === "completed")
      .flatMap((turn) => turn.messages);
  }

  clear(transcriptId: string): void {
    this.db.prepare("DELETE FROM native_transcript_turns WHERE transcript_id = ?").run(transcriptId);
  }

  private markRunningTurnsInterrupted(transcriptId: string): void {
    this.db.prepare(`
      UPDATE native_transcript_turns
      SET status = 'interrupted', error_message = ?, updated_at = ?
      WHERE transcript_id = ? AND status = 'running'
    `).run(INTERRUPTED_ERROR, Date.now(), transcriptId);
  }

  private stringify(value: unknown): string {
    return JSON.stringify(sanitizeTranscriptValue(value, this.redactions));
  }
}
