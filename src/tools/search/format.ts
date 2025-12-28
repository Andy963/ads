import type { SearchResponse } from "./types.js";

function truncate(text: string, limit: number): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit <= 1) {
    return "…";
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function formatSearchResults(query: string, response: SearchResponse): string {
  const lines: string[] = [];
  lines.push(`🔎 搜索：${truncate(query, 96)}`);

  if (response.results.length === 0) {
    lines.push("未找到结果。");
  } else {
    response.results.forEach((item, index) => {
      const title = item.title || "Untitled";
      const url = item.url ? ` ${item.url}` : "";
      const snippet = item.snippet || item.content || "";
      const snippetPart = snippet ? ` - ${truncate(snippet, 140)}` : "";
      lines.push(`${index + 1}. ${title}${url}${snippetPart}`);
    });
  }

  const tookMs = response.meta?.tookMs ?? 0;
  const total = response.meta?.total ?? response.results.length;
  lines.push(`(共 ${total} 条，展示 ${response.results.length} 条，用时 ${tookMs}ms)`);

  return lines.join("\n");
}

