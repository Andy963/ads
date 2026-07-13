import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "../../utils/logger.js";
import { cliExecutionGovernor } from "./executionGovernor.js";
import { withAgentCliPath } from "./pathEnv.js";
import { stripAnsi } from "./stripAnsi.js";

const logger = createLogger("CliRunner");

export interface CliRunOptions {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  stdinData?: string;
  signal?: AbortSignal;
  /**
   * Legacy maximum runtime override in milliseconds. Prefer maxRunTimeoutMs for new callers.
   */
  timeoutMs?: number;
  /** Maximum wall-clock runtime in milliseconds. 0 disables the maximum runtime limit. */
  maxRunTimeoutMs?: number;
  /**
   * Maximum time without stdout or stderr activity in milliseconds.
   * Activity resets the idle watchdog. 0 disables the idle limit.
   */
  idleTimeoutMs?: number;
  /** Maximum retained bytes for each of stdout and stderr. Streaming callbacks still receive every parsed line. */
  maxOutputBytes?: number;
  /**
   * 由调用方（adapter）判断"这轮逻辑上已经结束"（例如已解析到终态 result 行）。
   * 一旦返回 true，runner 只再等 postCompletionGraceMs 让进程自然退出；
   * 超过宽限仍未退出则终止进程组并正常返回，避免子进程（或其孙进程持有
   * stdout 管道）拖到 30 分钟硬超时才收尾。仅对管道模式生效。
   */
  isRunComplete?: () => boolean;
  /**
   * isRunComplete 变为 true 后等待进程自然退出的宽限（毫秒）。
   * 默认 ADS_CLI_POST_COMPLETION_GRACE_MS（未设置时 10 秒），<=0 表示禁用宽限终止。
   */
  postCompletionGraceMs?: number;
}

export type LineHandler = (parsed: unknown) => void;

export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /**
   * true 表示进程是在 isRunComplete 已判定完成后、由宽限定时器终止的。
   * 此时 exitCode 反映的是终止信号而非真实失败，调用方不应据此判定失败。
   */
  terminatedAfterCompletion: boolean;
}

let PIPE_STDIOS_SUPPORTED: boolean | null = null;
const DEFAULT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const MIN_OUTPUT_MAX_BYTES = 64 * 1024;
const MAX_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

class TailByteBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    if (chunk.length === 0) return;
    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.size = this.maxBytes;
      this.didTruncate = true;
      return;
    }

    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.size - this.maxBytes;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.size -= overflow;
      }
      this.didTruncate = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}

function buildSpawnEnv(options: { env?: Record<string, string>; unsetEnv?: string[] }): NodeJS.ProcessEnv | undefined {
  const merged = withAgentCliPath({ ...process.env, ...(options.env ?? {}) });
  for (const key of options.unsetEnv ?? []) {
    delete merged[key];
  }
  return merged;
}

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

function readFileLimited(filePath: string, maxBytes = DEFAULT_OUTPUT_MAX_BYTES): { text: string; truncated: boolean } {
  try {
    const stat = fs.statSync(filePath);
    const size = typeof stat.size === "number" && Number.isFinite(stat.size) ? stat.size : 0;
    const truncated = size > maxBytes;
    const toRead = Math.max(0, Math.min(size, maxBytes));
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      const offset = Math.max(0, size - toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      return { text: buf.subarray(0, bytesRead).toString("utf-8"), truncated };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

function resolveOutputMaxBytes(value?: number): number {
  const configured = value ?? Number(process.env.ADS_CLI_OUTPUT_MAX_BYTES ?? DEFAULT_OUTPUT_MAX_BYTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_OUTPUT_MAX_BYTES;
  return Math.max(MIN_OUTPUT_MAX_BYTES, Math.min(MAX_OUTPUT_MAX_BYTES, Math.floor(configured)));
}

function formatSpawnErrorHint(binary: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return `找不到可执行文件 "${binary}"，请确认已安装并在 PATH 中`;
  }
  return error.message;
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<Error | null> {
  return new Promise<Error | null>((resolve) => {
    const onError = (err: Error) => {
      cleanup();
      resolve(err);
    };
    const onSpawn = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function signalChildProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already exited.
    }
  }
  child.kill(signal);
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("close", (code) => resolve(code));
  });
}

async function terminateAndWaitForClose(child: ReturnType<typeof spawn>, graceMs = 2000): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    signalChildProcessGroup(child, "SIGTERM");
  } catch {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    waitForClose(child).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          if (child.exitCode === null) signalChildProcessGroup(child, "SIGKILL");
        } catch {
          // already dead
        }
        void waitForClose(child).then(() => resolve());
      }, graceMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function tryParseJsonLine(rawLine: string): unknown | null {
  const stripped = stripAnsi(rawLine).trim();
  if (!stripped || !stripped.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    logger.debug(`跳过无法解析的行: ${stripped.substring(0, 100)}`);
    return null;
  }
}

function attachAbortHandler(
  child: ReturnType<typeof spawn>,
  signal?: AbortSignal,
): { isCancelled: () => boolean; dispose: () => void } {
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    cancelled = true;
    signalChildProcessGroup(child, "SIGTERM");
    killTimer = setTimeout(() => {
      try { signalChildProcessGroup(child, "SIGKILL"); } catch { /* already dead */ }
    }, 2000);
  };

  if (signal) {
    if (signal.aborted) {
      signalChildProcessGroup(child, "SIGTERM");
      cancelled = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const dispose = () => {
    signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
  };

  return { isCancelled: () => cancelled, dispose };
}

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Parse a non-negative timeout. Zero disables the corresponding watchdog. */
function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function readNonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * ADS_AGENT_RUN_TIMEOUT_MS remains a compatibility alias for the maximum
 * runtime. The new variable takes precedence when both are present.
 */
function resolveRunTimeouts(options: Pick<CliRunOptions, "idleTimeoutMs" | "maxRunTimeoutMs" | "timeoutMs">): {
  idleTimeoutMs: number;
  maxRunTimeoutMs: number;
} {
  const legacyOptionOnly =
    options.timeoutMs !== undefined && options.idleTimeoutMs === undefined && options.maxRunTimeoutMs === undefined;
  const configuredIdle = readNonBlankEnv("ADS_AGENT_IDLE_TIMEOUT_MS");
  const configuredNewMax = readNonBlankEnv("ADS_AGENT_MAX_RUN_TIMEOUT_MS");
  const configuredLegacyMax = readNonBlankEnv("ADS_AGENT_RUN_TIMEOUT_MS");
  const legacyEnvOnly =
    configuredLegacyMax !== undefined && configuredNewMax === undefined && configuredIdle === undefined;
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (legacyOptionOnly || legacyEnvOnly
      ? 0
      : parseTimeoutMs(configuredIdle, DEFAULT_IDLE_TIMEOUT_MS));
  const configuredMax = configuredNewMax ?? configuredLegacyMax;
  const maxRunTimeoutMs =
    options.maxRunTimeoutMs ?? options.timeoutMs ?? parseTimeoutMs(configuredMax, DEFAULT_MAX_RUN_TIMEOUT_MS);
  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs >= 0 ? Math.floor(idleTimeoutMs) : DEFAULT_IDLE_TIMEOUT_MS,
    maxRunTimeoutMs:
      Number.isFinite(maxRunTimeoutMs) && maxRunTimeoutMs >= 0
        ? Math.floor(maxRunTimeoutMs)
        : DEFAULT_MAX_RUN_TIMEOUT_MS,
  };
}

type RunTimeoutReason = "idle" | "max_runtime";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function scheduleLongTimeout(callback: () => void, delayMs: number): () => void {
  const deadline = Date.now() + Math.min(delayMs, Number.MAX_SAFE_INTEGER - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const arm = () => {
    if (cancelled) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      callback();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };

  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Terminate a CLI only after it has been idle for too long or reaches the
 * independent maximum wall-clock runtime. Any stdout/stderr data resets idle.
 */
function setupRunWatchdog(
  child: ReturnType<typeof spawn>,
  timeouts: { idleTimeoutMs: number; maxRunTimeoutMs: number },
  checkPendingActivity?: () => boolean,
): { touch: () => void; timeoutReason: () => RunTimeoutReason | null; dispose: () => void } {
  let timeoutReason: RunTimeoutReason | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelIdleTimer: (() => void) | undefined;
  let cancelMaxRunTimer: (() => void) | undefined;

  const terminate = (reason: RunTimeoutReason) => {
    if (timeoutReason || child.exitCode !== null) return;
    timeoutReason = reason;
    try {
      signalChildProcessGroup(child, "SIGTERM");
    } catch {
      /* already dead */
    }
    killTimer = setTimeout(() => {
      try {
        signalChildProcessGroup(child, "SIGKILL");
      } catch {
        /* already dead */
      }
    }, 2000);
    killTimer.unref?.();
  };

  const armIdleTimer = () => {
    cancelIdleTimer?.();
    if (timeouts.idleTimeoutMs <= 0 || timeoutReason) return;
    cancelIdleTimer = scheduleLongTimeout(() => {
      if (checkPendingActivity?.()) {
        armIdleTimer();
        return;
      }
      terminate("idle");
    }, timeouts.idleTimeoutMs);
  };

  armIdleTimer();
  if (timeouts.maxRunTimeoutMs > 0) {
    cancelMaxRunTimer = scheduleLongTimeout(() => terminate("max_runtime"), timeouts.maxRunTimeoutMs);
  }

  const dispose = () => {
    cancelIdleTimer?.();
    cancelMaxRunTimer?.();
    if (killTimer) clearTimeout(killTimer);
  };

  return { touch: armIdleTimer, timeoutReason: () => timeoutReason, dispose };
}

function appendTimeoutNotice(
  stderr: string,
  reason: RunTimeoutReason,
  timeouts: { idleTimeoutMs: number; maxRunTimeoutMs: number },
): string {
  const notice =
    reason === "idle"
      ? `[ads] CLI 连续 ${timeouts.idleTimeoutMs}ms 无输出，已按空闲超时终止子进程。`
      : `[ads] CLI 运行超过最大时长 ${timeouts.maxRunTimeoutMs}ms，子进程已被终止。`;
  return stderr.trim() ? `${stderr}\n${notice}` : notice;
}

function createFileActivityTracker(paths: string[]): { check: () => boolean } {
  let previousSizes = paths.map((filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  });
  return {
    check: () => {
      const nextSizes = paths.map((filePath) => {
        try {
          return fs.statSync(filePath).size;
        } catch {
          return 0;
        }
      });
      const changed = nextSizes.some((size, index) => size !== previousSizes[index]);
      previousSizes = nextSizes;
      return changed;
    },
  };
}

function createFileActivityPoller(
  checkActivity: () => boolean,
  idleTimeoutMs: number,
  onActivity: () => void,
): { dispose: () => void } {
  if (idleTimeoutMs <= 0) return { dispose: () => {} };
  const pollIntervalMs = Math.max(25, Math.min(1000, Math.floor(idleTimeoutMs / 4)));
  const timer = setInterval(() => {
    if (checkActivity()) onActivity();
  }, pollIntervalMs);
  timer.unref?.();
  return { dispose: () => clearInterval(timer) };
}

const DEFAULT_POST_COMPLETION_GRACE_MS = 10_000;

/**
 * 解析完成宽限时长：显式传入优先，否则读 ADS_CLI_POST_COMPLETION_GRACE_MS，
 * 无效/未设置回退默认 10 秒。<=0 表示禁用。
 */
function resolvePostCompletionGraceMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.floor(explicit);
  }
  const raw = process.env.ADS_CLI_POST_COMPLETION_GRACE_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_POST_COMPLETION_GRACE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return DEFAULT_POST_COMPLETION_GRACE_MS;
  }
  return Math.floor(value);
}

/**
 * 完成宽限监视器：adapter 判定本轮已完成后启动一次性定时器，宽限内进程仍未
 * 退出则 SIGTERM 进程组（2 秒后升级 SIGKILL），并把这次终止标记为
 * "完成后终止"，让调用方不要把退出码当作失败。
 */
function createPostCompletionWatcher(
  child: ReturnType<typeof spawn>,
  graceMs: number,
): { onMaybeComplete: (isComplete: boolean) => void; terminated: () => boolean; dispose: () => void } {
  let armed = false;
  let terminated = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const onMaybeComplete = (isComplete: boolean) => {
    if (!isComplete || armed || graceMs <= 0) return;
    armed = true;
    graceTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      terminated = true;
      logger.warn(`[CliRunner] 子进程在本轮完成 ${graceMs}ms 后仍未退出，终止进程组以结束本轮`);
      try {
        signalChildProcessGroup(child, "SIGTERM");
      } catch {
        /* already dead */
      }
      killTimer = setTimeout(() => {
        try {
          signalChildProcessGroup(child, "SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2000);
      killTimer.unref?.();
    }, graceMs);
    graceTimer.unref?.();
  };

  const dispose = () => {
    if (graceTimer) clearTimeout(graceTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  return { onMaybeComplete, terminated: () => terminated, dispose };
}


function emitJsonLines(rawStdout: string, onLine: LineHandler): void {
  const lines = String(rawStdout ?? "").split("\n");
  for (const rawLine of lines) {
    const parsed = tryParseJsonLine(rawLine);
    if (parsed !== null) {
      onLine(parsed);
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
  const release = await cliExecutionGovernor.acquire(options.signal);
  try {
    return await runCliWithoutGovernor(options, onLine);
  } finally {
    release();
  }
}

async function runCliWithoutGovernor(
  options: CliRunOptions,
  onLine: LineHandler,
): Promise<CliRunResult> {
  if (!supportsPipedStdios()) {
    return await runCliViaFiles(options, onLine);
  }

  const { binary, args, cwd, env, unsetEnv, stdinData, signal } = options;
  const runTimeouts = resolveRunTimeouts(options);
  const outputMaxBytes = resolveOutputMaxBytes(options.maxOutputBytes);

  const child = spawn(binary, args, {
    cwd,
    env: buildSpawnEnv({ env, unsetEnv }),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });

  const abortHandler = attachAbortHandler(child, signal);
  const timeoutHandler = setupRunWatchdog(child, runTimeouts);
  const completionWatcher = createPostCompletionWatcher(
    child,
    options.isRunComplete ? resolvePostCompletionGraceMs(options.postCompletionGraceMs) : 0,
  );
  const spawnError = await waitForSpawn(child);

  if (spawnError) {
    abortHandler.dispose();
    timeoutHandler.dispose();
    completionWatcher.dispose();
    throw new Error(formatSpawnErrorHint(binary, spawnError));
  }

  if (child.stdin) {
    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  }

  const stderrBuffer = new TailByteBuffer(outputMaxBytes);
  child.stderr?.on("data", (chunk: Buffer) => {
    timeoutHandler.touch();
    stderrBuffer.append(chunk);
  });

  const rl = createInterface({ input: child.stdout! });
  child.stdout?.on("data", timeoutHandler.touch);
  const stdoutBuffer = new TailByteBuffer(outputMaxBytes);
  let hasStdoutLine = false;
  let loopError: unknown = null;
  try {
    for await (const rawLine of rl) {
      stdoutBuffer.append(`${hasStdoutLine ? "\n" : ""}${String(rawLine)}`);
      hasStdoutLine = true;
      if (abortHandler.isCancelled()) {
        child.stdout?.resume();
        break;
      }
      const parsed = tryParseJsonLine(rawLine);
      if (parsed !== null) {
        onLine(parsed);
        completionWatcher.onMaybeComplete(options.isRunComplete?.() === true);
      }
    }
  } catch (error) {
    // onLine 回调或 readline 抛错：终止子进程以避免孤儿进程。
    loopError = error;
    try {
      if (child.exitCode === null) signalChildProcessGroup(child, "SIGTERM");
    } catch {
      /* already dead */
    }
  } finally {
    rl.close();
  }

  if (loopError) {
    await terminateAndWaitForClose(child);
    abortHandler.dispose();
    timeoutHandler.dispose();
    completionWatcher.dispose();
    throw loopError instanceof Error ? loopError : new Error(String(loopError));
  }

  const exitCode = await waitForClose(child);

  const cancelled = abortHandler.isCancelled();
  const timeoutReason = timeoutHandler.timeoutReason();
  const terminatedAfterCompletion = completionWatcher.terminated();
  abortHandler.dispose();
  timeoutHandler.dispose();
  completionWatcher.dispose();

  let stderr = stderrBuffer.toString();
  if (timeoutReason) {
    stderr = appendTimeoutNotice(stderr, timeoutReason, runTimeouts);
  }

  return {
    exitCode,
    stdout: stdoutBuffer.toString(),
    stderr,
    cancelled,
    stdoutTruncated: stdoutBuffer.truncated,
    stderrTruncated: stderrBuffer.truncated,
    terminatedAfterCompletion,
  };
}

async function runCliViaFiles(
  options: CliRunOptions,
  onLine: LineHandler,
): Promise<CliRunResult> {
  const { binary, args, cwd, env, unsetEnv, stdinData, signal } = options;
  const runTimeouts = resolveRunTimeouts(options);
  const outputMaxBytes = resolveOutputMaxBytes(options.maxOutputBytes);

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
      env: buildSpawnEnv({ env, unsetEnv }),
      stdio: [stdinFd, stdoutFd, stderrFd],
      shell: false,
      detached: process.platform !== "win32",
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

  const abortHandler = attachAbortHandler(child, signal);
  const activityTracker = createFileActivityTracker([stdoutPath, stderrPath]);
  const timeoutHandler = setupRunWatchdog(child, runTimeouts, activityTracker.check);
  const activityPoller = createFileActivityPoller(
    activityTracker.check,
    runTimeouts.idleTimeoutMs,
    timeoutHandler.touch,
  );
  const spawnError = await waitForSpawn(child);

  if (spawnError) {
    abortHandler.dispose();
    timeoutHandler.dispose();
    activityPoller.dispose();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new Error(formatSpawnErrorHint(binary, spawnError));
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
    } else {
      child.on("close", (code) => resolve(code));
    }
  });

  const cancelled = abortHandler.isCancelled();
  const timeoutReason = timeoutHandler.timeoutReason();
  abortHandler.dispose();
  timeoutHandler.dispose();
  activityPoller.dispose();

  const stdoutResult = readFileLimited(stdoutPath, outputMaxBytes);
  const stderrResult = readFileLimited(stderrPath, outputMaxBytes);
  const stdout = stdoutResult.text;
  let stderr = stderrResult.text;
  if (timeoutReason) {
    stderr = appendTimeoutNotice(stderr, timeoutReason, runTimeouts);
  }

  try {
    emitJsonLines(stdout, onLine);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    cancelled,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    terminatedAfterCompletion: false,
  };
}

/**
 * 运行 CLI 命令，返回 stdout 的完整文本。
 * 用于不产生 JSONL 输出的简单命令。
 */
export async function runCliRaw(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const release = await cliExecutionGovernor.acquire();
  try {
    return await runCliRawWithoutGovernor(options);
  } finally {
    release();
  }
}

async function runCliRawWithoutGovernor(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (!supportsPipedStdios()) {
    return await runCliRawViaFiles(options);
  }

  const { binary, args, cwd, env, unsetEnv } = options;
  const outputMaxBytes = resolveOutputMaxBytes(options.maxOutputBytes);

  const child = spawn(binary, args, {
    cwd,
    env: buildSpawnEnv({ env, unsetEnv }),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });

  const spawnError = await waitForSpawn(child);

  if (spawnError) {
    throw new Error(formatSpawnErrorHint(binary, spawnError));
  }

  if (child.stdin) {
    child.stdin.end();
  }

  const stdoutBuffer = new TailByteBuffer(outputMaxBytes);
  const stderrBuffer = new TailByteBuffer(outputMaxBytes);
  child.stdout?.on("data", (chunk: Buffer) => stdoutBuffer.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrBuffer.append(chunk));

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  return {
    stdout: stdoutBuffer.toString(),
    stderr: stderrBuffer.toString(),
    exitCode,
  };
}

async function runCliRawViaFiles(
  options: Omit<CliRunOptions, "signal">,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { binary, args, cwd, env, unsetEnv, stdinData } = options;

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
      env: buildSpawnEnv({ env, unsetEnv }),
      stdio: [stdinFd, stdoutFd, stderrFd],
      shell: false,
      detached: process.platform !== "win32",
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

  const spawnError = await waitForSpawn(child);

  if (spawnError) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new Error(formatSpawnErrorHint(binary, spawnError));
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const outputMaxBytes = resolveOutputMaxBytes(options.maxOutputBytes);
  const stdout = readFileLimited(stdoutPath, outputMaxBytes).text;
  const stderr = readFileLimited(stderrPath, outputMaxBytes).text;

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return { stdout, stderr, exitCode };
}
