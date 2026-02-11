import type {
  CommandExecutionItem,
  FileChangeItem,
  ToolCallItem,
  ThreadEvent,
  WebSearchItem,
} from "../agents/protocol/types.js";

import { compactExploredEntries } from "./activityTracker/compact.js";
import { extractDiffPaths } from "./activityTracker/patch.js";
import { categorizeCommand, summarizeCommand } from "./activityTracker/shell.js";
import { displayPath, normalizeFirstLine, safeJsonParse, truncate } from "./activityTracker/text.js";

export type ExploredCategory =
  | "List"
  | "Search"
  | "Read"
  | "Write"
  | "Execute"
  | "Agent"
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
      case "tool_call":
        this.ingestToolCall(item as ToolCallItem);
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

    if (normalizedTool === "grep") {
      const parsed = safeJsonParse(trimmedPayload);
      const record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const pattern =
        typeof parsed === "string"
          ? parsed.trim()
          : typeof record?.pattern === "string"
            ? record.pattern.trim()
            : trimmedPayload;
      const pathValue = typeof record?.path === "string" ? record.path.trim() : "";
      const globValue = typeof record?.glob === "string" ? record.glob.trim() : "";
      const scopeParts = [pathValue ? displayPath(pathValue) : "", globValue ? `glob:${globValue}` : ""].filter(Boolean);
      const scope = scopeParts.length > 0 ? ` in ${scopeParts.join(" ")}` : "";
      this.add({
        category: "Search",
        summary: truncate(`${pattern}${scope}`, 180),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "find") {
      const parsed = safeJsonParse(trimmedPayload);
      const record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const pattern =
        typeof parsed === "string"
          ? parsed.trim()
          : typeof record?.pattern === "string"
            ? record.pattern.trim()
            : trimmedPayload;
      const pathValue = typeof record?.path === "string" ? record.path.trim() : "";
      const scope = pathValue ? ` in ${displayPath(pathValue)}` : "";
      this.add({
        category: "List",
        summary: truncate(`${pattern}${scope}`, 180),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "vsearch") {
      this.add({
        category: "Search",
        summary: truncate(trimmedPayload, 180),
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
      return;
    }

    if (normalizedTool === "agent") {
      const parsed = safeJsonParse(trimmedPayload);
      const record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      let agentId = "";
      let prompt = "";
      if (record) {
        agentId = String(record.agentId ?? record.agent_id ?? record.agent ?? "").trim();
        prompt = String(record.prompt ?? record.input ?? record.query ?? "").trim();
      } else {
        const lines = trimmedPayload.split(/\r?\n/);
        agentId = String(lines[0] ?? "").trim();
        prompt = lines.slice(1).join("\n").trim();
      }
      const label = agentId ? agentId.toLowerCase() : "agent";
      const summary = prompt ? `${label}: ${truncate(prompt, 160)}` : label;
      this.add({
        category: "Agent",
        summary,
        source: "tool_hook",
        meta: { tool: normalizedTool },
      });
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

  private ingestToolCall(item: ToolCallItem): void {
    const seenKey = `codex:tool:${item.id}`;
    if (this.seen.has(seenKey)) {
      return;
    }
    this.seen.add(seenKey);

    const summary = [item.server, item.tool].filter(Boolean).join(".");
    this.add({
      category: "Tool",
      summary: summary || "tool",
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
