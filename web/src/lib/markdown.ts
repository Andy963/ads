import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import ini from "highlight.js/lib/languages/ini";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function basenameLike(path: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : raw;
}

function extractPatchFilePaths(text: string): string[] {
  const raw = String(text ?? "");
  if (!raw) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const lines = raw.split("\n");

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;

    let path: string | null = null;

    // Unified diff headers: prefer the b/ path.
    const diffGit = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (diffGit) {
      path = diffGit[2] ?? diffGit[1] ?? null;
    }

    // Unified diff file markers.
    if (!path) {
      const plus = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(line);
      if (plus) {
        const candidate = String(plus[1] ?? "").trim();
        if (candidate && candidate !== "/dev/null") path = candidate;
      }
    }
    if (!path) {
      const minus = /^---\s+(?:a\/)?(.+)$/.exec(line);
      if (minus) {
        const candidate = String(minus[1] ?? "").trim();
        if (candidate && candidate !== "/dev/null") path = candidate;
      }
    }

    // Codex apply_patch style.
    if (!path) {
      const m =
        /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/.exec(line) ??
        /^\*\*\*\s+Move to:\s+(.+)$/.exec(line);
      if (m) path = m[1] ?? null;
    }

    if (!path) continue;

    const normalized = String(path).trim().replace(/^["']/, "").replace(/["']$/, "");
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function isPatchLike(text: string): boolean {
  const raw = String(text ?? "");
  if (!raw) return false;
  if (raw.includes("*** Begin Patch")) return true;
  if (/^diff --git /m.test(raw)) return true;
  if (/^\+\+\+ /m.test(raw) && /^--- /m.test(raw)) return true;
  return false;
}

function formatCollapsedFileList(paths: string[], maxItems: number): { summary: string; hiddenCount: number } {
  const basenames = paths.map((p) => basenameLike(p)).filter(Boolean);
  const shown = basenames.slice(0, Math.max(0, maxItems));
  const hiddenCount = Math.max(0, basenames.length - shown.length);
  const summary = shown.join(", ");
  return { summary, hiddenCount };
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("/")) return true;
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:")
  );
}

function normalizeLang(lang: string): string {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "shell") return "bash";
  if (normalized === "sh") return "bash";
  if (normalized === "ts") return "typescript";
  if (normalized === "js") return "javascript";
  if (normalized === "yml") return "yaml";
  if (normalized === "toml") return "ini";
  return normalized;
}

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (code, lang) => {
    const normalized = normalizeLang(lang || "");
    if (normalized && hljs.getLanguage(normalized)) {
      try {
        return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
      } catch {
        // fallback below
      }
    }
    try {
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  },
});

md.validateLink = (url) => isSafeUrl(url);

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

md.inline.ruler.before("text", "diffstat", (state, silent) => {
  const pos = state.pos;
  const src = state.src;
  if (pos >= src.length) return false;

  const match = /^[\t ]*\(\+(\d+)\s+-(\d+)\)/.exec(src.slice(pos));
  if (!match) return false;
  if (silent) return true;

  const prefix = /^[\t ]*/.exec(match[0])?.[0] ?? "";
  if (prefix) {
    const text = state.push("text", "", 0);
    text.content = prefix;
  }

  const token = state.push("diffstat", "", 0);
  token.meta = { added: match[1], removed: match[2] };
  state.pos += match[0].length;
  return true;
});

md.renderer.rules.diffstat = (tokens, idx) => {
  const meta = (tokens[idx]?.meta ?? {}) as { added?: unknown; removed?: unknown };
  const rawAdded = String(meta.added ?? "").trim();
  const rawRemoved = String(meta.removed ?? "").trim();
  const added = /^\d+$/.test(rawAdded) ? rawAdded : "0";
  const removed = /^\d+$/.test(rawRemoved) ? rawRemoved : "0";

  return `<span class="md-diffstat">(<span class="md-diffstat-add">+${added}</span> <span class="md-diffstat-del">-${removed}</span>)</span>`;
};

md.renderer.rules.fence = (tokens, idx, options, _env, _self) => {
  const token = tokens[idx];
  const rawInfo = String(token.info ?? "").trim();
  const lang = rawInfo ? rawInfo.split(/\s+/)[0] ?? "" : "";
  const normalizedLang = normalizeLang(lang);
  const highlighted = options.highlight ? options.highlight(token.content, normalizedLang, "") : escapeHtml(token.content);
  const langClass = normalizedLang ? ` language-${escapeAttr(normalizedLang)}` : "";
  const langAttr = normalizedLang ? ` data-lang="${escapeAttr(normalizedLang)}"` : "";

  const isDiffLang = normalizedLang === "diff";
  const isLikelyPatch = isDiffLang || isPatchLike(token.content);
  const patchPaths = isLikelyPatch ? extractPatchFilePaths(token.content) : [];
  const canCollapse = isLikelyPatch;
  const lineCount = token.content.split("\n").length;

  const bodyHtml = [
    `<div class="md-codeblock-body">`,
    `<button class="md-codecopy" type="button" aria-label="Copy code" data-state="idle">` +
      `<svg class="md-icon copy" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<rect x="9" y="9" width="13" height="13" rx="2" />` +
        `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />` +
      `</svg>` +
      `<svg class="md-icon check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M20 6L9 17l-5-5" />` +
      `</svg>` +
    `</button>`,
    `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`,
    `</div>`,
  ].join("");

  if (canCollapse) {
    const { summary, hiddenCount } = formatCollapsedFileList(patchPaths, 6);
    const label = isDiffLang ? "Diff" : "Patch";
    const filesText = summary
      ? summary + (hiddenCount ? ` (+${hiddenCount} more)` : "")
      : patchPaths.length
        ? `${patchPaths.length} files`
        : `${lineCount} lines`;
    return [
      `<details class="md-codeblock md-collapsible"${langAttr} data-kind="patch">`,
      `<summary class="md-collapsible-summary">` +
        `<span class="md-collapsible-title">${escapeHtml(label)}</span>` +
        `<span class="md-collapsible-files">${escapeHtml(filesText)}</span>` +
        `<span class="md-collapsible-hint" aria-hidden="true" data-closed="Expand" data-open="Collapse"></span>` +
      `</summary>`,
      bodyHtml,
      `</details>`,
    ].join("");
  }

  return [`<div class="md-codeblock"${langAttr}>`, bodyHtml, `</div>`].join("");
};

export function renderMarkdownToHtml(markdown: string): string {
  return md.render(String(markdown ?? ""));
}

export function extractMarkdownOutlineTitles(
  markdown: string,
  opts?: {
    maxTitleLength?: number;
  },
): string[] {
  const raw = String(markdown ?? "");
  if (!raw.trim()) return [];

  const maxTitleLength = Math.max(8, Math.min(200, Number(opts?.maxTitleLength ?? 80)));

  let tokens: MarkdownOutlineToken[] = [];
  try {
    tokens = md.parse(raw, {}) as unknown as MarkdownOutlineToken[];
  } catch {
    return [];
  }

  const titles: string[] = [];
  const seen = new Set<string>();

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
      if (strongTitle) pushTitle(strongTitle);
      continue;
    }
  }

  return titles;
}
