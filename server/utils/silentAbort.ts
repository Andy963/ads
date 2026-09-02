export const SILENT_ABORT_ERROR_NAME = "SilentAbortError";

export function createSilentAbortError(message: string = SILENT_ABORT_ERROR_NAME): Error {
  const error = new Error(message);
  error.name = SILENT_ABORT_ERROR_NAME;
  return error;
}

export function isSilentAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof error !== "object") {
    return String(error) === SILENT_ABORT_ERROR_NAME;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === SILENT_ABORT_ERROR_NAME || candidate.message === SILENT_ABORT_ERROR_NAME;
}
