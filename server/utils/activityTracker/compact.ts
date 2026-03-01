import type { ExploredConfig, ExploredEntry } from "../activityTracker.js";
import { truncate } from "./text.js";

export function compactExploredEntries(entries: ExploredEntry[], dedupe: ExploredConfig["dedupe"]): ExploredEntry[] {
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

