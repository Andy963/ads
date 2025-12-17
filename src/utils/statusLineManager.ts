export interface StatusLineManager {
  isActive: () => boolean;
  clear: () => void;
  render: () => void;
}

let manager: StatusLineManager | null = null;
let suppressionDepth = 0;

export function setStatusLineManager(next: StatusLineManager | null): void {
  manager = next;
}

export function withStatusLineSuppressed<T>(fn: () => T): T {
  const current = manager;
  if (!current || !current.isActive()) {
    return fn();
  }

  if (suppressionDepth > 0) {
    return fn();
  }

  suppressionDepth += 1;
  try {
    try {
      current.clear();
    } catch {
      // ignore
    }
    const result = fn();
    try {
      current.render();
    } catch {
      // ignore
    }
    return result;
  } finally {
    suppressionDepth -= 1;
  }
}

