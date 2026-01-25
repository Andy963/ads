import fs from "node:fs";
import path from "node:path";

import { createLogger } from "./logger.js";

const logger = createLogger("Env");

let loaded = false;

const DEFAULT_ENV_SEARCH_MAX_DEPTH = 25;

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveExplicitEnvPath(): string | null {
  const raw = process.env.ADS_ENV_PATH;
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function findSearchBoundary(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) ||
      fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findEnvFile(startDir: string = process.cwd()): string | null {
  const boundary = findSearchBoundary(startDir);
  const maxDepth = parseNonNegativeInt(
    process.env.ADS_ENV_SEARCH_MAX_DEPTH,
    DEFAULT_ENV_SEARCH_MAX_DEPTH,
  );
  let current = startDir;
  let depth = 0;
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (boundary && current === boundary) {
      return null;
    }
    if (!boundary && depth >= maxDepth) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
    depth += 1;
  }
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    let value = normalized.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const commentIndex = value.indexOf(" #");
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trimEnd();
    }
    result[key] = value;
  }
  return result;
}

function applyEnvFile(envPath: string, override: boolean): void {
  const parsed = parseEnv(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnv(): void {
  if (loaded) {
    return;
  }
  const explicitEnvPath = resolveExplicitEnvPath();
  const envPath = explicitEnvPath ?? findEnvFile();
  if (!envPath) {
    loaded = true;
    return;
  }
  if (explicitEnvPath && !fs.existsSync(envPath)) {
    logger.warn(`[Env] ADS_ENV_PATH points to missing file: ${envPath}`);
    loaded = true;
    return;
  }
  try {
    applyEnvFile(envPath, false);
    if (!envPath.endsWith(".local")) {
      const localPath = `${envPath}.local`;
      if (fs.existsSync(localPath)) {
        applyEnvFile(localPath, true);
      }
    }
  } catch (error) {
    logger.warn(`Failed to load ${envPath}: ${(error as Error).message}`, error);
  } finally {
    loaded = true;
  }
}

export function resetEnvForTests(): void {
  loaded = false;
}

loadEnv();
