import type { Input } from "@openai/codex-sdk";

export function injectUserConfirmedMemory(input: Input, memory: string): Input {
  const normalizedMemory = String(memory ?? "").trim();
  if (!normalizedMemory) {
    return input;
  }

  const header = `Memory (user-confirmed):\n${normalizedMemory}`;

  if (typeof input === "string") {
    const trimmed = input.trim();
    return `${header}\n\nUser request:\n${trimmed || "(no text)"}`;
  }

  const parts = input.slice();
  const firstTextIndex = parts.findIndex((part) => part.type === "text");
  if (firstTextIndex === -1) {
    return [{ type: "text", text: header }, ...parts];
  }

  const original = parts[firstTextIndex] as { type: "text"; text: string };
  parts[firstTextIndex] = {
    type: "text",
    text: `${header}\n\nUser request:\n${original.text}`,
  };
  return parts;
}

