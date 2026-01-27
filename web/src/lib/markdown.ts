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

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const rawInfo = String(token.info ?? "").trim();
  const lang = rawInfo ? rawInfo.split(/\s+/)[0] ?? "" : "";
  const normalizedLang = normalizeLang(lang);
  const highlighted = options.highlight ? options.highlight(token.content, normalizedLang, "") : escapeHtml(token.content);
  const langClass = normalizedLang ? ` language-${escapeAttr(normalizedLang)}` : "";
  const langAttr = normalizedLang ? ` data-lang="${escapeAttr(normalizedLang)}"` : "";

  return [
    `<div class="md-codeblock"${langAttr}>`,
    `<button class="md-codecopy" type="button" aria-label="Copy code" data-state="idle">` +
      `<svg class="md-icon copy" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">` +
        `<path fill-rule="evenodd" d="M6 2a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6.5a.75.75 0 0 0-.22-.53l-3.75-3.75A.75.75 0 0 0 11.5 2H6Zm6.5 1.56 2.94 2.94H13a.5.5 0 0 1-.5-.5V3.56Z" clip-rule="evenodd" />` +
        `<path d="M4 6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2H9a3 3 0 0 1-3-3V6H4Z" />` +
      `</svg>` +
      `<svg class="md-icon check" width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">` +
        `<path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z" clip-rule="evenodd" />` +
      `</svg>` +
    `</button>`,
    `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`,
    `</div>`,
  ].join("");
};

export function renderMarkdownToHtml(markdown: string): string {
  return md.render(String(markdown ?? ""));
}
