import fs from "node:fs";
import path from "node:path";

import { createAbortError } from "../shared.js";

const FALLBACK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ads",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "logs",
  ".turbo",
  ".next",
  ".vite",
]);

export async function walkFiles(
  startPath: string,
  options: {
    signal?: AbortSignal;
    // Return false to stop traversal early.
    onFile: (filePath: string) => Promise<boolean> | boolean;
  },
): Promise<void> {
  const signal = options.signal;
  const throwIfStopped = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  const root = path.resolve(startPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return;
  }

  if (stats.isFile()) {
    throwIfStopped();
    const shouldContinue = await options.onFile(root);
    if (shouldContinue === false) {
      return;
    }
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  const stack: string[] = [root];
  while (stack.length > 0) {
    throwIfStopped();
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      throwIfStopped();
      const name = entry.name;
      if (!name) {
        continue;
      }
      const fullPath = path.join(currentDir, name);
      if (entry.isDirectory()) {
        if (FALLBACK_SKIP_DIRS.has(name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const shouldContinue = await options.onFile(fullPath);
        if (shouldContinue === false) {
          return;
        }
      }
    }
  }
}

