import { spawn } from "node:child_process";
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

/**
 * 启动子进程，按行读取 stdout 的 JSONL 输出，每行调用 onLine 回调。
 *
 * 参考：luban 的 codex_cli.rs / amp_cli.rs 中的 run_*_turn_streamed_via_cli
 */
export async function runCli(
  options: CliRunOptions,
  onLine: LineHandler,
): Promise<CliRunResult> {
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
    if (cancelled) break;
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

/**
 * 运行 CLI 命令，返回 stdout 的完整文本。
 * 用于不产生 JSONL 输出的简单命令（如 amp threads new）。
 */
export async function runCliRaw(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
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
