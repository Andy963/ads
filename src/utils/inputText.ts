import type { Input } from "../agents/protocol/types.js";

export function extractTextFromInput(input: Input): string {
  if (typeof input === "string") {
    return input;
  }

  return input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
