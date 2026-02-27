import { safeParseJson } from "./json.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseSqliteBoolean(value: unknown): boolean {
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function parseOptionalSqliteInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSqliteJsonObject(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = safeParseJson<unknown>(value);
    return isRecord(parsed) ? parsed : fallback;
  }
  return isRecord(value) ? value : fallback;
}

