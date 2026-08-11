import fsp from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../../utils/logger.js";

import { extractUserFacingPrompt, truncatePreview } from "./promptPreview.js";
import { claudeProjectSlug, claudeProjectsRoot } from "./sessionPaths.js";
import type { AgentSessionRef } from "./types.js";

const logger = createLogger("ClaudeSessionSource");

/** Claude has no `thread/list` equivalent, so transcripts are read directly. */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
/**
 * Files are scanned beyond `limit` because one-shot sessions are dropped
 * afterwards; without headroom a burst of them would starve the list.
 */
const TRANSCRIPT_SCAN_MULTIPLIER = 3;

interface TranscriptHead {
  sessionId?: string;
  cwd?: string;
  createdAt?: number;
  firstUserText?: string;
  userTurns: number;
  /** False when the file exceeded the head budget, making `userTurns` a lower bound. */
  complete: boolean;
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/**
 * Distinguishes a genuine user turn from a tool result. Claude Code records both
 * as `type: "user"`; on a tool-heavy session the tool results outnumber the real
 * turns roughly 75:1, so counting records directly is not usable as a signal.
 */
function isRealUserTurn(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.some(
      (part) => part && typeof part === "object" && (part as { type?: unknown }).type !== "tool_result",
    );
  }
  return typeof content === "string" ? content.trim().length > 0 : Boolean(content);
}

async function readTranscriptHead(filePath: string): Promise<TranscriptHead | null> {
  let raw: string;
  let complete: boolean;
  try {
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, TRANSCRIPT_HEAD_BYTES, 0);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
      // A short read means EOF was reached, so the turn count below is exact.
      complete = bytesRead < TRANSCRIPT_HEAD_BYTES;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const head: TranscriptHead = { userTurns: 0, complete };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The final line of a truncated read is usually incomplete; skip it.
      continue;
    }
    const record = parsed as {
      type?: string;
      sessionId?: string;
      cwd?: string;
      timestamp?: string;
      message?: unknown;
    };
    if (typeof record.sessionId === "string" && !head.sessionId) {
      head.sessionId = record.sessionId;
    }
    if (typeof record.cwd === "string" && !head.cwd) {
      head.cwd = record.cwd;
    }
    if (typeof record.timestamp === "string" && head.createdAt === undefined) {
      const parsedTs = Date.parse(record.timestamp);
      head.createdAt = Number.isFinite(parsedTs) ? parsedTs : undefined;
    }
    if (record.type !== "user" || !isRealUserTurn(record.message)) {
      continue;
    }
    head.userTurns += 1;
    if (!head.firstUserText) {
      head.firstUserText = extractUserFacingPrompt(extractMessageText(record.message)) || undefined;
    }
  }
  return head.sessionId ? head : null;
}

/**
 * List Claude sessions recorded on disk for one working directory. Sessions
 * started outside ADS show up here; sessions started by ADS are also covered by
 * the history-link source and are deduplicated by the catalog.
 */
export async function listClaudeSessionsViaTranscripts(args: {
  cwd: string;
  limit: number;
}): Promise<AgentSessionRef[]> {
  const dir = path.join(claudeProjectsRoot(), claudeProjectSlug(args.cwd));
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const stats = await Promise.all(
    entries.map(async (name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = await fsp.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const ordered = stats
    .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, args.limit * TRANSCRIPT_SCAN_MULTIPLIER);

  const refs: AgentSessionRef[] = [];
  for (const entry of ordered) {
    const head = await readTranscriptHead(entry.filePath);
    const sessionId = head?.sessionId ?? path.basename(entry.filePath, ".jsonl");
    if (!sessionId) {
      continue;
    }
    refs.push({
      agentId: "claude",
      sessionId,
      cwd: head?.cwd ?? args.cwd,
      title: head?.firstUserText ? truncatePreview(head.firstUserText, 60) : sessionId.slice(0, 8),
      preview: head?.firstUserText ? truncatePreview(head.firstUserText) : undefined,
      userTurns: head?.complete ? head.userTurns : undefined,
      // A truncated scan means the file is large, which is itself evidence of a
      // substantive session, so it is never classified as one-shot.
      singleTurn: head ? head.complete && head.userTurns < 2 : undefined,
      createdAt: head?.createdAt,
      updatedAt: entry.mtimeMs,
      source: "claude_transcript",
    });
  }
  return refs;
}

export async function listClaudeSessions(args: {
  cwd: string;
  limit: number;
}): Promise<{ items: AgentSessionRef[]; degraded?: string }> {
  try {
    const items = await listClaudeSessionsViaTranscripts(args);
    return { items };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`transcript scan failed: ${message}`);
    return { items: [], degraded: "claude_transcripts" };
  }
}
