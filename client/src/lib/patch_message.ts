export function isPatchMessageMarkdown(markdown: string): boolean {
  const src = String(markdown ?? "");
  if (!src) return false;

  // Heuristic: structured patch messages are emitted with a fenced diff block
  // (see projectsWs/wsMessage.ts) and include common unified diff markers.
  // We use this to tweak UI chrome (e.g. hide copy/timestamp actions).
  const hasDiffFence = /```diff\b/i.test(src);
  if (!hasDiffFence) return false;

  const hasGitHeader = src.includes("diff --git");
  const hasUnifiedMarkers = src.includes("--- a/") && src.includes("+++ b/");
  return hasGitHeader || hasUnifiedMarkers;
}

