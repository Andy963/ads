export interface ChunkingOptions {
  maxChars: number;
  overlapChars: number;
}

export interface TextChunk {
  index: number;
  text: string;
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function chunkText(input: string, options: ChunkingOptions): TextChunk[] {
  const maxChars = clampPositiveInt(options.maxChars, 1600);
  const overlapChars = Math.min(clampPositiveInt(options.overlapChars, 200), Math.max(0, Math.floor(maxChars / 2)));

  const text = normalizeNewlines(String(input ?? ""));
  if (!text.trim()) return [];

  const paragraphs = text.split(/\n\s*\n/g);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = "";
  };

  const pushLong = (para: string) => {
    const raw = para.trim();
    if (!raw) return;
    let start = 0;
    while (start < raw.length) {
      const end = Math.min(raw.length, start + maxChars);
      const slice = raw.slice(start, end).trim();
      if (slice) chunks.push(slice);
      if (end >= raw.length) break;
      start = Math.max(0, end - overlapChars);
    }
  };

  for (const paraRaw of paragraphs) {
    const para = paraRaw.trim();
    if (!para) continue;

    if (para.length > maxChars) {
      pushCurrent();
      pushLong(para);
      continue;
    }

    if (!current) {
      current = para;
      continue;
    }

    if (current.length + 2 + para.length <= maxChars) {
      current = `${current}\n\n${para}`;
      continue;
    }

    pushCurrent();
    current = para;
  }

  pushCurrent();
  return chunks.map((chunk, index) => ({ index, text: chunk }));
}

