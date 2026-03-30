import { hljs, normalizeLang } from "./markdown";

export type FilePreviewLine = {
  number: number;
  text: string;
  html: string | null;
};

type HtmlTagFrame = {
  name: string;
  openTag: string;
};

function normalizePreviewLanguage(rawLang: string | null | undefined): string {
  const normalized = normalizeLang(String(rawLang ?? ""));
  if (normalized === "html" || normalized === "vue") return "xml";
  return normalized;
}

function parseOpeningTag(tag: string): HtmlTagFrame | null {
  if (!/^<[A-Za-z][^>]*>$/.test(tag)) return null;
  if (tag.endsWith("/>")) return null;
  const name = /^<([A-Za-z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase();
  if (!name) return null;
  return { name, openTag: tag };
}

function parseClosingTag(tag: string): string | null {
  return /^<\/([A-Za-z][^\s/>]*)>$/.exec(tag)?.[1]?.toLowerCase() ?? null;
}

function closeTags(stack: HtmlTagFrame[]): string {
  return stack
    .slice()
    .reverse()
    .map((frame) => `</${frame.name}>`)
    .join("");
}

function reopenTags(stack: HtmlTagFrame[]): string {
  return stack.map((frame) => frame.openTag).join("");
}

export function splitHighlightedHtmlLines(html: string): string[] {
  const src = String(html ?? "");
  const lines: string[] = [];
  const openTags: HtmlTagFrame[] = [];
  let current = "";

  for (let idx = 0; idx < src.length; ) {
    const ch = src[idx];
    if (ch === "<") {
      const end = src.indexOf(">", idx);
      if (end < 0) {
        current += src.slice(idx);
        break;
      }

      const tag = src.slice(idx, end + 1);
      current += tag;

      const opening = parseOpeningTag(tag);
      if (opening) {
        openTags.push(opening);
      } else {
        const closingName = parseClosingTag(tag);
        if (closingName) {
          for (let stackIdx = openTags.length - 1; stackIdx >= 0; stackIdx -= 1) {
            if (openTags[stackIdx]?.name === closingName) {
              openTags.splice(stackIdx, 1);
              break;
            }
          }
        }
      }

      idx = end + 1;
      continue;
    }

    if (ch === "\n") {
      lines.push(current + closeTags(openTags));
      current = reopenTags(openTags);
      idx += 1;
      continue;
    }

    current += ch;
    idx += 1;
  }

  lines.push(current + closeTags(openTags));
  return lines;
}

export function buildFilePreviewLines(args: {
  content: string;
  startLine: number;
  language: string | null | undefined;
}): FilePreviewLine[] {
  const content = String(args.content ?? "");
  if (!content) return [];

  const rawLines = content.split("\n");
  const language = normalizePreviewLanguage(args.language);
  let highlightedLines: string[] | null = null;

  if (language && hljs.getLanguage(language)) {
    try {
      const highlighted = hljs.highlight(content, { language, ignoreIllegals: true }).value;
      highlightedLines = splitHighlightedHtmlLines(highlighted);
    } catch {
      highlightedLines = null;
    }
  }

  return rawLines.map((text, idx) => ({
    number: args.startLine + idx,
    text,
    html: highlightedLines?.[idx] ?? null,
  }));
}
