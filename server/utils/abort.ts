export const ABORT_ERROR_NAME = "AbortError";

export function createAbortError(message: string = ABORT_ERROR_NAME): Error {
  const error = new Error(message);
  error.name = ABORT_ERROR_NAME;
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof error !== "object") {
    return String(error) === ABORT_ERROR_NAME;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === ABORT_ERROR_NAME || candidate.message === ABORT_ERROR_NAME;
}

