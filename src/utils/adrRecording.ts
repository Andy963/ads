import fs from "node:fs";
import path from "node:path";

export interface AdrRecord {
  title?: string;
  status?: string;
  date?: string;
  body?: string;
  context?: string;
  decision?: string;
  consequences?: string | string[];
  alternatives?: string | string[];
  references?: string | string[];
}

export interface AdrWriteResult {
  relativePath: string;
  absolutePath: string;
  number: string;
  title: string;
}

export interface AdrProcessingResult {
  cleanedText: string;
  results: AdrWriteResult[];
  warnings: string[];
  finalText: string;
}

interface ExtractedAdrBlock {
  raw: string;
  jsonText: string;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function takeFirstNonEmptyLine(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    return line;
  }
  return null;
}

function inferTitle(record: AdrRecord): string {
  const explicit = typeof record.title === "string" ? record.title.trim() : "";
  if (explicit) {
    return explicit.slice(0, 60);
  }

  if (typeof record.body === "string" && record.body.trim()) {
    const body = record.body;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        const stripped = line.replace(/^#+\s*/, "").trim();
        if (stripped) {
          return stripped.slice(0, 60);
        }
      }
      return line.slice(0, 60);
    }
  }

  if (typeof record.decision === "string" && record.decision.trim()) {
    return record.decision.trim().slice(0, 60);
  }

  return "Untitled ADR";
}

function slugifyTitle(title: string): string {
  const normalized = title.trim().toLowerCase();
  const dashed = normalized.replace(/\s+/g, "-");
  const cleaned = dashed
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = cleaned.slice(0, 60);
  return slug || "untitled";
}

function extractAdrBlocks(text: string): { blocks: ExtractedAdrBlock[]; cleanedText: string } {
  const blocks: ExtractedAdrBlock[] = [];
  const regex = /<<<adr[ \t]*\r?\n([\s\S]*?)\r?\n>>>/g;

  let cursor = 0;
  let cleaned = "";
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    cleaned += text.slice(cursor, match.index);
    cursor = regex.lastIndex;
    blocks.push({ raw: match[0], jsonText: match[1] });
  }
  cleaned += text.slice(cursor);

  return { blocks, cleanedText: cleaned };
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function listAdrMarkdownFiles(adrDir: string): string[] {
  if (!fs.existsSync(adrDir)) {
    return [];
  }
  return fs
    .readdirSync(adrDir)
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md");
}

function nextAdrNumber(adrDir: string): number {
  let max = 0;
  for (const file of listAdrMarkdownFiles(adrDir)) {
    const match = file.match(/^(\d{4})-/);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) {
      max = Math.max(max, n);
    }
  }
  return max + 1;
}

function renderAdrMarkdown(number: string, record: AdrRecord, title: string): string {
  const status = (typeof record.status === "string" && record.status.trim()) ? record.status.trim() : "Accepted";
  const date = (typeof record.date === "string" && record.date.trim()) ? record.date.trim() : formatIsoDate(new Date());

  const lines: string[] = [];
  lines.push(`# ADR-${number}: ${title}`);
  lines.push("");
  lines.push(`- Status: ${status}`);
  lines.push(`- Date: ${date}`);
  lines.push("");

  if (typeof record.body === "string" && record.body.trim()) {
    lines.push(record.body.trimEnd());
    lines.push("");
    return lines.join("\n");
  }

  const pushSection = (heading: string, content: string | string[] | undefined) => {
    if (content === undefined) return;
    if (Array.isArray(content)) {
      const items = content.map((entry) => String(entry).trim()).filter(Boolean);
      if (items.length === 0) return;
      lines.push(`## ${heading}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push("");
      return;
    }
    const text = String(content).trim();
    if (!text) return;
    lines.push(`## ${heading}`);
    lines.push(text);
    lines.push("");
  };

  pushSection("Context", record.context);
  pushSection("Decision", record.decision);
  pushSection("Consequences", record.consequences);
  pushSection("Alternatives", record.alternatives);
  pushSection("References", record.references);

  return lines.join("\n");
}

function parseAdrRecord(jsonText: string): AdrRecord {
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as AdrRecord;
}

function extractTitleFromFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const headingLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("# "));

    if (!headingLine) {
      return path.basename(filePath);
    }

    const heading = headingLine.slice(2).trim();
    const cleaned = heading
      .replace(/^ADR-\d{4}\s*[:：.\-]\s*/i, "")
      .replace(/^\d{4}\s*[:：.\-]\s*/, "")
      .replace(/^\d{4}\.\s*/, "")
      .trim();
    return cleaned || heading;
  } catch {
    return path.basename(filePath);
  }
}

function buildAdrIndexLines(adrDir: string): string[] {
  const entries = listAdrMarkdownFiles(adrDir)
    .map((file) => {
      const match = file.match(/^(\d{4})-/);
      const number = match ? match[1] : "????";
      const absolutePath = path.join(adrDir, file);
      const title = extractTitleFromFile(absolutePath);
      return { number, file, title };
    })
    .sort((a, b) => {
      const an = a.number === "????" ? Number.POSITIVE_INFINITY : Number.parseInt(a.number, 10);
      const bn = b.number === "????" ? Number.POSITIVE_INFINITY : Number.parseInt(b.number, 10);
      if (an !== bn) return an - bn;
      return a.file.localeCompare(b.file);
    });

  return entries.map((entry) => `- ${entry.number} - [${entry.title}](${entry.file})`);
}

function updateAdrReadme(adrDir: string): void {
  const readmePath = path.join(adrDir, "README.md");
  const startMarker = "<!-- ADS:ADR_INDEX_START -->";
  const endMarker = "<!-- ADS:ADR_INDEX_END -->";

  const indexLines = buildAdrIndexLines(adrDir);
  const generated = [startMarker, ...indexLines, endMarker].join("\n");

  if (!fs.existsSync(readmePath)) {
    const initial = [
      "# ADR Index",
      "",
      "This file is maintained by ADS. Edit outside the marked block if needed.",
      "",
      generated,
      "",
    ].join("\n");
    fs.writeFileSync(readmePath, initial, "utf8");
    return;
  }

  const content = fs.readFileSync(readmePath, "utf8");
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    const merged = `${content.trimEnd()}\n\n${generated}\n`;
    fs.writeFileSync(readmePath, merged, "utf8");
    return;
  }

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + endMarker.length).trimStart();
  const merged = `${before}\n\n${generated}\n\n${after}`.trimEnd() + "\n";
  fs.writeFileSync(readmePath, merged, "utf8");
}

function buildNotice(results: AdrWriteResult[], warnings: string[]): string {
  const lines: string[] = [];
  if (results.length > 0) {
    for (const result of results) {
      lines.push(`ADR recorded: ${result.relativePath}`);
    }
  }
  if (warnings.length > 0) {
    for (const warning of warnings) {
      lines.push(`ADR warning: ${warning}`);
    }
  }
  if (lines.length === 0) {
    return "";
  }
  return `\n\n---\n${lines.join("\n")}`;
}

export function processAdrBlocks(text: string, workspaceRoot: string): AdrProcessingResult {
  const resolvedRoot = path.resolve(workspaceRoot);
  const { blocks, cleanedText } = extractAdrBlocks(text);
  if (blocks.length === 0) {
    return { cleanedText, results: [], warnings: [], finalText: cleanedText };
  }

  const warnings: string[] = [];
  const records: AdrRecord[] = [];
  for (const block of blocks) {
    try {
      records.push(parseAdrRecord(block.jsonText));
    } catch (error) {
      const preview = takeFirstNonEmptyLine(block.jsonText)?.slice(0, 60) ?? "";
      warnings.push(`invalid JSON in ADR block${preview ? ` (starts with: ${preview})` : ""}`);
    }
  }

  if (records.length === 0) {
    const finalText = cleanedText + buildNotice([], warnings);
    return { cleanedText, results: [], warnings, finalText };
  }

  const adrDir = path.resolve(resolvedRoot, "docs", "adr");
  if (!adrDir.startsWith(resolvedRoot + path.sep) && adrDir !== resolvedRoot) {
    const finalText = cleanedText + buildNotice([], ["workspace root invalid for ADR recording"]);
    return { cleanedText, results: [], warnings: ["workspace root invalid for ADR recording"], finalText };
  }

  try {
    ensureDir(adrDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`failed to create docs/adr directory: ${message}`);
    const finalText = cleanedText + buildNotice([], warnings);
    return { cleanedText, results: [], warnings, finalText };
  }

  let counter = nextAdrNumber(adrDir);
  const results: AdrWriteResult[] = [];

  for (const record of records) {
    const title = inferTitle(record);
    const slug = slugifyTitle(title);

    while (true) {
      const number = String(counter).padStart(4, "0");
      const fileName = `${number}-${slug}.md`;
      const absolutePath = path.join(adrDir, fileName);
      if (fs.existsSync(absolutePath)) {
        counter += 1;
        continue;
      }
      const markdown = renderAdrMarkdown(number, record, title);
      try {
        fs.writeFileSync(absolutePath, markdown, { encoding: "utf8", flag: "wx" });
        results.push({
          relativePath: path.join("docs", "adr", fileName),
          absolutePath,
          number,
          title,
        });
        counter += 1;
        break;
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "EEXIST") {
          counter += 1;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`failed to write ADR ${fileName}: ${message}`);
        counter += 1;
        break;
      }
    }
  }

  try {
    updateAdrReadme(adrDir);
  } catch (error) {
    warnings.push(`failed to update docs/adr/README.md: ${(error as Error).message}`);
  }

  const finalText = cleanedText + buildNotice(results, warnings);
  return { cleanedText, results, warnings, finalText };
}
