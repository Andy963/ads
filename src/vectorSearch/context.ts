import { createLogger } from "../utils/logger.js";
import type { VectorQueryHit } from "./types.js";
import { queryVectorSearchHits } from "./run.js";

const logger = createLogger("VectorSearchContext");

export interface VectorAutoContextConfig {
  enabled: boolean;
  topK: number;
  maxChars: number;
  minScore: number;
  minIntervalMs: number;
  triggerKeywords: string[];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseFloatNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

const DEFAULT_TRIGGER_KEYWORDS = [
  // 中文：指代/延续
  "继续",
  "刚才",
  "刚刚",
  "上面",
  "前面",
  "之前",
  "上次",
  "回顾",
  "复盘",
  "总结一下",
  "按之前",
  "按照之前",
  "基于之前",
  "沿用",
  "复用",
  "照旧",
  "同样",
  "回忆",
  "你还记得",
  "还记得",
  "还记得吗",
  // English: continuity / references
  "continue",
  "previous",
  "earlier",
  "above",
  "as discussed",
  "as before",
  "recap",
  "remind me",
];

export function resolveVectorAutoContextConfig(): VectorAutoContextConfig {
  const enabled = parseBoolean(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED) ?? true;
  const topK = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TOPK, 6);
  const maxChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MAX_CHARS, 6000);
  const minScore = parseFloatNumber(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE, 0.62);
  const minIntervalMs = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS, 60_000);
  const extras = parseCsv(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS);
  const triggerKeywords = Array.from(new Set([...DEFAULT_TRIGGER_KEYWORDS, ...extras])).filter(Boolean);
  return { enabled, topK, maxChars, minScore, minIntervalMs, triggerKeywords };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function normalizeWhitespace(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickHitText(hit: VectorQueryHit): string {
  return normalizeWhitespace(
    safeString(hit.text) || safeString(hit.snippet) || safeString(hit.metadata?.snippet) || safeString(hit.metadata?.text_preview),
  );
}

function labelForHit(hit: VectorQueryHit): string {
  const md = hit.metadata ?? {};
  const sourceType = safeString((md as any).source_type) || "unknown";
  if (sourceType === "spec" || sourceType === "adr") {
    const relPath = safeString((md as any).path);
    return relPath ? `${sourceType}:${relPath}` : sourceType;
  }
  if (sourceType === "chat") {
    const ns = safeString((md as any).namespace);
    const role = safeString((md as any).role);
    const nsPart = ns ? `chat:${ns}` : "chat";
    const rolePart = role ? `/${role}` : "";
    return `${nsPart}${rolePart}`;
  }
  return sourceType;
}

function isChatUserEcho(hit: VectorQueryHit, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  const md = hit.metadata ?? {};
  const sourceType = safeString((md as any).source_type) || "";
  if (sourceType !== "chat") return false;
  const role = safeString((md as any).role) || "";
  if (role !== "user") return false;
  const text = pickHitText(hit).toLowerCase();
  if (!text) return false;
  if (text === normalizedQuery) return true;
  if (text.length >= 40 && normalizedQuery.includes(text)) return true;
  return false;
}

function shouldTriggerAutoContext(query: string, triggers: string[]): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const lowered = trimmed.toLowerCase();

  for (const trigger of triggers) {
    const needle = String(trigger ?? "").trim();
    if (!needle) continue;
    const needleLowered = needle.toLowerCase();
    if (needleLowered && lowered.includes(needleLowered)) {
      return true;
    }
  }

  return false;
}

type AutoContextCacheEntry = {
  updatedAtMs: number;
  context: string | null;
};

const AUTO_CONTEXT_CACHE = new Map<string, AutoContextCacheEntry>();

export function formatVectorAutoContext(params: {
  hits: VectorQueryHit[];
  maxChars: number;
}): string {
  const hits = params.hits ?? [];
  if (hits.length === 0) {
    return "";
  }

  const maxChars = Math.max(600, params.maxChars);
  const seen = new Set<string>();
  const lines: string[] = [];
  lines.push("【补充上下文】");
  lines.push("（系统自动提供的历史对话/文档片段，仅供参考；如与当前用户输入冲突，以当前用户输入为准；不要在回复中提及检索过程或内部标识。）");
  lines.push("");

  let used = lines.join("\n").length;
  for (const hit of hits) {
    const text = pickHitText(hit);
    if (!text) continue;
    const label = labelForHit(hit);
    const clippedText = text.length > 900 ? `${text.slice(0, 899)}…` : text;
    const entry = `- ${label}: ${clippedText}`;
    const signature = normalizeWhitespace(entry).toLowerCase();
    if (seen.has(signature)) continue;
    seen.add(signature);

    if (used + entry.length + 1 > maxChars) {
      break;
    }
    lines.push(entry);
    used += entry.length + 1;
  }

  const output = lines.join("\n").trim();
  return output.length > maxChars ? output.slice(0, maxChars - 1).trimEnd() + "…" : output;
}

export async function maybeBuildVectorAutoContext(params: {
  workspaceRoot: string;
  query: string;
}): Promise<string | null> {
  const config = resolveVectorAutoContextConfig();
  if (!config.enabled) {
    return null;
  }

  const query = String(params.query ?? "").trim();
  if (!query) {
    return null;
  }
  if (query.startsWith("/")) {
    return null;
  }

  if (!shouldTriggerAutoContext(query, config.triggerKeywords)) {
    return null;
  }

  const cacheKey = String(params.workspaceRoot ?? "").trim();
  const now = Date.now();
  const cached = cacheKey ? AUTO_CONTEXT_CACHE.get(cacheKey) : undefined;
  if (cached && now - cached.updatedAtMs < config.minIntervalMs) {
    return cached.context;
  }

  const requestTopK = Math.min(24, Math.max(6, config.topK * 3));
  const result = await queryVectorSearchHits({
    workspaceRoot: params.workspaceRoot,
    query,
    topK: requestTopK,
  });
  if (!result.ok || result.hits.length === 0) {
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context: null });
    }
    return null;
  }

  const normalizedQuery = normalizeWhitespace(query).toLowerCase();

  const filtered = result.hits
    .filter((hit) => !isChatUserEcho(hit, normalizedQuery))
    .filter((hit) => {
      const score = toNumber(hit.score);
      if (score === undefined) return true;
      return score >= config.minScore;
    })
    .slice(0, config.topK);

  if (filtered.length === 0) {
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context: null });
    }
    return null;
  }

  try {
    const formatted = formatVectorAutoContext({ hits: filtered, maxChars: config.maxChars });
    const context = formatted.trim() ? formatted : null;
    if (cacheKey) {
      AUTO_CONTEXT_CACHE.set(cacheKey, { updatedAtMs: now, context });
    }
    return context;
  } catch (error) {
    logger.warn(`[VectorSearchContext] Failed to format context`, error);
    return null;
  }
}
