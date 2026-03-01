export type MergeStreamingTextResult = {
  full: string;
  delta: string;
};

export type MergeStreamingTextOptions = {
  maxOverlap?: number;
};

function findOverlapSuffixPrefix(prevTail: string, next: string): number {
  const max = Math.min(prevTail.length, next.length);
  for (let i = max; i > 0; i--) {
    if (prevTail.endsWith(next.slice(0, i))) {
      return i;
    }
  }
  return 0;
}

export function mergeStreamingText(
  prev: string,
  next: string,
  options?: MergeStreamingTextOptions,
): MergeStreamingTextResult {
  const previous = String(prev ?? "");
  const incoming = String(next ?? "");
  if (!incoming) {
    return { full: previous, delta: "" };
  }

  if (incoming.startsWith(previous)) {
    return { full: incoming, delta: incoming.slice(previous.length) };
  }

  if (previous.startsWith(incoming)) {
    return { full: previous, delta: "" };
  }

  const maxOverlap =
    typeof options?.maxOverlap === "number" && Number.isFinite(options.maxOverlap)
      ? Math.max(0, Math.floor(options.maxOverlap))
      : 256;
  const tail = previous.slice(Math.max(0, previous.length - maxOverlap));
  const overlap = findOverlapSuffixPrefix(tail, incoming);
  const delta = incoming.slice(overlap);
  return { full: previous + delta, delta };
}

