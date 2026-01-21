import { createLogger } from "./logger.js";
import { stripLeadingTranslation } from "./assistantText.js";
import { loadWorkspaceHistoryRows, type WorkspaceHistoryRow } from "./workspaceHistory.js";

const logger = createLogger("WorkspaceRecall");

export type RecallDecision =
  | { action: "accept" }
  | { action: "ignore" }
  | { action: "edit"; text: string };

export interface WorkspaceRecallConfig {
  lookbackTurns: number;
  maxChars: number;
}

export interface CandidateMemory {
  memoryForPrompt: string;
  previewForUser: string;
}

interface WorkspaceTurn {
  namespace: string;
  sessionId: string;
  user: WorkspaceHistoryRow;
  ai?: WorkspaceHistoryRow;
}

function truncateToChars(text: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return "…";
  }
  return `${text.slice(0, limit - 1)}…`;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase();
}

function extractKeywords(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  const keywords = new Set<string>();

  const english = trimmed.match(/[a-zA-Z]{3,}/g) ?? [];
  for (const token of english) {
    keywords.add(token.toLowerCase());
  }

  const cjkChunks = trimmed.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const chunk of cjkChunks.slice(0, 6)) {
    keywords.add(chunk);
  }

  const parts = trimmed
    .split(/[\s,.;:!?()[\]{}<>"'`，。；：！？（）【】《》]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  for (const part of parts.slice(0, 12)) {
    keywords.add(part.toLowerCase());
  }

  return Array.from(keywords).slice(0, 12);
}

function scoreTurn(turn: WorkspaceTurn, keywords: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }
  const aiText = turn.ai ? stripLeadingTranslation(turn.ai.text) : "";
  const combined = `${turn.user.text}\n${aiText}`;
  const normalized = normalizeForMatch(combined);
  let score = 0;
  for (const keyword of keywords) {
    const needle = normalizeForMatch(keyword);
    if (needle && normalized.includes(needle)) {
      score += 1;
    }
  }
  return score;
}

function buildTurns(rows: WorkspaceHistoryRow[], lookbackTurns: number, excludeUserText?: string): WorkspaceTurn[] {
  const turns: WorkspaceTurn[] = [];
  const pendingAiBySource = new Map<string, WorkspaceHistoryRow>();
  const exclude = excludeUserText?.trim();
  let excludedOnce = false;

  for (const row of rows) {
    const sourceKey = `${row.namespace}::${row.session_id}`;

    if (row.role === "ai") {
      if (!pendingAiBySource.has(sourceKey)) {
        pendingAiBySource.set(sourceKey, row);
      }
      continue;
    }

    if (row.role !== "user") {
      continue;
    }

    if (exclude && !excludedOnce && row.text.trim() === exclude) {
      excludedOnce = true;
      continue;
    }

    const ai = pendingAiBySource.get(sourceKey);
    if (ai) {
      pendingAiBySource.delete(sourceKey);
      turns.push({ namespace: row.namespace, sessionId: row.session_id, user: row, ai });
    } else {
      turns.push({ namespace: row.namespace, sessionId: row.session_id, user: row });
    }

    if (turns.length >= lookbackTurns) {
      break;
    }
  }

  return turns;
}

function formatSnippet(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return truncateToChars(normalized, limit);
}

function detectPotentialConflicts(turns: WorkspaceTurn[], keywords: string[]): string[] {
  const negativeMarkers = [
    "不要",
    "禁止",
    "不能",
    "不允许",
    "必须",
    "never",
    "must not",
    "do not",
    "don't",
  ];

  const conflicts: string[] = [];
  for (const turn of turns) {
    const aiText = turn.ai ? stripLeadingTranslation(turn.ai.text) : "";
    const combined = `${turn.user.text}\n${aiText}`;
    const normalized = normalizeForMatch(combined);
    const hasMarker = negativeMarkers.some((marker) => normalized.includes(normalizeForMatch(marker)));
    if (!hasMarker) {
      continue;
    }
    const sharesKeyword = keywords.some((keyword) => {
      const needle = normalizeForMatch(keyword);
      return needle && normalized.includes(needle);
    });
    if (!sharesKeyword) {
      continue;
    }
    const snippet = formatSnippet(combined, 120);
    conflicts.push(`[${turn.namespace}] ${snippet}`);
    if (conflicts.length >= 5) {
      break;
    }
  }
  return conflicts;
}

export function buildCandidateMemory(params: {
  workspaceRoot: string;
  inputText: string;
  config: WorkspaceRecallConfig;
  excludeLatestUserText?: string;
}): CandidateMemory | null {
  const lookbackTurns = Math.max(1, params.config.lookbackTurns);
  const maxChars = Math.max(200, params.config.maxChars);
  const inputText = params.inputText.trim();
  if (!inputText) {
    return null;
  }

  const scanLimit = Math.min(Math.max(lookbackTurns * 6, 300), 5000);
  const rows = loadWorkspaceHistoryRows({
    workspaceRoot: params.workspaceRoot,
    roles: ["user", "ai"],
    limit: scanLimit,
  });

  if (rows.length === 0) {
    return null;
  }

  const turns = buildTurns(rows, lookbackTurns, params.excludeLatestUserText);
  if (turns.length === 0) {
    return null;
  }

  const keywords = extractKeywords(inputText);
  const scored = turns
    .map((turn, idx) => ({
      turn,
      idx,
      score: scoreTurn(turn, keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    });

  const selected = scored.slice(0, 10).map((entry) => entry.turn);
  if (selected.length === 0) {
    return null;
  }

  const conflicts = detectPotentialConflicts(selected, keywords);

  const header = "🧠 检索到可能相关的历史（候选记忆，需你确认）";
  const instructions = [
    "回复：",
    "- 发送 ‘是/yes/y’ 采用",
    "- 发送 ‘否/no/n’ 忽略（仍会继续处理原始需求）",
    "- 发送 ‘修改: ...’ 采用并替换为你的版本",
  ].join("\n");

  const conflictSection =
    conflicts.length > 0
      ? [
          "",
          "⚠️ 可能冲突/易误导点（请确认）：",
          ...conflicts.map((line) => `- ${line}`),
        ].join("\n")
      : "";

  const fixedParts = [header, "", instructions, conflictSection].filter(Boolean).join("\n");
  const budgetForMemory = Math.max(0, maxChars - fixedParts.length - 4);

  const memoryLines: string[] = [];
  for (const turn of selected) {
    const userLine = `- [${turn.namespace}] U: ${formatSnippet(turn.user.text, 180)}`;
    const aiLine = turn.ai ? `  A: ${formatSnippet(stripLeadingTranslation(turn.ai.text), 220)}` : null;

    const block = aiLine ? `${userLine}\n${aiLine}` : userLine;
    const next = memoryLines.length === 0 ? block : `${memoryLines.join("\n")}\n${block}`;
    if (next.length > budgetForMemory) {
      break;
    }
    memoryLines.push(block);
  }

  const memoryForPrompt = truncateToChars(memoryLines.join("\n"), maxChars);
  if (!memoryForPrompt.trim()) {
    return null;
  }

  const previewParts = [header, memoryForPrompt, conflictSection, "", instructions].filter(Boolean);
  const previewForUser = truncateToChars(previewParts.join("\n"), maxChars);

  return { memoryForPrompt, previewForUser };
}

function normalizeDecisionText(text: string): string {
  return text.trim();
}

export function parseRecallDecision(text: string): RecallDecision | null {
  const normalized = normalizeDecisionText(text);
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();

  if (lowered.startsWith("修改:") || lowered.startsWith("edit:")) {
    const payload = normalized.slice(normalized.indexOf(":") + 1).trim();
    if (!payload) {
      return null;
    }
    return { action: "edit", text: payload };
  }

  const acceptWords = new Set(["是", "好", "好的", "确认", "确定", "采用", "yes", "y", "ok", "okay"]);
  if (acceptWords.has(lowered) || acceptWords.has(normalized)) {
    return { action: "accept" };
  }

  const ignoreWords = new Set(["否", "不", "忽略", "继续", "跳过", "no", "n"]);
  if (ignoreWords.has(lowered) || ignoreWords.has(normalized)) {
    return { action: "ignore" };
  }
  return null;
}

export function isLikelyConfirmationMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  const lowered = normalized.toLowerCase();
  return [
    "是",
    "好",
    "好的",
    "ok",
    "okay",
    "yes",
    "y",
    "no",
    "n",
    "否",
    "不",
    "继续",
    "确定",
    "收到",
    "行",
  ].includes(lowered) || ["好的", "继续", "确定"].includes(normalized);
}

export function shouldTriggerRecall(params: {
  text: string;
  classifyEnabled: boolean;
  classification?: "task" | "chat" | "unknown";
}): boolean {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (isLikelyConfirmationMessage(trimmed)) {
    return false;
  }

  if (params.classifyEnabled && params.classification) {
    if (params.classification === "task") {
      return true;
    }
    if (params.classification === "chat") {
      return false;
    }
  }

  const heuristicMarkers = [
    "帮我",
    "实现",
    "修复",
    "新增",
    "增加",
    "需求",
    "功能",
    "优化",
    "改成",
    "please",
    "implement",
    "fix",
    "add",
    "support",
  ];
  const lowered = trimmed.toLowerCase();
  if (heuristicMarkers.some((marker) => lowered.includes(marker.toLowerCase()))) {
    return true;
  }

  // default: do not interrupt
  return false;
}

export function buildRecallFollowupMessage(): string {
  return [
    "我正在等待你确认候选记忆。",
    "请回复：‘是/yes/y’ 采用，‘否/no/n’ 忽略，或 ‘修改: ...’ 采用并替换。",
  ].join("\n");
}

export function safeLogPreview(text: string): void {
  logger.debug(`[WorkspaceRecall] preview=${truncateToChars(text.replace(/\s+/g, " "), 120)}`);
}
