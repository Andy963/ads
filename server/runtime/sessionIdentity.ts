const NATIVE_EXECUTION_ID_PREFIX = "native-";

export function isNativeExecutionId(sessionId: string | null | undefined): boolean {
  return String(sessionId ?? "").trim().startsWith(NATIVE_EXECUTION_ID_PREFIX);
}
