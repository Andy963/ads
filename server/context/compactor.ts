import type { Database as DatabaseType } from "better-sqlite3";

import { getStateDatabase } from "../state/database.js";
import { createLogger } from "../utils/logger.js";
import { estimateMessagesTokens } from "./tokenEstimator.js";

const logger = createLogger("Compactor");

export interface CompactionMessage {
  role: string;
  content: string;
  pinned?: boolean;
}

export interface CompactionResult {
  messages: CompactionMessage[];
  content: string;
  tokensBefore: number;
  tokensAfter: number;
}

export function buildCompactionHandoff(messages: CompactionMessage[]): string {
  const tail = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n").slice(-12000);
  return [
    "## Goal",
    "- Continue the current ADS session without losing relevant context.",
    "## Constraints & Preferences",
    "- Preserve user instructions and repository constraints from the prior conversation.",
    "## Progress",
    "### Done",
    "- See prior conversation excerpt below.",
    "### In Progress",
    "- Resume from the latest user request.",
    "## Key Decisions",
    "- No additional decisions were inferred by the compactor.",
    "## Relevant Files",
    "- Refer to file paths mentioned in the excerpt.",
    "## Next Steps",
    "- Continue from the latest unfinished task.",
    "## Critical Context",
    tail || "- No prior message content.",
  ].join("\n");
}

export function forceCompact(args: {
  workspaceId: string;
  sessionId: string;
  messages: CompactionMessage[];
  trigger?: "soft" | "hard" | "manual";
  keepTurns?: number;
  db?: DatabaseType;
}): CompactionResult {
  const keepTurns = Math.max(1, Math.floor(args.keepTurns ?? 4));
  const tokensBefore = estimateMessagesTokens(args.messages);
  const content = buildCompactionHandoff(args.messages);
  const keepCount = keepTurns * 2;
  const pinned = args.messages.filter((m) => m.pinned);
  const tail = args.messages.filter((m) => !m.pinned).slice(-keepCount);
  const compacted: CompactionMessage[] = [{ role: "system", content }, ...pinned, ...tail];
  const tokensAfter = estimateMessagesTokens(compacted);
  const truncated = args.messages.slice(0, Math.max(0, args.messages.length - tail.length)).map((m) => `${m.role}: ${m.content}`).join("\n\n");

  try {
    const db = args.db ?? getStateDatabase();
    db.prepare(`
      INSERT INTO compaction_snapshots (workspace_id, session_id, created_at, trigger, tokens_before, tokens_after, content, truncated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(args.workspaceId, args.sessionId, Date.now(), args.trigger ?? "manual", tokensBefore, tokensAfter, content, truncated);
  } catch (error) {
    logger.warn(`Failed to persist compaction snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { messages: compacted, content, tokensBefore, tokensAfter };
}

export function shouldCompact(args: { tokens: number; maxTokens: number; hard?: boolean }): boolean {
  if (String(process.env.ADS_COMPACT_DISABLED ?? "").toLowerCase() === "true") return false;
  const softRatio = Number.parseFloat(String(process.env.ADS_COMPACT_SOFT_RATIO ?? "0.70"));
  const hardRatio = Number.parseFloat(String(process.env.ADS_COMPACT_HARD_RATIO ?? "0.90"));
  const ratio = args.hard ? hardRatio : softRatio;
  return args.tokens >= args.maxTokens * ratio;
}
