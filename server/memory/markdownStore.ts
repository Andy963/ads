import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("MemoryStore");

export function readMarkdownFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function writeMarkdownFile(filePath: string, content: string, options?: { maxTokens?: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sanitized = sanitizeMarkdown(content);
  const maxTokens = options?.maxTokens;
  const finalContent = maxTokens && maxTokens > 0 ? trimMarkdownToTokenLimit(sanitized, maxTokens) : sanitized;
  fs.writeFileSync(filePath, finalContent, "utf8");
}

export function trimMarkdownToTokenLimit(content: string, maxTokens: number): string {
  const lines = sanitizeMarkdown(content).split("\n");
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    total += estimateTokens(line);
    if (total > maxTokens && kept.length > 0) {
      logger.warn(`Markdown memory exceeded ${maxTokens} token estimate; trimming older lines.`);
      break;
    }
    kept.push(line);
  }
  return kept.reverse().join("\n").trimEnd() + "\n";
}

export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

function sanitizeMarkdown(content: string): string {
  return String(content ?? "")
    .replaceAll("\u0000", "")
    .split("\n")
    .map((line) => (line.length > 4000 ? line.slice(0, 4000) : line))
    .join("\n");
}
