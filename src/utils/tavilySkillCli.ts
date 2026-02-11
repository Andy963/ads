import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./commandRunner.js";
import type { CommandRunRequest, CommandRunResult } from "./commandRunner.js";

export type TavilyCliSearchRequest = {
  cmd: "search";
  query: string;
  maxResults?: number;
  searchDepth?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  topic?: string;
  days?: number;
};

export type TavilyCliFetchRequest = {
  cmd: "fetch";
  url: string;
  includeImages?: boolean;
  extractDepth?: string;
  format?: string;
  timeout?: number;
  includeFavicon?: boolean;
};

export type TavilyCliRequest = TavilyCliSearchRequest | TavilyCliFetchRequest;

export type TavilyCliSuccess = {
  commandLine: string;
  elapsedMs: number;
  json: unknown;
};

export interface TavilyCliRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  execPath?: string;
  scriptPath?: string;
  runner?: (request: CommandRunRequest) => Promise<CommandRunResult>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function parseEnvApiKeys(env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];
  const list = env.TAVILY_API_KEYS ?? "";
  for (const raw of list.split(",")) {
    const trimmed = raw.trim();
    if (trimmed) keys.push(trimmed);
  }
  const single = (env.TAVILY_API_KEY ?? "").trim();
  if (keys.length === 0 && single) keys.push(single);
  return keys;
}

export function hasTavilyApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvApiKeys(env).length > 0;
}

function buildEnvForChild(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = parseEnvApiKeys(env);
  if (keys.length === 0) {
    throw new Error("Missing Tavily API key(s). Set TAVILY_API_KEY or TAVILY_API_KEYS.");
  }

  const single = (env.TAVILY_API_KEY ?? "").trim();
  if (single) {
    return env;
  }

  return { ...env, TAVILY_API_KEY: keys[0] };
}

function resolveDefaultScriptPath(cwd: string): string {
  return path.join(cwd, ".agent", "skills", "tavily-research", "scripts", "tavily-cli.cjs");
}

function addArg(args: string[], flag: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return;
  args.push(flag);
  args.push(typeof value === "boolean" ? (value ? "true" : "false") : String(value));
}

function buildArgs(scriptPath: string, request: TavilyCliRequest): string[] {
  const args: string[] = [scriptPath, request.cmd];
  if (request.cmd === "search") {
    addArg(args, "--query", request.query);
    addArg(args, "--maxResults", request.maxResults);
    addArg(args, "--searchDepth", request.searchDepth);
    addArg(args, "--includeDomains", request.includeDomains?.join(","));
    addArg(args, "--excludeDomains", request.excludeDomains?.join(","));
    addArg(args, "--topic", request.topic);
    addArg(args, "--days", request.days);
    return args;
  }

  addArg(args, "--url", request.url);
  addArg(args, "--includeImages", request.includeImages);
  addArg(args, "--extractDepth", request.extractDepth);
  addArg(args, "--format", request.format);
  addArg(args, "--timeout", request.timeout);
  addArg(args, "--includeFavicon", request.includeFavicon);
  return args;
}

export async function runTavilyCli(request: TavilyCliRequest, options: TavilyCliRunOptions = {}): Promise<TavilyCliSuccess> {
  if (request.cmd === "search") {
    if (!request.query || !request.query.trim()) {
      throw new Error("missing query");
    }
  } else if (!request.url || !request.url.trim()) {
    throw new Error("missing url");
  }

  const cwd = options.cwd ?? process.cwd();
  const scriptPath = options.scriptPath ?? resolveDefaultScriptPath(cwd);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Missing Tavily skill script: ${scriptPath}`);
  }

  const runner = options.runner ?? runCommand;
  const env = buildEnvForChild(options.env ?? process.env);
  const execPath = options.execPath ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const result = await runner({
    cmd: execPath,
    args: buildArgs(scriptPath, request),
    cwd,
    timeoutMs,
    env,
    maxOutputBytes,
  });

  if (result.timedOut) {
    throw new Error("Tavily CLI timed out");
  }
  if (result.truncatedStdout || result.truncatedStderr) {
    throw new Error("Tavily CLI output truncated");
  }
  if (result.exitCode !== 0) {
    const details = (result.stderr || result.stdout || "").trim();
    throw new Error(details ? `Tavily CLI failed: ${details}` : `Tavily CLI failed with exitCode=${result.exitCode ?? "unknown"}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Tavily CLI returned invalid JSON: ${msg}`);
  }

  return {
    commandLine: result.commandLine,
    elapsedMs: result.elapsedMs,
    json,
  };
}

function truncate(text: string, limit: number): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit <= 1) {
    return "…";
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function formatTavilySearchResults(query: string, payload: unknown): string {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawResults = record?.results;
  const results = Array.isArray(rawResults) ? rawResults : [];

  const lines: string[] = [];
  lines.push(`🔎 Search: ${truncate(query, 96)}`);

  if (results.length === 0) {
    lines.push("No results.");
  } else {
    results.slice(0, 10).forEach((item, index) => {
      const itemRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const title = readString(itemRecord, "title") ?? readString(itemRecord, "url") ?? "Untitled";
      const url = readString(itemRecord, "url") ?? "";
      const snippet = readString(itemRecord, "content") ?? readString(itemRecord, "snippet") ?? "";
      const urlPart = url ? ` ${url}` : "";
      const snippetPart = snippet ? ` - ${truncate(snippet, 140)}` : "";
      lines.push(`${index + 1}. ${title}${urlPart}${snippetPart}`);
    });
  }

  const answer = record ? readString(record, "answer") : undefined;
  if (answer) {
    lines.push("");
    lines.push(`Answer: ${truncate(answer, 360)}`);
  }

  return lines.join("\n");
}
