export function chunkMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  let openFence: string | null = null;

  const appendLine = (line: string) => {
    current = current ? `${current}\n${line}` : line;
  };

  const flushChunk = () => {
    if (!current.trim()) {
      current = "";
      return;
    }
    chunks.push(current);
    current = "";
  };

  for (const line of lines) {
    const prospective = current ? current.length + 1 + line.length : line.length;
    if (prospective + (openFence ? 4 : 0) > maxLen && current) {
      if (openFence) {
        current += "\n```";
      }
      flushChunk();
      if (openFence) {
        current = openFence;
      }
    }

    appendLine(line);

    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (openFence) {
        openFence = null;
      } else {
        const fence = trimmed.match(/^```[^\s]*?/);
        openFence = fence ? fence[0] : "```";
      }
    }
  }

  if (openFence) {
    current += "\n```";
  }
  flushChunk();
  return chunks;
}

