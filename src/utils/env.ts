import fs from "node:fs";
import path from "node:path";

import { createLogger } from "./logger.js";

const logger = createLogger("Env");

let loaded = false;

function findEnvFile(startDir: string = process.cwd()): string | null {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
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
  const envPath = findEnvFile();
  if (!envPath) {
    loaded = true;
    return;
  }
  try {
    applyEnvFile(envPath, false);
    const localPath = `${envPath}.local`;
    if (fs.existsSync(localPath)) {
      applyEnvFile(localPath, true);
    }
  } catch (error) {
    logger.warn(`Failed to load ${envPath}: ${(error as Error).message}`, error);
  } finally {
    loaded = true;
  }
}

loadEnv();
