import MarkdownIt from "markdown-it";

import { applyFilePreviewAttrs, parseMarkdownFilePreviewHref } from "./filePreview";
import { hljs, normalizeLang } from "./highlight";
import { extractPatchFilePaths, formatCollapsedFileList, isPatchLike } from "./patch";

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

export const md = new MarkdownIt({
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

md.linkify.set({ fuzzyLink: false });
md.validateLink = (url) => isSafeUrl(url);

// Disable underscore-based emphasis so paths like __tests__ are not treated as bold.
const emphRule = md.inline.ruler.__rules__.find((r: { name: string }) => r.name === "emphasis");
if (emphRule) {
  const origEmph = emphRule.fn;
  emphRule.fn = function (state: { src: string; pos: number }, silent: boolean) {
    if (state.src.charCodeAt(state.pos) === 0x5f) return false;
    return origEmph.call(this, state, silent);
  };
}

const defaultLinkOpenRenderer =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = String(token.attrGet("href") ?? "");
  const preview = parseMarkdownFilePreviewHref(href);
  if (preview) {
    applyFilePreviewAttrs(token, preview);
  }
  return defaultLinkOpenRenderer(tokens, idx, options, env, self);
};

const defaultCodeInlineRenderer =
  md.renderer.rules.code_inline ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const content = String(token.content ?? "");
  const preview = parseMarkdownFilePreviewHref(content);
  if (!preview || !content.includes("/")) {
    return defaultCodeInlineRenderer(tokens, idx, options, env, self);
  }

  const rawHref = escapeAttr(content);
  const escapedContent = escapeHtml(content);
  const lineAttr = preview.line != null ? ` data-md-file-line="${escapeAttr(String(preview.line))}"` : "";
  return `<a href="${rawHref}" data-md-link-kind="file-preview" data-md-file-path="${escapeAttr(preview.path)}"${lineAttr}><code>${escapedContent}</code></a>`;
};

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
