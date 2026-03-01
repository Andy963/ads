#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type AdsTopLevelCommand = "web" | "telegram" | "help" | "version";
type AdsService = "web" | "telegram";

export type ParsedAdsCli =
  | { type: "help"; scope: "root" | AdsService }
  | { type: "version" }
  | { type: "start"; service: AdsService }
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

function isTopLevelCommand(value: string): value is AdsTopLevelCommand {
  return value === "web" || value === "telegram" || value === "help" || value === "version";
}

function normalizeInvokedAs(invokedAs: string): string {
  const base = path.basename(invokedAs);
  return base || "ads";
}

function isTelegramAlias(invokedAs: string): boolean {
  const normalized = normalizeInvokedAs(invokedAs);
  return normalized === "ads-telegram";
}

export function parseAdsCli(args: string[], invokedAs: string): ParsedAdsCli {
  const aliasTelegram = isTelegramAlias(invokedAs);

  const token = (args[0] ?? "").trim();
  const sub = (args[1] ?? "").trim();

  if (!token) {
    return aliasTelegram ? { type: "start", service: "telegram" } : { type: "help", scope: "root" };
  }

  if (isHelpFlag(token)) {
    return aliasTelegram ? { type: "help", scope: "telegram" } : { type: "help", scope: "root" };
  }

  if (isVersionFlag(token)) {
    return { type: "version" };
  }

  if (aliasTelegram && (token === "start" || token === "run")) {
    return { type: "start", service: "telegram" };
  }

  if (isTopLevelCommand(token)) {
    if (token === "help") {
      return { type: "help", scope: aliasTelegram ? "telegram" : "root" };
    }
    if (token === "version") {
      return { type: "version" };
    }

    const service: AdsService = token;
    if (!sub || sub === "start" || sub === "run") {
      return { type: "start", service };
    }
    if (isHelpFlag(sub)) {
      return { type: "help", scope: service };
    }
    if (isVersionFlag(sub)) {
      return { type: "version" };
    }
    return {
      type: "error",
      exitCode: 2,
      message: `❌ Unknown command: ${token} ${sub}`,
    };
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

function printRootHelp(): void {
  writeStdout(`
ADS CLI

Usage:
  ads <command>

Commands:
  web [start]          Start the Web Console
  telegram [start]     Start the Telegram bot
  help                 Show this help message
  version              Show version information

Compatibility:
  ads-telegram [start] Alias for \`ads telegram\`
`);
}

function printWebHelp(): void {
  writeStdout(`
ADS Web Console

Usage:
  ads web [start]

Environment:
  ADS_WEB_HOST / ADS_WEB_PORT   Configure web server binding.
  ALLOWED_DIRS                 Comma-separated directory paths (shared by all endpoints)
  SANDBOX_MODE                 Sandbox mode: read-only|workspace-write|danger-full-access (shared)
`);
}

function printTelegramHelp(invokedAs: string): void {
  const usage = isTelegramAlias(invokedAs) ? "ads-telegram [command]" : "ads telegram [command]";
  writeStdout(`
ADS Telegram Bot

Usage:
  ${usage}

Commands:
  start         Start the Telegram bot (default)
  help          Show this help message
  version       Show version information

Environment Variables:
  TELEGRAM_BOT_TOKEN          Your Telegram bot token (required)
  TELEGRAM_ALLOWED_USER_ID    Single user ID (required)
  TELEGRAM_ALLOWED_USERS      Legacy alias (single value only)
  ADS_PM2_APP_WEB             pm2 app name for web restarts (optional, e.g. ads-web)
  ALLOWED_DIRS                Comma-separated directory paths (shared by all endpoints)
  SANDBOX_MODE                Sandbox mode: read-only|workspace-write|danger-full-access (shared)
`);
}

async function printVersion(invokedAs: string): Promise<void> {
  const version = readPackageVersion();
  const label = isTelegramAlias(invokedAs) ? "Telegram Bot" : "ADS";
  writeStdout(`${label} v${version ?? "unknown"}`);
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

export async function runAdsFromCli(args: string[], invokedAs: string): Promise<number> {
  const parsed = parseAdsCli(args, invokedAs);

  switch (parsed.type) {
    case "help": {
      if (parsed.scope === "root") {
        printRootHelp();
        return 0;
      }
      if (parsed.scope === "web") {
        printWebHelp();
        return 0;
      }
      printTelegramHelp(invokedAs);
      return 0;
    }
    case "version": {
      await printVersion(invokedAs);
      return 0;
    }
    case "start": {
      if (parsed.service === "web") {
        await import("./web/server.js");
        return 0;
      }
      await import("./telegram/bot.js");
      return 0;
    }
    case "error": {
      writeStderr(parsed.message);
      const hint = isTelegramAlias(invokedAs) ? 'Run "ads-telegram help" for usage.' : 'Run "ads --help" for usage.';
      writeStderr(hint);
      return parsed.exitCode;
    }
  }
}

if (isMainModule()) {
  const invokedAs = normalizeInvokedAs(process.argv[1] ?? "ads");
  try {
    const exitCode = await runAdsFromCli(process.argv.slice(2), invokedAs);
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`❌ ${message}`);
    process.exitCode = 1;
  }
}
