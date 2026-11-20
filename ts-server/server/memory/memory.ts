import { migrateLegacyWorkspaceAdsIfNeeded, resolveWorkspaceStatePath } from "../workspace/adsPaths.js";
import { readMarkdownFile, writeMarkdownFile } from "./markdownStore.js";

const MEMORY_FILE = "memory.md";
const MEMORY_TEMPLATE = `# Memory

`;

export function resolveMemoryPath(workspaceRoot: string): string {
  migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot);
  return resolveWorkspaceStatePath(workspaceRoot, MEMORY_FILE);
}

export function readMemory(workspaceRoot: string): string {
  return readMarkdownFile(resolveMemoryPath(workspaceRoot));
}

export function writeMemory(workspaceRoot: string, content: string): void {
  const maxTokens = Number.parseInt(String(process.env.ADS_MEMORY_MAX_TOKENS ?? "1024"), 10);
  writeMarkdownFile(resolveMemoryPath(workspaceRoot), content, { maxTokens: Number.isFinite(maxTokens) ? maxTokens : 1024 });
}

export function updateMemory(args: { workspaceRoot: string; op: "add" | "remove" | "replace"; content: string; key?: string }): string {
  const current = readMemory(args.workspaceRoot) || MEMORY_TEMPLATE;
  const content = args.content.trim();
  if (!content) return current;

  if (args.op === "add") {
    const next = `${current.trimEnd()}\n${content}\n`;
    writeMemory(args.workspaceRoot, next);
    return next;
  }

  if (args.op === "remove") {
    const next = current
      .split("\n")
      .filter((line) => line.trim() !== content)
      .join("\n");
    writeMemory(args.workspaceRoot, next);
    return next;
  }

  const key = String(args.key ?? "").trim();
  const marker = key ? `<!-- key:${key} -->` : "";
  if (marker && current.includes(marker)) {
    const pattern = new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?(?=\\n<!-- key:|$)`);
    const next = current.replace(pattern, `${marker}\n${content}\n`);
    writeMemory(args.workspaceRoot, next);
    return next;
  }
  const next = `${current.trimEnd()}\n${marker ? `${marker}\n` : ""}${content}\n`;
  writeMemory(args.workspaceRoot, next);
  return next;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
