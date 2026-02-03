import type { VectorQueryHit } from "./types.js";

import { normalizeWhitespace, safeString } from "./autoContextUtils.js";

function pickHitText(hit: VectorQueryHit): string {
  return normalizeWhitespace(
    safeString(hit.text) || safeString(hit.snippet) || safeString(hit.metadata?.snippet) || safeString(hit.metadata?.text_preview),
  );
}

function labelForHit(hit: VectorQueryHit): string {
  const md = hit.metadata ?? {};
  const sourceType = safeString(md["source_type"]) || "unknown";
  if (sourceType === "spec" || sourceType === "adr") {
    const relPath = safeString(md["path"]);
    return relPath ? `${sourceType}:${relPath}` : sourceType;
  }
  if (sourceType === "chat") {
    const ns = safeString(md["namespace"]);
    const role = safeString(md["role"]);
    const nsPart = ns ? `chat:${ns}` : "chat";
    const rolePart = role ? `/${role}` : "";
    return `${nsPart}${rolePart}`;
  }
  return sourceType;
}

export function isChatUserEcho(hit: VectorQueryHit, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  const md = hit.metadata ?? {};
  const sourceType = safeString(md["source_type"]) || "";
  if (sourceType !== "chat") return false;
  const role = safeString(md["role"]) || "";
  if (role !== "user") return false;
  const text = pickHitText(hit).toLowerCase();
  if (!text) return false;
  if (text === normalizedQuery) return true;
  if (text.length >= 40 && normalizedQuery.includes(text)) return true;
  return false;
}

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

