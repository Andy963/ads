// Shared lazy loader for the markdown pipeline (markdown-it + highlight.js).
// The pipeline is heavy and only needed once a chat message renders, so it
// ships as a separate chunk instead of the entry bundle. All consumers share
// one cached module instance.

type MarkdownModule = typeof import("../markdown");

let cached: MarkdownModule | null = null;
let pending: Promise<MarkdownModule> | null = null;

export function loadedMarkdown(): MarkdownModule | null {
  return cached;
}

export function loadMarkdown(): Promise<MarkdownModule> {
  if (cached) return Promise.resolve(cached);
  pending ??= import("../markdown").then((mod) => {
    cached = mod;
    return mod;
  });
  return pending;
}
