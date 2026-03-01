import type { AgentIdentifier } from "./types.js";

export type DelegationDirectiveRange = {
  start: number;
  end: number;
  raw: string;
  agentId: AgentIdentifier;
  prompt: string;
};

function normalizeLineForMatch(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseDirectiveStart(line: string): AgentIdentifier | null {
  const normalized = normalizeLineForMatch(line);
  const match = /^<<<agent\.([a-z0-9_-]+)\s*$/i.exec(normalized);
  if (!match) {
    return null;
  }
  const agentId = String(match[1] ?? "").trim().toLowerCase();
  return agentId ? (agentId as AgentIdentifier) : null;
}

function isDirectiveEnd(line: string): boolean {
  const normalized = normalizeLineForMatch(line);
  return /^>>>\s*$/.test(normalized);
}

export function extractDelegationDirectivesWithRanges(
  text: string,
  options?: { excludeAgentId?: AgentIdentifier; requirePrompt?: boolean },
): DelegationDirectiveRange[] {
  const input = String(text ?? "");
  if (!input) {
    return [];
  }

  const exclude = options?.excludeAgentId ? String(options.excludeAgentId).trim().toLowerCase() : null;
  const requirePrompt = options?.requirePrompt !== false;

  const directives: DelegationDirectiveRange[] = [];
  let i = 0;

  let active: {
    start: number;
    agentId: AgentIdentifier;
    promptStart: number;
  } | null = null;

  while (i <= input.length) {
    const lineStart = i;
    const nextNewline = input.indexOf("\n", i);
    const lineEnd = nextNewline === -1 ? input.length : nextNewline;
    const line = input.slice(lineStart, lineEnd);
    const nextIndex = nextNewline === -1 ? input.length + 1 : lineEnd + 1;

    if (!active) {
      const agentId = parseDirectiveStart(line);
      if (agentId) {
        active = { start: lineStart, agentId, promptStart: nextNewline === -1 ? input.length : lineEnd + 1 };
      }
      i = nextIndex;
      continue;
    }

    if (isDirectiveEnd(line)) {
      const start = active.start;
      const end = nextNewline === -1 ? input.length : lineEnd + 1;
      const promptRaw = input.slice(active.promptStart, lineStart);
      const prompt = promptRaw.trim();
      const agentId = active.agentId;
      const raw = input.slice(active.start, end);

      active = null;
      i = nextIndex;

      if (exclude && agentId === exclude) {
        continue;
      }
      if (requirePrompt && !prompt) {
        continue;
      }

      directives.push({ start, end, raw, agentId, prompt });
      continue;
    }

    i = nextIndex;
  }

  return directives;
}

export function stripDelegationDirectives(text: string, directives: Array<{ start: number; end: number }>): string {
  const input = String(text ?? "");
  if (!input || directives.length === 0) {
    return input;
  }

  const sorted = [...directives].sort((a, b) => b.end - a.end);
  let out = input;
  for (const d of sorted) {
    if (d.start < 0 || d.end < 0 || d.end < d.start) {
      continue;
    }
    out = out.slice(0, d.start) + out.slice(d.end);
  }
  return out;
}
