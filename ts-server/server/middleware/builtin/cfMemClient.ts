import { createHash } from "node:crypto";

import type { TurnContext } from "../types.js";
import { createLogger } from "../../utils/logger.js";
import { resolveCfMemScope, type CfMemScope } from "./cfMemScope.js";

const logger = createLogger("CfMem");

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RECALL_QUERY_CHARS = 4_000;
const MAX_RECALLED_MEMORY_CHARS = 4_000;
const MAX_CLAIM_CHARS = 1_000;
const MAX_INGEST_TEXT_CHARS = 8_000;
const MAX_SESSION_ID_CHARS = 256;

export interface CfMemClientOptions {
  apiBase: string;
  apiKey: string;
  recallTopK?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CfMemClient {
  recall(ctx: TurnContext): Promise<string | null>;
  ingest(ctx: TurnContext, assistantReply: string): Promise<void>;
}

export function normalizeCfMemUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = !pathname || pathname === "/"
    ? "/memory"
    : pathname.endsWith("/memory")
      ? pathname
      : `${pathname}/memory`;
  return parsed.toString().replace(/\/$/, "");
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      sanitized += " ";
    } else if (code !== 13) {
      sanitized += character;
    }
  }
  return sanitized.trim().slice(0, maxLength);
}

function stripRecalledMemory(value: string): string {
  return value.replace(/<recalled_memory(?:\s[^>]*)?>[\s\S]*?<\/recalled_memory>\s*/gi, "").trim();
}

function resolveOriginalPrompt(ctx: TurnContext): string {
  return boundedText(
    stripRecalledMemory(ctx.originalPrompt ?? ctx.prompt),
    MAX_RECALL_QUERY_CHARS,
  );
}

function resolveServerUserId(ctx: TurnContext): string | null {
  const value = ctx.metadata?.authUserId;
  const userId = boundedText(value, 256);
  return userId || null;
}

function resolveSessionId(ctx: TurnContext): string | null {
  const sessionId = boundedText(ctx.sessionId, MAX_SESSION_ID_CHARS);
  return sessionId || null;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_RECALL_LIMIT;
  return Math.max(1, Math.min(20, Math.floor(value ?? DEFAULT_RECALL_LIMIT)));
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.min(30_000, Math.floor(value ?? DEFAULT_TIMEOUT_MS)));
}

function extractClaimText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  const candidates = [claim.canonical_text, claim.text, claim.value];
  for (const candidate of candidates) {
    const text = boundedText(candidate, MAX_CLAIM_CHARS);
    if (text) return stripRecalledMemory(text);
  }
  return null;
}

function formatRecalledMemory(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const claims = (payload as Record<string, unknown>).claims;
  if (!Array.isArray(claims)) return null;

  const lines: string[] = [];
  let totalLength = 0;
  for (const claim of claims) {
    const text = extractClaimText(claim);
    if (!text) continue;
    const remaining = MAX_RECALLED_MEMORY_CHARS - totalLength;
    if (remaining <= 0) break;
    const bounded = text.slice(0, remaining);
    lines.push(`- ${bounded}`);
    totalLength += bounded.length + 3;
  }
  return lines.length > 0 ? lines.join("\n").slice(0, MAX_RECALLED_MEMORY_CHARS) : null;
}

function stripInternalOutput(value: string): string {
  const cleaned = value
    .replace(/<recalled_memory(?:\s[^>]*)?>[\s\S]*?<\/recalled_memory>\s*/gi, "")
    .replace(/<<<tool\.[a-z0-9_.-]+[^>]*>>>[\s\S]*?>>>/gi, "")
    .replace(/<(?:analysis|reasoning|thinking|thought|plan|patch|command|tool_trace)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|reasoning|thinking|thought|plan|patch|command|tool_trace)>/gi, "")
    .trim();
  return boundedText(cleaned, MAX_INGEST_TEXT_CHARS);
}

function createEventId(turnId: string, role: "user" | "assistant"): string {
  return `ads-${createHash("sha256").update(`${turnId}\n${role}`).digest("hex").slice(0, 32)}`;
}

function resolveScope(ctx: TurnContext): { scope: CfMemScope; userId: string; sessionId: string } | null {
  const scope = resolveCfMemScope(ctx.workspaceRoot);
  const userId = resolveServerUserId(ctx);
  const sessionId = resolveSessionId(ctx);
  if (!scope || !userId || !sessionId) return null;
  return { scope, userId, sessionId };
}

export function createCfMemClient(options: CfMemClientOptions): CfMemClient {
  const apiBase = normalizeCfMemUrl(options.apiBase);
  if (!apiBase) throw new Error("CFMEM_URL is invalid");
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("CFMEM_API_KEY is required");

  const fetchImpl = options.fetchImpl ?? fetch;
  const recallTopK = normalizeLimit(options.recallTopK);
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  async function post(
    pathname: string,
    body: Record<string, unknown>,
    projectId: string,
    operation: string,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    const timeoutHandler = () => {
      timedOut = true;
    };
    controller.signal.addEventListener("abort", timeoutHandler, { once: true });
    try {
      const response = await fetchImpl(`${apiBase}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Project-Id": projectId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        logger.warn(`[CfMem] ${operation} failed status=${response.status}`);
        return null;
      }
      try {
        return await response.json() as unknown;
      } catch {
        logger.warn(`[CfMem] ${operation} failed reason=malformed_response`);
        return null;
      }
    } catch {
      logger.warn(`[CfMem] ${operation} failed reason=${timedOut ? "timeout" : "network"}`);
      return null;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", timeoutHandler);
    }
  }

  return {
    async recall(ctx: TurnContext): Promise<string | null> {
      const resolved = resolveScope(ctx);
      const query = resolveOriginalPrompt(ctx);
      if (!resolved || !query) return null;

      const response = await post("/context", {
        user_id: resolved.userId,
        session_id: resolved.sessionId,
        query,
        categories: ["rule", "user_profile", "domain_fact"],
        workspace_id: resolved.scope.workspaceId,
        limit: recallTopK,
      }, resolved.scope.projectId, "recall");
      return formatRecalledMemory(response);
    },

    async ingest(ctx: TurnContext, assistantReply: string): Promise<void> {
      const resolved = resolveScope(ctx);
      if (!resolved) return;

      const entries: Array<{ role: "user" | "assistant"; text: string }> = [
        { role: "user", text: resolveOriginalPrompt(ctx) },
        { role: "assistant", text: stripInternalOutput(assistantReply) },
      ];
      for (const entry of entries) {
        if (!entry.text) continue;
        await post("/profile/ingest", {
          text: entry.text,
          role: entry.role,
          source_app: "codex",
          external_session_id: resolved.sessionId,
          workspace_id: resolved.scope.workspaceId,
          workspace_name: resolved.scope.workspaceName,
          event_id: createEventId(ctx.turnId, entry.role),
        }, resolved.scope.projectId, "ingest");
      }
    },
  };
}
