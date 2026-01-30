import { createLogger } from "../../utils/logger.js";

export const SNIPPET_LIMIT = 180;
export const EXEC_MAX_OUTPUT_BYTES = 48 * 1024;
export const EXEC_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const FILE_DEFAULT_MAX_BYTES = 200 * 1024;
export const FILE_DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
export const PATCH_DEFAULT_MAX_BYTES = 512 * 1024;

export const logger = createLogger("AgentTools");

export function createAbortError(message = "用户中断了请求"): Error {
  const abortError = new Error(message);
  abortError.name = "AbortError";
  return abortError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function truncate(text: string, limit = SNIPPET_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

export function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

export function isExecToolEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, true);
}

export function isFileToolsEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_FILE_TOOLS, true);
}

export function isApplyPatchEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_APPLY_PATCH, true);
}

export function getReadMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_FILE_TOOL_MAX_BYTES, FILE_DEFAULT_MAX_BYTES);
}

export function getWriteMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_FILE_TOOL_MAX_WRITE_BYTES, FILE_DEFAULT_MAX_WRITE_BYTES);
}

export function getPatchMaxBytes(): number {
  return parsePositiveInt(process.env.AGENT_APPLY_PATCH_MAX_BYTES, PATCH_DEFAULT_MAX_BYTES);
}
