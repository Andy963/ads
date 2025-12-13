export function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return undefined;
}

export function resolveCommitRefParam(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const bool = parseBooleanParam(value);
  if (bool === undefined) {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return bool ? "HEAD" : undefined;
}

