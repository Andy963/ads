import { parseBoolean, parseCsv, parseFloatNumber, parsePositiveInt } from "./contextHelpers.js";

export interface VectorAutoContextConfig {
  enabled: boolean;
  mode: "always" | "intent";
  topK: number;
  maxChars: number;
  minScore: number;
  minIntervalMs: number;
  minQueryChars: number;
  allowBareTriggers: boolean;
  triggerKeywords: string[];
  intentKeywords: string[];
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

const DEFAULT_INTENT_KEYWORDS = [
  // Chinese: codebase / docs / troubleshooting
  "代码",
  "源码",
  "仓库",
  "哪个文件",
  "报错",
  "错误",
  "日志",
  "堆栈",
  "栈",
  "调用链",
  "配置",
  "文档",
  "设计",
  "adr",
  // English: codebase / docs / troubleshooting
  "ads",
  "web",
  "api",
  "ws",
  "sqlite",
  "codebase",
  "repo",
  "repository",
  "source",
  "which file",
  "where is",
  "error",
  "exception",
  "stack",
  "traceback",
  "panic",
  "readme",
  "docs",
  "design",
  "adr",
];

export function resolveVectorAutoContextConfig(): VectorAutoContextConfig {
  const enabled = parseBoolean(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED) ?? true;
  const modeRaw = String(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MODE ?? "").trim().toLowerCase();
  const mode: VectorAutoContextConfig["mode"] = modeRaw === "always" ? "always" : "intent";
  const topK = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TOPK, 6);
  const maxChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MAX_CHARS, 6000);
  const minScore = parseFloatNumber(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE, 0.62);
  const minIntervalMs = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS, 0);
  const minQueryChars = parsePositiveInt(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_QUERY_CHARS, 40);
  const allowBareTriggers = parseBoolean(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_ALLOW_BARE_TRIGGERS) ?? true;
  const extras = parseCsv(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS);
  const intentExtras = parseCsv(process.env.ADS_VECTOR_SEARCH_AUTO_CONTEXT_INTENT_KEYWORDS);
  const triggerKeywords = Array.from(new Set([...DEFAULT_TRIGGER_KEYWORDS, ...extras])).filter(Boolean);
  const intentKeywords = Array.from(new Set([...DEFAULT_INTENT_KEYWORDS, ...intentExtras])).filter(Boolean);
  return { enabled, mode, topK, maxChars, minScore, minIntervalMs, minQueryChars, allowBareTriggers, triggerKeywords, intentKeywords };
}

