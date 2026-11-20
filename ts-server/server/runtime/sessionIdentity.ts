const NATIVE_EXECUTION_ID_PREFIX = "native-";
const NATIVE_EXECUTION_ID_PATTERN = /native-[A-Za-z0-9_-]+/g;

export function isNativeExecutionId(sessionId: string | null | undefined): boolean {
  return String(sessionId ?? "").trim().startsWith(NATIVE_EXECUTION_ID_PREFIX);
}

export function redactNativeExecutionIds(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).replace(NATIVE_EXECUTION_ID_PATTERN, "[native-execution-id-redacted]");
}
