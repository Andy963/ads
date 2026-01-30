function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizePathForGlob(value: string): string {
  return value.replace(/\\/g, "/");
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizePathForGlob(glob.trim());
  let re = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        re += ".*";
        i += 1;
        continue;
      }
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    if (ch === "/") {
      re += "\\/";
      continue;
    }
    if (/[\\^$+?.()|[\]{}]/.test(ch)) {
      re += `\\${ch}`;
      continue;
    }
    re += ch;
  }
  re += "$";
  return new RegExp(re);
}

export function safePatternToRegExp(pattern: string, ignoreCase: boolean): RegExp {
  const flags = ignoreCase ? "i" : "";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegExp(pattern), flags);
  }
}

