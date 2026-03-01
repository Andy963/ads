import telegramifyMarkdown from "telegramify-markdown";

type UnsupportedTagsStrategy = "escape" | "remove" | "keep";

const DEFAULT_STRATEGY: UnsupportedTagsStrategy = "escape";

type CodeFenceBlock = {
  placeholder: string;
  indent: string;
  lang: string;
  code: string;
  hint: string;
};

/**
 * Convert Markdown into Telegram-safe MarkdownV2 using telegramify-markdown.
 * Defaults to escaping unsupported tags to avoid parse errors.
 */
export function escapeTelegramMarkdown(text: string): string {
  return toTelegramMarkdown(text);
}

/**
 * Alias for Telegram MarkdownV2 escaping.
 */
export function escapeTelegramMarkdownV2(text: string): string {
  return toTelegramMarkdown(text);
}

function toTelegramMarkdown(
  text: string,
  strategy: UnsupportedTagsStrategy = DEFAULT_STRATEGY,
): string {
  if (!text) {
    return "";
  }
  const telegramMarkdown = telegramifyMarkdownPreservingCodeFences(text, strategy);
  return sanitizeTelegramMarkdownV2(telegramMarkdown);
}

function sanitizeTelegramMarkdownV2(text: string): string {
  if (!text) {
    return "";
  }

  const lines = text.split("\n");
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && /^\s*\*{3,}\s*$/.test(line)) {
      lines[index] = "────────";
    }
  }

  return lines.join("\n");
}

function telegramifyMarkdownPreservingCodeFences(
  text: string,
  strategy: UnsupportedTagsStrategy,
): string {
  const extracted = extractFencedCodeBlocks(text);
  const telegramified = telegramifyMarkdown(extracted.text, strategy);

  let out = telegramified;
  for (const block of extracted.blocks) {
    out = out.replaceAll(block.placeholder, renderCodeFenceBlock(block));
  }
  return out;
}

function extractFencedCodeBlocks(text: string): { text: string; blocks: CodeFenceBlock[] } {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const blocks: CodeFenceBlock[] = [];
  const outLines: string[] = [];

  const placeholderPrefix = `CODEBLOCKPLACEHOLDER${Date.now().toString(36)}${Math.random().toString(36).slice(2)}X`;

  let inFence = false;
  let fenceIndent = "";
  let fenceLang = "";
  let fenceHint = "";
  let fenceLines: string[] = [];
  let lastNonEmptyLine = "";

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceIndent = line.slice(0, line.length - trimmed.length);
        const info = trimmed.slice(3).trim();
        fenceLang = info ? (info.split(/\s+/)[0] ?? "") : "";
        fenceHint = lastNonEmptyLine;
        fenceLines = [];
      } else {
        const placeholder = `${placeholderPrefix}${blocks.length}`;
        blocks.push({
          placeholder,
          indent: fenceIndent,
          lang: fenceLang,
          code: fenceLines.join("\n"),
          hint: fenceHint,
        });
        outLines.push(`${fenceIndent}${placeholder}`);
        inFence = false;
        fenceIndent = "";
        fenceLang = "";
        fenceHint = "";
        fenceLines = [];
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    outLines.push(line);
    if (trimmed.length > 0) {
      lastNonEmptyLine = line;
    }
  }

  if (inFence) {
    const placeholder = `${placeholderPrefix}${blocks.length}`;
    blocks.push({
      placeholder,
      indent: fenceIndent,
      lang: fenceLang,
      code: fenceLines.join("\n"),
      hint: fenceHint,
    });
    outLines.push(`${fenceIndent}${placeholder}`);
  }

  return { text: outLines.join("\n"), blocks };
}

function normalizeFenceLanguage(lang: string): string {
  const normalized = String(lang ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "shell") return "bash";
  if (normalized === "sh") return "bash";
  if (normalized === "golang") return "go";
  if (normalized === "js") return "javascript";
  if (normalized === "ts") return "typescript";
  if (normalized === "yml") return "yaml";
  return normalized.replace(/[^a-z0-9_+#-]/g, "");
}

function inferFenceLanguage(code: string, hint: string): string {
  const rawHint = String(hint ?? "");
  const hintMatch = rawHint.match(/\b[\w./-]+\.(go|rs|py|ts|js|json|ya?ml|toml|sh|bash|diff|patch)\b/i);
  if (hintMatch) {
    const ext = String(hintMatch[1] ?? "").toLowerCase();
    if (ext === "go") return "go";
    if (ext === "rs") return "rust";
    if (ext === "py") return "python";
    if (ext === "ts") return "typescript";
    if (ext === "js") return "javascript";
    if (ext === "json") return "json";
    if (ext === "yaml" || ext === "yml") return "yaml";
    if (ext === "toml") return "toml";
    if (ext === "sh" || ext === "bash") return "bash";
    if (ext === "diff" || ext === "patch") return "diff";
  }

  const sample = String(code ?? "").trimStart();
  if (!sample) return "";

  if (/^(diff --git |---\s|\+\+\+\s|@@\s)/m.test(sample)) return "diff";
  if (/^#!/.test(sample) || /(^|\n)\s*(?:\$ )?(?:go|git|npm|pnpm|yarn|cargo|rustup|make|cmake|docker|kubectl)\b/.test(sample)) {
    return "bash";
  }
  if (/^package\s+\w+/m.test(sample) || /(^|\n)\s*func\s+\w+/m.test(sample)) return "go";
  if (/(^|\n)\s*fn\s+main\s*\(/m.test(sample) || /(^|\n)\s*use\s+\w+::/m.test(sample)) return "rust";
  if (/(^|\n)\s*def\s+\w+\s*\(/m.test(sample) || /(^|\n)\s*class\s+\w+/.test(sample)) return "python";
  if (/^\s*[{[]/.test(sample)) {
    try {
      JSON.parse(sample);
      return "json";
    } catch {
      // ignore
    }
  }
  if (/(^|\n)\s*(?:import|export)\b/.test(sample) || /(^|\n)\s*console\.\w+\(/.test(sample)) {
    if (/(^|\n)\s*(?:interface|type)\s+\w+/.test(sample) || /:\s*(?:string|number|boolean)\b/.test(sample)) return "typescript";
    return "javascript";
  }
  if (/(^|\n)\s*[\w-]+:\s+\S+/.test(sample) && !/(^|\n)\s*(?:package|import|func|fn|def)\b/.test(sample)) return "yaml";

  return "";
}

function escapeTelegramPreformattedCode(text: string): string {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`");
}

function renderCodeFenceBlock(block: CodeFenceBlock): string {
  const normalizedLang = normalizeFenceLanguage(block.lang);
  const lang = normalizedLang || inferFenceLanguage(block.code, block.hint);
  const fenceStart = `${block.indent}\`\`\`${lang}`.trimEnd();
  const fenceEnd = `${block.indent}\`\`\``;

  const escaped = escapeTelegramPreformattedCode(block.code);
  const indentedCode = escaped
    .split("\n")
    .map((line) => `${block.indent}${line}`)
    .join("\n");

  return `${fenceStart}\n${indentedCode}\n${fenceEnd}`;
}

/**
 * Escape inline code content (used inside single backticks).
 */
export function escapeTelegramInlineCode(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/([`\\])/g, "\\$1");
}

/**
 * Escape italic content (used inside underscores).
 */
export function escapeTelegramItalic(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/([_\\])/g, "\\$1");
}
