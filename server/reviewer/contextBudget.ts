import type { ReviewContextOmission, ReviewRelatedContext } from "./types.js";

export const RELATED_CONTEXT_LIMITS = { files: 32, lines: 3000, bytes: 64 * 1024 } as const;

export function boundRelatedContexts(
  contexts: ReviewRelatedContext[],
  omissions: ReviewContextOmission[] = [],
): { relatedContexts: ReviewRelatedContext[]; relatedContextOmissions: ReviewContextOmission[] } {
  const relatedContexts: ReviewRelatedContext[] = [];
  const relatedContextOmissions = [...omissions];
  const seen = new Set<string>();
  let lines = 0;
  let bytes = 0;
  for (const context of contexts) {
    if (seen.has(context.file)) continue;
    seen.add(context.file);
    const lineCount = context.content.split("\n").length;
    const byteCount = Buffer.byteLength(context.content, "utf8");
    if (Buffer.byteLength(context.file, "utf8") > 1024
      || relatedContexts.length >= RELATED_CONTEXT_LIMITS.files
      || lines + lineCount > RELATED_CONTEXT_LIMITS.lines
      || bytes + byteCount > RELATED_CONTEXT_LIMITS.bytes) {
      relatedContextOmissions.push({ file: context.file, reason: "Context budget exceeded; complete declarations were omitted, not cut." });
      continue;
    }
    relatedContexts.push(context);
    lines += lineCount;
    bytes += byteCount;
  }
  return { relatedContexts, relatedContextOmissions };
}
