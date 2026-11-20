import path from "node:path";
import util from "node:util";

import { withStatusLineSuppressed } from "./statusLineManager.js";
import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { RotatingLogFile } from "./rotatingLogFile.js";

type ConsoleMethod = (...args: unknown[]) => void;

let initialized = false;

interface GlobalConsoleLoggerOptions {
  logFileName?: string;
  mirrorToStdout?: boolean;
  maxBytes?: number;
}

function resolveLogFilePath(fileName?: string): string {
  const explicitFile = process.env.ADS_LOG_FILE;
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const logDirEnv = process.env.ADS_LOG_DIR;
  const baseDir = logDirEnv
    ? path.resolve(logDirEnv)
    : path.join(resolveAdsStateDir(), "logs");
  const file = fileName ?? "ads.log";
  return path.join(baseDir, file);
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  return util.inspect(arg, { depth: 6, colors: false, breakLength: 120 });
}

export function initGlobalConsoleLogger(options?: GlobalConsoleLoggerOptions): void {
  if (initialized) {
    return;
  }

  const original = {
    log: console.log.bind(console) as ConsoleMethod,
    info: console.info ? (console.info.bind(console) as ConsoleMethod) : console.log.bind(console),
    warn: console.warn.bind(console) as ConsoleMethod,
    error: console.error.bind(console) as ConsoleMethod,
    debug: console.debug ? (console.debug.bind(console) as ConsoleMethod) : console.log.bind(console),
  };

  const mirrorToStdoutEnv = process.env.ADS_LOG_STDOUT;
  const mirrorToStdout =
    options?.mirrorToStdout ??
    (mirrorToStdoutEnv === undefined ? Boolean(process.stdout.isTTY) : mirrorToStdoutEnv !== "0");

  const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  let sink: RotatingLogFile | null = null;
  let closed = false;
  try {
    const logFilePath = resolveLogFilePath(options?.logFileName);
    sink = new RotatingLogFile(logFilePath, { maxBytes, mode: 0o600 });
  } catch (error) {
    original.error("[LogSink] Failed to initialize file logger:", error);
    return;
  }

  if (!sink) {
    return;
  }

  const restoreConsole = (): void => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  };

  const createRotatingWriter = (mirror: boolean, originalMethod: ConsoleMethod, level: string) => {
    return (...args: unknown[]): void => {
      const timestamp = new Date().toISOString();
      const message = args.map(formatArg).join(" ");
      const currentSink = sink;
      if (currentSink) {
        try {
          currentSink.write(`${timestamp} ${level.padEnd(5)} ${message}\n`);
        } catch {
          // Ignore log sink failures; fall back to the original console method.
        }
        if (mirror) {
          withStatusLineSuppressed(() => originalMethod(...args));
        }
        return;
      }
      withStatusLineSuppressed(() => originalMethod(...args));
    };
  };

  console.log = createRotatingWriter(mirrorToStdout, original.log, "INFO");
  console.info = createRotatingWriter(mirrorToStdout, original.info, "INFO");
  console.warn = createRotatingWriter(mirrorToStdout, original.warn, "WARN");
  console.error = createRotatingWriter(mirrorToStdout, original.error, "ERROR");
  console.debug = createRotatingWriter(mirrorToStdout, original.debug, "DEBUG");

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    restoreConsole();
    if (!sink) {
      return;
    }
    try {
      sink.close();
    } catch {
      // ignore
    }
    sink = null;
  };

  process.once("exit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  initialized = true;
}

initGlobalConsoleLogger();

export default initGlobalConsoleLogger;
