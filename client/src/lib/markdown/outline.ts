import { md } from "./renderer";

type MarkdownOutlineToken = {
  type: string;
  content?: string;
  children?: MarkdownOutlineToken[];
};

function normalizeOutlineTitle(title: string, maxLen: number): string {
  const normalized = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

function extractStrongOnlyParagraphTitle(inline: MarkdownOutlineToken): string {
  const children = Array.isArray(inline.children) ? inline.children : [];
  if (children.length === 0) return "";

  let i = 0;
  while (i < children.length) {
    const token = children[i]!;
    if (token.type !== "text") break;
    const content = String(token.content ?? "");
    if (!content.trim()) {
      i += 1;
      continue;
    }
    break;
  }

  if (i >= children.length || children[i]!.type !== "strong_open") return "";
  i += 1;

  const parts: string[] = [];
  let closed = false;
  for (; i < children.length; i++) {
    const token = children[i]!;
    if (token.type === "strong_close") {
      closed = true;
      i += 1;
      break;
    }
    if (token.type === "text" || token.type === "code_inline") {
      parts.push(String(token.content ?? ""));
      continue;
    }
    if (token.type === "softbreak" || token.type === "hardbreak") {
      parts.push(" ");
      continue;
    }
    return "";
  }

  if (!closed) return "";

  for (; i < children.length; i++) {
    const token = children[i]!;
    if (token.type !== "text") return "";
    const content = String(token.content ?? "");
    if (content.trim()) return "";
  }

  return parts.join("");
}

export function extractMarkdownOutlineTitles(
  markdown: string,
  opts?: {
    maxTitleLength?: number;
  },
): string[] {
  return analyzeMarkdownOutline(markdown, opts).titles;
}

export function analyzeMarkdownOutline(
  markdown: string,
  opts?: {
    maxTitleLength?: number;
  },
): { titles: string[]; hasMeaningfulBody: boolean } {
  const raw = String(markdown ?? "");
  if (!raw.trim()) return { titles: [], hasMeaningfulBody: false };

  const maxTitleLength = Math.max(8, Math.min(200, Number(opts?.maxTitleLength ?? 80)));

  let tokens: MarkdownOutlineToken[] = [];
  try {
    tokens = md.parse(raw, {}) as unknown as MarkdownOutlineToken[];
  } catch {
    return { titles: [], hasMeaningfulBody: false };
  }

  const titles: string[] = [];
  const seen = new Set<string>();
  let hasMeaningfulBody = false;

  function pushTitle(candidate: string): void {
    const normalized = normalizeOutlineTitle(candidate, maxTitleLength);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    titles.push(normalized);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.type === "heading_open") {
      const inline = tokens[i + 1];
      if (inline?.type === "inline") pushTitle(String(inline.content ?? ""));
      continue;
    }

    if (token.type === "paragraph_open") {
      const inline = tokens[i + 1];
      const close = tokens[i + 2];
      if (inline?.type !== "inline" || close?.type !== "paragraph_close") continue;

      const strongTitle = extractStrongOnlyParagraphTitle(inline);
      if (strongTitle) {
        pushTitle(strongTitle);
        continue;
      }

      if (String(inline.content ?? "").trim()) hasMeaningfulBody = true;
      continue;
    }

    if (
      token.type === "bullet_list_open" ||
      token.type === "ordered_list_open" ||
      token.type === "blockquote_open" ||
      token.type === "fence" ||
      token.type === "code_block" ||
      token.type === "table_open"
    ) {
      hasMeaningfulBody = true;
      continue;
    }
  }

  return { titles, hasMeaningfulBody };
}
