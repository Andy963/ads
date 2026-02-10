import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "../../utils/logger.js";
import { stripAnsi } from "./stripAnsi.js";

const logger = createLogger("CliRunner");

export interface CliRunOptions {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdinData?: string;
  signal?: AbortSignal;
}

export type LineHandler = (parsed: unknown) => void;

export interface CliRunResult {
  exitCode: number | null;
  stderr: string;
  cancelled: boolean;
}

let PIPE_STDIOS_SUPPORTED: boolean | null = null;

function supportsPipedStdios(): boolean {
  if (PIPE_STDIOS_SUPPORTED !== null) {
    return PIPE_STDIOS_SUPPORTED;
  }
  try {
    const res = spawnSync(process.execPath, ["-e", "process.stdout.write('x')"], { stdio: ["ignore", "pipe", "pipe"] });
    if (res.error) {
      PIPE_STDIOS_SUPPORTED = false;
    } else {
      const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString("utf8") : String(res.stdout ?? "");
      PIPE_STDIOS_SUPPORTED = stdout === "x";
    }
  } catch {
    PIPE_STDIOS_SUPPORTED = true;
  }
  return PIPE_STDIOS_SUPPORTED;
}

function readFileLimited(filePath: string, maxBytes = 8 * 1024 * 1024): { text: string; truncated: boolean } {
  try {
    const stat = fs.statSync(filePath);
    const size = typeof stat.size === "number" && Number.isFinite(stat.size) ? stat.size : 0;
    const truncated = size > maxBytes;
    const toRead = Math.max(0, Math.min(size, maxBytes));
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
      return { text: buf.subarray(0, bytesRead).toString("utf-8"), truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

function emitJsonLines(rawStdout: string, onLine: LineHandler): void {
  const lines = String(rawStdout ?? "").split("\n");
  for (const rawLine of lines) {
    const stripped = stripAnsi(rawLine).trim();
    if (!stripped || !stripped.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(stripped);
      onLine(parsed);
    } catch {
      logger.debug(`跳过无法解析的行: ${stripped.substring(0, 100)}`);
    }
  }
}

/**
 * 启动子进程，按行读取 stdout 的 JSONL 输出，每行调用 onLine 回调。
 *
 * 参考：luban 的 codex_cli.rs / amp_cli.rs 中的 run_*_turn_streamed_via_cli
 */
export async function runCli(
  options: CliRunOptions,
  onLine: LineHandler,
): Promise<CliRunResult> {
  if (!supportsPipedStdios()) {
    return await runCliViaFiles(options, onLine);
  }

  const { binary, args, cwd, env, stdinData, signal } = options;

  const child = spawn(binary, args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    cancelled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2000);
  };

  if (signal) {
    if (signal.aborted) {
      child.kill("SIGTERM");
      cancelled = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on("error", (err) => resolve(err));
    child.on("spawn", () => resolve(null));
  });

  if (spawnError) {
    signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    const hint =
      (spawnError as NodeJS.ErrnoException).code === "ENOENT"
        ? `找不到可执行文件 "${binary}"，请确认已安装并在 PATH 中`
        : spawnError.message;
    throw new Error(hint);
  }

  if (child.stdin) {
    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  }

  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const rl = createInterface({ input: child.stdout! });
  for await (const rawLine of rl) {
    if (cancelled) {
      rl.close();
      child.stdout?.resume();
      break;
    }
    const stripped = stripAnsi(rawLine).trim();
    if (!stripped || !stripped.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(stripped);
      onLine(parsed);
    } catch {
      logger.debug(`跳过无法解析的行: ${stripped.substring(0, 100)}`);
    }
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
    } else {
      child.on("close", (code) => resolve(code));
    }
  });

  signal?.removeEventListener("abort", onAbort);
  if (killTimer) clearTimeout(killTimer);

  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    cancelled,
  };
}

async function runCliViaFiles(
  options: CliRunOptions,
  onLine: LineHandler,
): Promise<CliRunResult> {
  const { binary, args, cwd, env, stdinData, signal } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cli-runner-"));
  const stdoutPath = path.join(tmpDir, "stdout.txt");
  const stderrPath = path.join(tmpDir, "stderr.txt");
  const stdinPath = path.join(tmpDir, "stdin.txt");

  let stdinFd: number | "ignore" = "ignore";
  if (stdinData) {
    fs.writeFileSync(stdinPath, stdinData, "utf8");
    stdinFd = fs.openSync(stdinPath, "r");
  }
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  let child;
  try {
    child = spawn(binary, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [stdinFd, stdoutFd, stderrFd],
      shell: false,
    });
  } finally {
    try {
      if (typeof stdinFd === "number") fs.closeSync(stdinFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ignore
    }
  }

  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    cancelled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2000);
  };

  if (signal) {
    if (signal.aborted) {
      child.kill("SIGTERM");
      cancelled = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on("error", (err) => resolve(err));
    child.on("spawn", () => resolve(null));
  });

  if (spawnError) {
    signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const hint =
      (spawnError as NodeJS.ErrnoException).code === "ENOENT"
        ? `找不到可执行文件 "${binary}"，请确认已安装并在 PATH 中`
        : spawnError.message;
    throw new Error(hint);
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
    } else {
      child.on("close", (code) => resolve(code));
    }
  });

  signal?.removeEventListener("abort", onAbort);
  if (killTimer) clearTimeout(killTimer);

  const stdout = readFileLimited(stdoutPath, 32 * 1024 * 1024).text;
  const stderr = readFileLimited(stderrPath, 32 * 1024 * 1024).text;
  emitJsonLines(stdout, onLine);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return { exitCode, stderr, cancelled };
}

/**
 * 运行 CLI 命令，返回 stdout 的完整文本。
 * 用于不产生 JSONL 输出的简单命令（如 amp threads new）。
 */
export async function runCliRaw(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (!supportsPipedStdios()) {
    return await runCliRawViaFiles(options);
  }

  const { binary, args, cwd, env } = options;

  const child = spawn(binary, args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on("error", (err) => resolve(err));
    child.on("spawn", () => resolve(null));
  });

  if (spawnError) {
    const hint =
      (spawnError as NodeJS.ErrnoException).code === "ENOENT"
        ? `找不到可执行文件 "${binary}"，请确认已安装并在 PATH 中`
        : spawnError.message;
    throw new Error(hint);
  }

  if (child.stdin) {
    child.stdin.end();
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    exitCode,
  };
}

async function runCliRawViaFiles(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { binary, args, cwd, env, stdinData } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cli-raw-"));
  const stdoutPath = path.join(tmpDir, "stdout.txt");
  const stderrPath = path.join(tmpDir, "stderr.txt");
  const stdinPath = path.join(tmpDir, "stdin.txt");

  let stdinFd: number | "ignore" = "ignore";
  if (stdinData) {
    fs.writeFileSync(stdinPath, stdinData, "utf8");
    stdinFd = fs.openSync(stdinPath, "r");
  }
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  let child;
  try {
    child = spawn(binary, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [stdinFd, stdoutFd, stderrFd],
      shell: false,
    });
  } finally {
    try {
      if (typeof stdinFd === "number") fs.closeSync(stdinFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ignore
    }
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on("error", (err) => resolve(err));
    child.on("spawn", () => resolve(null));
  });

  if (spawnError) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const hint =
      (spawnError as NodeJS.ErrnoException).code === "ENOENT"
        ? `找不到可执行文件 "${binary}"，请确认已安装并在 PATH 中`
        : spawnError.message;
    throw new Error(hint);
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const stdout = readFileLimited(stdoutPath, 32 * 1024 * 1024).text;
  const stderr = readFileLimited(stderrPath, 32 * 1024 * 1024).text;

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return { stdout, stderr, exitCode };
}
