const TRANSLATION_HEADER_RE = /^\s*(idiomatic english|english translation)\s*[:：]/i;

function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function stripLeadingTranslation(text: string): string {
  const raw = String(text ?? "");
  if (!raw) {
    return "";
  }
  const newline = detectNewline(raw);
  const lines = raw.split(/\r?\n/);
  let idx = 0;

  while (idx < lines.length && lines[idx].trim() === "") {
    idx += 1;
  }

  if (idx >= lines.length) {
    return raw;
  }

  if (!TRANSLATION_HEADER_RE.test(lines[idx])) {
    return raw;
  }

  idx += 1;
  while (idx < lines.length && lines[idx].trim() === "") {
    idx += 1;
  }
  return lines.slice(idx).join(newline);
}

