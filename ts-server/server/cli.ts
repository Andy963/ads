#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ParsedAdsCli =
  | { type: "help" }
  | { type: "version" }
  | { type: "start" }
  | { type: "error"; message: string; exitCode: number };

function writeStdout(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeStderr(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function isHelpFlag(value: string): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function isVersionFlag(value: string): boolean {
  return value === "version" || value === "--version" || value === "-v";
}

export function parseAdsCli(args: string[]): ParsedAdsCli {
  const token = (args[0] ?? "").trim();

  if (!token) {
    return { type: "start" };
  }

  if (isHelpFlag(token)) {
    return { type: "help" };
  }

  if (isVersionFlag(token)) {
    return { type: "version" };
  }

  return {
    type: "error",
    exitCode: 2,
    message: `❌ Unknown command: ${token}`,
  };
}

function resolveSelfDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findNearestPackageJson(startDir: string): string | null {
  let current = startDir;
  for (let depth = 0; depth < 20; depth += 1) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

function readPackageVersion(): string | null {
  const pkgPath = findNearestPackageJson(resolveSelfDir());
  if (!pkgPath) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function printHelp(): void {
  writeStdout(`
ADS Web Console

Usage:
  ads [options]

With no options, starts the ADS web server.

Options:
  --help, -h       Show this help message
  --version, -v    Show version information

Environment:
  ADS_WEB_HOST / ADS_WEB_PORT   Configure web server binding.
  ALLOWED_DIRS                 Comma-separated directory paths (shared by all endpoints)
  SANDBOX_MODE                 Sandbox mode: read-only|workspace-write|danger-full-access (shared)
`);
}

function printVersion(): void {
  const version = readPackageVersion();
  writeStdout(`ADS v${version ?? "unknown"}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    const entryPath = fs.realpathSync(entry);
    return pathToFileURL(selfPath).href === pathToFileURL(entryPath).href;
  } catch {
    return false;
  }
}

export async function runAdsFromCli(args: string[]): Promise<number> {
  const parsed = parseAdsCli(args);

  switch (parsed.type) {
    case "help": {
      printHelp();
      return 0;
    }
    case "version": {
      printVersion();
      return 0;
    }
    case "start": {
      await import("./web/server.js");
      return 0;
    }
    case "error": {
      writeStderr(parsed.message);
      const hint = 'Run "ads --help" for usage.';
      writeStderr(hint);
      return parsed.exitCode;
    }
  }
}

if (isMainModule()) {
  try {
    const exitCode = await runAdsFromCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`❌ ${message}`);
    process.exitCode = 1;
  }
}
