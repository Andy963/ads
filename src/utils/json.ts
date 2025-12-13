import { z } from "zod";

export function safeParseJson<T>(payload: string | null | undefined): T | null {
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export function safeParseJsonWithSchema<TSchema extends z.ZodTypeAny>(
  payload: string | null | undefined,
  schema: TSchema,
): z.infer<TSchema> | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseJsonWithSchema<TSchema extends z.ZodTypeAny>(
  payload: string,
  schema: TSchema,
): z.infer<TSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error("Invalid JSON payload", { cause: error instanceof Error ? error : undefined });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid JSON payload: ${result.error.message}`);
  }
  return result.data;
}

export function safeStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Map) {
      return Object.fromEntries(val.entries());
    }
    if (val instanceof Set) {
      return Array.from(val.values());
    }
    return val;
  }, indent);
}
