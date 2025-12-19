import type {
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  WebSearchItem,
} from "@openai/codex-sdk";

export type ExploredCategory =
  | "List"
  | "Search"
  | "Read"
  | "Write"
  | "Execute"
  | "Tool"
  | "WebSearch";

export type ExploredSource = "codex_event" | "tool_hook";

export interface ExploredEntry {
  category: ExploredCategory;
  summary: string;
  ts: number;
  source: ExploredSource;
  meta?: {
    command?: string;
    tool?: string;
  };
}

export interface ExploredConfig {
  enabled: boolean;
  maxItems: number;
  dedupe: "none" | "consecutive";
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  return defaultValue;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function resolveExploredConfig(): ExploredConfig {
  const enabled = parseBoolean(process.env.ADS_EXPLORED_ENABLED, true);
  const maxItems = parsePositiveInt(process.env.ADS_EXPLORED_MAX_ITEMS, 30);
  const dedupeRaw = (process.env.ADS_EXPLORED_DEDUPE ?? "none").trim().toLowerCase();
  const dedupe = dedupeRaw === "none" ? "none" : "consecutive";
  return { enabled, maxItems, dedupe };
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeFirstLine(text: string): string {
  return (text ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLen - 1))}…`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function displayPath(value: string): string {
  const unquoted = unquote(value);
  const trimmed = unquoted.replace(/[\\/]+$/g, "");
  if (!trimmed) {
    return unquoted;
  }
  if (trimmed === "." || trimmed === "..") {
    return trimmed;
  }
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return trimmed;
  }
  const keep = Math.min(2, parts.length);
  return parts.slice(parts.length - keep).join("/");
}

function startsWithCommand(commandLine: string, name: string): boolean {
  const trimmed = commandLine.trimStart();
  return trimmed === name || trimmed.startsWith(`${name} `);
}

function splitShellTokens(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (const ch of commandLine.trim()) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function categorizeCommand(commandLine: string): ExploredCategory {
  const trimmed = normalizeFirstLine(commandLine);
  if (!trimmed) {
    return "Execute";
  }

  if (startsWithCommand(trimmed, "rg") && /\s--files(\s|$)/.test(trimmed)) {
    return "List";
  }

  if (startsWithCommand(trimmed, "git") && /\bgit\s+grep\b/.test(trimmed)) {
    return "Search";
  }

  if (startsWithCommand(trimmed, "find")) {
    if (/\s-(i?name|path|regex)\s/.test(trimmed)) {
      return "Search";
    }
    return "List";
  }

  const cmd = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (["ls", "dir", "tree", "fd"].includes(cmd)) {
    return "List";
  }
  if (["rg", "grep", "ag", "ack"].includes(cmd)) {
    return "Search";
  }
  if (["cat", "head", "tail", "less", "more", "bat", "sed", "nl"].includes(cmd)) {
    return "Read";
  }
  if (["echo", "tee", "cp", "mv", "mkdir", "touch", "rm"].includes(cmd)) {
    return "Write";
  }
  return "Execute";
}

function summarizeFind(commandLine: string): string | null {
  const tokens = splitShellTokens(commandLine);
  if (tokens[0] !== "find") {
    return null;
  }
  const baseDir = displayPath(tokens[1] ?? "");
  const nameIndex = tokens.findIndex((token) => token === "-name" || token === "-iname");
  if (nameIndex < 0 || nameIndex + 1 >= tokens.length) {
    return null;
  }
  const name = displayPath(tokens[nameIndex + 1] ?? "");
  if (!name) {
    return null;
  }
  if (baseDir) {
    return `${name} in ${baseDir}`;
  }
  return name;
}

function summarizeRg(commandLine: string): string | null {
  if (!startsWithCommand(commandLine, "rg")) {
    return null;
  }

  const tokens = splitShellTokens(commandLine);
  if (tokens.length < 2 || tokens[0] !== "rg") {
    return null;
  }

  // Best-effort: first token after options that doesn't look like a flag.
  const patternIndex = tokens.findIndex((token, idx) => idx > 0 && !token.startsWith("-"));
  if (patternIndex < 0) {
    return null;
  }
  const pattern = tokens[patternIndex] ?? "";
  const pathTokens = tokens.slice(patternIndex + 1).filter((t) => !t.startsWith("-"));
  if (pathTokens.length === 0) {
    return pattern;
  }
  const shown = pathTokens.slice(0, 2).map(displayPath).filter(Boolean).join(", ");
  const suffix = pathTokens.length > 2 ? ", …" : "";
  return `${pattern} in ${shown}${suffix}`;
}

function summarizeGrep(commandLine: string): string | null {
  const trimmed = commandLine.trimStart();
  if (!(trimmed.startsWith("grep ") || trimmed === "grep")) {
    return null;
  }

  const tokens = splitShellTokens(commandLine);
  if (tokens.length < 2 || tokens[0] !== "grep") {
    return null;
  }

  const patternIndex = tokens.findIndex((token, idx) => idx > 0 && !token.startsWith("-"));
  if (patternIndex < 0) {
    return null;
  }
  const pattern = tokens[patternIndex] ?? "";
  const pathTokens = tokens.slice(patternIndex + 1).filter((t) => !t.startsWith("-"));
  if (pathTokens.length === 0) {
    return pattern;
  }
  const shown = pathTokens.slice(0, 2).map(displayPath).filter(Boolean).join(", ");
  const suffix = pathTokens.length > 2 ? ", …" : "";
  return `${pattern} in ${shown}${suffix}`;
}

function summarizeCatLike(commandLine: string): string | null {
  const tokens = splitShellTokens(commandLine);
  const cmd = tokens[0] ?? "";
  if (!["cat", "head", "tail", "nl", "bat"].includes(cmd)) {
    return null;
  }
  const file = tokens.find((token, idx) => idx > 0 && !token.startsWith("-"));
  if (!file) {
    return null;
  }
  return displayPath(file);
}

function summarizeSed(commandLine: string): string | null {
  const tokens = splitShellTokens(commandLine);
  if (tokens[0] !== "sed") {
    return null;
  }
  const file = [...tokens].reverse().find((token) => token && !token.startsWith("-"));
  if (!file || file === "sed") {
    return null;
  }
  return displayPath(file);
}

function summarizeLs(commandLine: string): string | null {
  const tokens = splitShellTokens(commandLine);
  if (tokens[0] !== "ls") {
    return null;
  }
  if (tokens.length <= 1) {
    return "ls";
  }
  const paths = tokens.slice(1).filter((token) => !token.startsWith("-"));
  if (paths.length === 0) {
    return truncate(commandLine.trim(), 80);
  }
  const shown = paths.slice(0, 2).map(displayPath).filter(Boolean).join(", ");
  const suffix = paths.length > 2 ? ", …" : "";
  return `${shown}${suffix}`;
}

function summarizeCommand(commandLine: string, category: ExploredCategory): string {
  const normalized = normalizeFirstLine(commandLine);
  if (!normalized) {
    return "(empty)";
  }

  if (category === "List") {
    return summarizeLs(normalized) ?? truncate(normalized, 96);
  }

  if (category === "Read") {
    return (
      summarizeCatLike(normalized) ??
      summarizeSed(normalized) ??
      truncate(normalized, 96)
    );
  }

  if (category === "Search") {
    return (
      summarizeRg(normalized) ??
      summarizeGrep(normalized) ??
      summarizeFind(normalized) ??
      truncate(normalized, 120)
    );
  }

  return truncate(normalized, 96);
}

function extractDiffPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const lines = (patchText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      const candidate = diffMatch[2];
      if (candidate && candidate !== "dev/null") {
        paths.add(candidate);
      }
      continue;
    }
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
      const candidate = plusMatch[1];
      if (candidate && candidate !== "dev/null") {
        paths.add(candidate);
      }
      continue;
    }
  }
  return Array.from(paths);
}

function compactExploredEntries(entries: ExploredEntry[], dedupe: ExploredConfig["dedupe"]): ExploredEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const out: ExploredEntry[] = [];
  const maxMergedReadParts = 4;

  const flushCountSuffix = (entry: ExploredEntry, count: number) => {
    if (count <= 1) {
      out.push(entry);
      return;
    }
    out.push({
      ...entry,
      summary: `${entry.summary} (x${count})`,
    });
  };

  let pending: ExploredEntry | null = null;
  let pendingCount = 0;
  let pendingReadParts: string[] | null = null;
  let pendingReadOmitted = 0;

  const flushPending = () => {
    if (!pending) {
      return;
    }
    if (pendingReadParts && pending.category === "Read" && pendingCount === 1) {
      const shown = pendingReadParts.slice(0, maxMergedReadParts);
      let summary = shown.join(", ");
      if (pendingReadOmitted > 0) {
        summary = `${summary}, … (+${pendingReadOmitted} more)`;
      }
      pending = { ...pending, summary: truncate(summary, 200) };
    }
    flushCountSuffix(pending, pendingCount);
    pending = null;
    pendingCount = 0;
    pendingReadParts = null;
    pendingReadOmitted = 0;
  };

  for (const entry of entries) {
    if (!pending) {
      pending = entry;
      pendingCount = 1;
      pendingReadParts = entry.category === "Read" ? [entry.summary] : null;
      continue;
    }

    if (dedupe === "consecutive" && pending.category === entry.category && pending.summary === entry.summary) {
      pendingCount += 1;
      continue;
    }

    // Merge consecutive reads into a single "Read a, b, c" entry.
    if (pending.category === "Read" && entry.category === "Read" && pendingCount === 1) {
      if (!pendingReadParts) {
        pendingReadParts = [pending.summary];
      }
      if (pendingReadParts.length < maxMergedReadParts) {
        pendingReadParts.push(entry.summary);
      } else {
        pendingReadOmitted += 1;
      }
      const shown = pendingReadParts.slice(0, maxMergedReadParts);
      let summary = shown.join(", ");
      if (pendingReadOmitted > 0) {
        summary = `${summary}, … (+${pendingReadOmitted} more)`;
      }
      pending = { ...pending, summary: truncate(summary, 200) };
      pendingCount = 1;
      continue;
    }

    flushPending();
    pending = entry;
    pendingCount = 1;
    pendingReadParts = entry.category === "Read" ? [entry.summary] : null;
  }

  flushPending();
  return out;
}

export type ExploredEntryCallback = (entry: ExploredEntry) => void;

export class ActivityTracker {
  private readonly entries: ExploredEntry[] = [];
  private readonly seen = new Set<string>();
  private readonly onEntryCallback?: ExploredEntryCallback;

  constructor(onEntry?: ExploredEntryCallback) {
    this.onEntryCallback = onEntry;
  }

  ingestThreadEvent(event: ThreadEvent): void {
    if (!event || typeof event !== "object") {
      return;
    }
    if (event.type !== "item.started" && event.type !== "item.completed" && event.type !== "item.updated") {
      return;
    }

    const item = (event as { item?: { type?: string; id?: string } }).item;
    if (!item || typeof item !== "object") {
      return;
    }
    const itemType = item.type;
    if (typeof itemType !== "string") {
      return;
    }

    switch (itemType) {
      case "command_execution":
        this.ingestCommandExecution(item as CommandExecutionItem);
        break;
      case "file_change":
        this.ingestFileChange(item as FileChangeItem);
        break;
      case "mcp_tool_call":
        this.ingestMcpToolCall(item as McpToolCallItem);
        break;
      case "web_search":
        this.ingestWebSearch(item as WebSearchItem);
        break;
      default:
        break;
    }
  }

  ingestToolInvoke(tool: string, payload: string): void {
    const normalizedTool = String(tool ?? "").trim().toLowerCase();
    const trimmedPayload = String(payload ?? "").trim();
    if (!normalizedTool) {
      return;
    }

    if (normalizedTool === "read") {
      const parsed = safeJsonParse(trimmedPayload);
      const pathValue =
        parsed && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string"
          ? (parsed as { path: string }).path
          : trimmedPayload;
      this.add({
        category: "Read",
        summary: displayPath(pathValue),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "write") {
      const parsed = safeJsonParse(trimmedPayload);
      const pathValue =
        parsed && typeof parsed === "object" && typeof (parsed as { path?: unknown }).path === "string"
          ? (parsed as { path: string }).path
          : trimmedPayload;
      this.add({
        category: "Write",
        summary: displayPath(pathValue),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "apply_patch") {
      const paths = extractDiffPaths(trimmedPayload);
      const summary =
        paths.length === 0
          ? "apply_patch"
          : paths.length <= 3
            ? paths.map(displayPath).join(", ")
            : `${paths.slice(0, 2).map(displayPath).join(", ")}, … (${paths.length} files)`;
      this.add({
        category: "Write",
        summary,
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "search") {
      const parsed = safeJsonParse(trimmedPayload);
      const queryValue =
        typeof parsed === "string"
          ? parsed
          : parsed && typeof parsed === "object" && typeof (parsed as { query?: unknown }).query === "string"
            ? (parsed as { query: string }).query
            : trimmedPayload;
      this.add({
        category: "WebSearch",
        summary: truncate(String(queryValue ?? "").trim(), 140),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "exec") {
      const parsed = safeJsonParse(trimmedPayload);
      let commandLine = trimmedPayload;
      if (parsed && typeof parsed === "object") {
        const record = parsed as { cmd?: unknown; args?: unknown; argv?: unknown };
        if (typeof record.cmd === "string" && record.cmd.trim()) {
          const argsRaw = record.args ?? record.argv;
          const args = Array.isArray(argsRaw) ? argsRaw.map((entry) => String(entry)) : [];
          commandLine = [record.cmd, ...args].join(" ").trim();
        }
      }
      const category = categorizeCommand(commandLine);
      const summary = summarizeCommand(commandLine, category);
      this.add({
        category,
        summary,
        source: "tool_hook",
        meta: { tool: normalizedTool, command: commandLine },
      });
      return;
    }

    this.add({
      category: "Tool",
      summary: normalizedTool,
      source: "tool_hook",
      meta: { tool: normalizedTool },
    });
  }

  compact(config: Pick<ExploredConfig, "maxItems" | "dedupe">): ExploredEntry[] {
    const compacted = compactExploredEntries(this.entries, config.dedupe).slice(0, config.maxItems);
    return compacted.map((entry) => ({ ...entry }));
  }

  private ingestCommandExecution(item: CommandExecutionItem): void {
    const seenKey = `codex:command:${item.id}`;
    if (this.seen.has(seenKey)) {
      return;
    }
    this.seen.add(seenKey);

    const commandLine = normalizeFirstLine(item.command);
    const category = categorizeCommand(commandLine);
    const summary = summarizeCommand(commandLine, category);
    this.add({
      category,
      summary,
      source: "codex_event",
      meta: { command: commandLine },
    });
  }

  private ingestFileChange(item: FileChangeItem): void {
    const seenKey = `codex:file_change:${item.id}`;
    if (this.seen.has(seenKey)) {
      return;
    }
    this.seen.add(seenKey);

    if (Array.isArray(item.changes) && item.changes.length > 0) {
      const summary =
        item.changes.length <= 3
          ? item.changes.map((change) => displayPath(change.path)).join(", ")
          : `${item.changes.slice(0, 2).map((change) => displayPath(change.path)).join(", ")}, … (${item.changes.length} files)`;
      this.add({
        category: "Write",
        summary,
        source: "codex_event",
      });
      return;
    }

    this.add({
      category: "Write",
      summary: "files",
      source: "codex_event",
    });
  }

  private ingestMcpToolCall(item: McpToolCallItem): void {
    const seenKey = `codex:mcp:${item.id}`;
    if (this.seen.has(seenKey)) {
      return;
    }
    this.seen.add(seenKey);

    const summary = [item.server, item.tool].filter(Boolean).join(".");
    this.add({
      category: "Tool",
      summary: summary || "mcp",
      source: "codex_event",
    });
  }

  private ingestWebSearch(item: WebSearchItem): void {
    const seenKey = `codex:web_search:${item.id}`;
    if (this.seen.has(seenKey)) {
      return;
    }
    this.seen.add(seenKey);

    this.add({
      category: "WebSearch",
      summary: truncate(item.query ?? "", 140) || "(empty)",
      source: "codex_event",
    });
  }

  private add(entry: Omit<ExploredEntry, "ts">): void {
    const summary = entry.summary?.trim();
    if (!summary) {
      return;
    }
    const full: ExploredEntry = {
      ...entry,
      summary,
      ts: Date.now(),
    };
    this.entries.push(full);
    try {
      this.onEntryCallback?.(full);
    } catch {
      // ignore callback errors
    }
  }
}

export function formatExploredEntry(entry: ExploredEntry, isLast = false): string {
  const prefix = isLast ? "  └ " : "  ├ ";
  return `${prefix}${entry.category} ${entry.summary}`;
}

export function formatExploredTree(entries: ExploredEntry[]): string {
  if (!entries || entries.length === 0) {
    return "";
  }
  const filtered = entries.filter((entry) => entry && entry.summary?.trim());
  if (filtered.length === 0) {
    return "";
  }
  const lines: string[] = ["Explored"];
  filtered.forEach((entry, idx) => {
    lines.push(formatExploredEntry(entry, idx === filtered.length - 1));
  });
  return lines.join("\n");
}
