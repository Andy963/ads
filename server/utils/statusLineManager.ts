export function withStatusLineSuppressed<T>(fn: () => T): T {
  return fn();
}

