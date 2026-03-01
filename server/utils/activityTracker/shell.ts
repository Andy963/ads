import type { ExploredCategory } from "../activityTracker.js";
import { displayPath, normalizeFirstLine, truncate } from "./text.js";

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
    return summarizeCatLike(normalized) ?? summarizeSed(normalized) ?? truncate(normalized, 96);
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

export { categorizeCommand, summarizeCommand };

