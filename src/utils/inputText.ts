import type { Input } from "../agents/protocol/types.js";

export interface ExtractTextFromInputOptions {
  trim?: boolean;
}

export function extractTextFromInput(input: Input, options: ExtractTextFromInputOptions = {}): string {
  const text =
    typeof input === "string"
      ? input
      : input
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n");

  if (options.trim) {
    return text.trim();
  }
  return text;
}
