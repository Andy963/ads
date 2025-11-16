import fs from "node:fs";
import path from "node:path";
import util from "node:util";

type ConsoleMethod = (...args: unknown[]) => void;

let initialized = false;

interface GlobalConsoleLoggerOptions {
  logFileName?: string;
  mirrorToStdout?: boolean;
}

function findWorkspaceRoot(): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, ".ads");
    if (fs.existsSync(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveLogFilePath(fileName?: string): string {
  const explicitFile = process.env.ADS_LOG_FILE;
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  const logDirEnv = process.env.ADS_LOG_DIR;
  const workspaceRoot = findWorkspaceRoot();
  const baseDir = logDirEnv
    ? path.resolve(logDirEnv)
    : workspaceRoot
      ? path.join(workspaceRoot, ".ads", "logs")
      : path.join(process.cwd(), ".ads", "logs");
  const file = fileName ?? "ads.log";
  return path.join(baseDir, file);
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  return util.inspect(arg, { depth: 6, colors: false, breakLength: 120 });
}

function createWriter(stream: fs.WriteStream, mirror: boolean, original: ConsoleMethod, level: string) {
  return (...args: unknown[]): void => {
    const timestamp = new Date().toISOString();
    const message = args.map(formatArg).join(" ");
    stream.write(`${timestamp} ${level.padEnd(5)} ${message}\n`);
    if (mirror) {
      original(...args);
    }
  };
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
    options?.mirrorToStdout ?? (mirrorToStdoutEnv === undefined ? true : mirrorToStdoutEnv !== "0");

  let stream: fs.WriteStream | null = null;
  try {
    const logFilePath = resolveLogFilePath(options?.logFileName);
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    stream = fs.createWriteStream(logFilePath, { flags: "a" });
  } catch (error) {
    original.error("[LogSink] Failed to initialize file logger:", error);
    return;
  }

  if (!stream) {
    return;
  }

  console.log = createWriter(stream, mirrorToStdout, original.log, "INFO");
  console.info = createWriter(stream, mirrorToStdout, original.info, "INFO");
  console.warn = createWriter(stream, mirrorToStdout, original.warn, "WARN");
  console.error = createWriter(stream, mirrorToStdout, original.error, "ERROR");
  console.debug = createWriter(stream, mirrorToStdout, original.debug, "DEBUG");

  const close = (): void => {
    if (stream) {
      stream.end();
      stream = null;
    }
  };

  process.once("exit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  initialized = true;
}

initGlobalConsoleLogger();

export default initGlobalConsoleLogger;
