import { searchWorkspaceHistory, type WorkspaceSearchParams } from "./workspaceSearch.js";
import { loadWorkspaceHistoryRows, type WorkspaceHistoryRow } from "./workspaceHistory.js";
import { stripLeadingTranslation } from "./assistantText.js";
import { getWorkspaceHistoryConfig } from "./workspaceHistoryConfig.js";

export interface HistorySearchResult {
  found: boolean;
  results: string;
  conflicts: string[];
  hasConflicts: boolean;
}

const NEGATIVE_MARKERS = [
  "不要",
  "禁止",
  "不能",
  "不允许",
  "必须",
  "never",
  "must not",
  "do not",
  "don't",
  "cannot",
  "should not",
];

function truncateToChars(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase();
}

function detectConflicts(rows: WorkspaceHistoryRow[], keywords: string[]): string[] {
  if (keywords.length === 0) return [];

  const conflicts: string[] = [];
  const normalizedKeywords = keywords.map((k) => normalizeForMatch(k));

  for (const row of rows) {
    const text = stripLeadingTranslation(row.text);
    const normalized = normalizeForMatch(text);

    const hasMarker = NEGATIVE_MARKERS.some((marker) =>
      normalized.includes(normalizeForMatch(marker))
    );
    if (!hasMarker) continue;

    const sharesKeyword = normalizedKeywords.some(
      (keyword) => keyword && normalized.includes(keyword)
    );
    if (!sharesKeyword) continue;

    const snippet = truncateToChars(text.replace(/\s+/g, " ").trim(), 150);
    conflicts.push(`[${row.namespace}] ${snippet}`);
    if (conflicts.length >= 5) break;
  }

  return conflicts;
}

function extractKeywordsFromQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const keywords = new Set<string>();

  const english = trimmed.match(/[a-zA-Z]{2,}/g) ?? [];
  for (const token of english) {
    keywords.add(token.toLowerCase());
  }

  const cjkChunks = trimmed.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const chunk of cjkChunks.slice(0, 8)) {
    keywords.add(chunk);
  }

  return Array.from(keywords).slice(0, 12);
}

export function searchHistoryForAgent(params: {
  workspaceRoot: string;
  query: string;
  maxResults?: number;
}): HistorySearchResult {
  const config = getWorkspaceHistoryConfig();
  const maxResults = params.maxResults ?? 10;

  const searchParams: WorkspaceSearchParams = {
    workspaceRoot: params.workspaceRoot,
    query: params.query,
    engine: config.searchEngine,
    scanLimit: config.searchScanLimit,
    maxResults,
    maxChars: config.maxChars,
  };

  const outcome = searchWorkspaceHistory(searchParams);

  const rows = loadWorkspaceHistoryRows({
    workspaceRoot: params.workspaceRoot,
    roles: ["user", "ai"],
    limit: Math.min(config.searchScanLimit, 200),
  });

  const keywords = extractKeywordsFromQuery(params.query);
  const conflicts = detectConflicts(rows, keywords);

  const found = !outcome.output.includes("(0 results)") && !outcome.output.includes("用法:");

  return {
    found,
    results: outcome.output,
    conflicts,
    hasConflicts: conflicts.length > 0,
  };
}

export function formatConflictWarning(conflicts: string[]): string {
  if (conflicts.length === 0) return "";

  return [
    "⚠️ 检测到可能冲突的历史指令，请用户确认：",
    ...conflicts.map((c) => `- ${c}`),
    "",
    "请告知用户这些历史指令是否仍然适用，或应该忽略。",
  ].join("\n");
}
