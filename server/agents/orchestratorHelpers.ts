import type { Input } from "./protocol/types.js";
import type { PreferenceDirective } from "../memory/preferenceDirectives.js";

type SkillSaveBlock = { name: string; description: string | null; body: string };

export function extractInputText(input: Input): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function tokenize(text: string): string[] {
  const lowered = String(text ?? "").toLowerCase();
  if (!lowered.trim()) {
    return [];
  }

  const tokens = new Set<string>();

  for (const match of lowered.matchAll(/[a-z0-9]{3,}/g)) {
    tokens.add(match[0]);
  }

  const cjkRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  for (const match of lowered.matchAll(cjkRe)) {
    const seq = match[0];
    const sample = seq.length > 32 ? seq.slice(0, 32) : seq;
    if (sample.length >= 2 && sample.length <= 6) {
      tokens.add(sample);
    }
    addCjkNgrams(tokens, sample, 2);
    addCjkNgrams(tokens, sample, 3);
  }

  return Array.from(tokens);
}

function addCjkNgrams(out: Set<string>, seq: string, n: number): void {
  if (seq.length < n) return;
  for (let i = 0; i <= seq.length - n; i += 1) {
    out.add(seq.slice(i, i + n));
  }
}

export function uniqStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function isNonAsciiToken(token: string): boolean {
  for (let i = 0; i < token.length; i += 1) {
    if (token.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

export function extractSkillSaveBlocks(text: string): SkillSaveBlock[] {
  const blocks: SkillSaveBlock[] = [];
  const re = /<skill_save\s+name="([^"]+)"(?:\s+description="([^"]*)")?\s*>([\s\S]*?)<\/skill_save>/gi;
  for (const match of text.matchAll(re)) {
    const name = String(match[1] ?? "").trim();
    if (!name) continue;
    const description = match[2] !== undefined ? String(match[2]).trim() : null;
    const body = String(match[3] ?? "").trim();
    blocks.push({ name, description, body });
  }
  return blocks;
}

export function stripSkillSaveBlocks(text: string): string {
  return text.replace(/<skill_save\s+name="[^"]+"(?:\s+description="[^"]*")?\s*>[\s\S]*?<\/skill_save>/gi, "");
}

export function replaceInputText(input: Input, nextText: string): Input {
  if (typeof input === "string") {
    return nextText;
  }
  if (!Array.isArray(input)) {
    return String(nextText ?? "");
  }

  const trimmed = String(nextText ?? "").trim();
  const out: Input = [];
  let replaced = false;
  for (const part of input) {
    if (part.type === "text") {
      if (replaced) {
        continue;
      }
      replaced = true;
      if (trimmed) {
        out.push({ ...part, text: nextText });
      }
      continue;
    }
    out.push(part);
  }

  if (!replaced && trimmed) {
    out.unshift({ type: "text", text: nextText });
  }

  return out;
}

export function isEmptyInput(input: Input): boolean {
  if (typeof input === "string") return input.trim().length === 0;
  if (!Array.isArray(input)) return String(input ?? "").trim().length === 0;
  for (const part of input) {
    if (part.type === "text" && part.text.trim()) {
      return false;
    }
    if (part.type !== "text") {
      return false;
    }
  }
  return true;
}

export function formatSavedPreferencesSuffix(saved: PreferenceDirective[]): string {
  const formatted = saved.map((p) => `${p.key}=${p.value}`).join(", ");
  return `（已保存偏好: ${formatted}）`;
}
