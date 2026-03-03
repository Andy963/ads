import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { createAbortError } from "./abort.js";
import { parseCsv } from "./text.js";

const DEFAULT_MAX_OUTPUT_BYTES = 48 * 1024;
const ABORT_KILL_DELAY_MS = 1200;

interface ChildProcessExit {
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  timedOut: boolean;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function waitForChildProcess(args: {
  child: ChildProcess;
  timeoutMs: number;
  signal?: AbortSignal;
  startedAt: number;
}): Promise<ChildProcessExit> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let abortKillTimer: NodeJS.Timeout | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        args.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, args.timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (args.signal) {
        args.signal.removeEventListener("abort", onAbort);
      }
    };

    const clearAbortKillTimer = () => {
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
        abortKillTimer = null;
      }
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      timedOut = false;
      try {
        args.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      abortKillTimer = setTimeout(() => {
        try {
          args.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, ABORT_KILL_DELAY_MS);
      cleanup();
      reject(createAbortError());
    };

    if (args.signal) {
      if (args.signal.aborted) {
        onAbort();
        return;
      }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }

    args.child.on("error", (error) => {
      clearAbortKillTimer();
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(normalizeError(error));
    });

    args.child.on("close", (code, signalName) => {
      clearAbortKillTimer();
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      resolve({
        exitCode: typeof code === "number" ? code : null,
        signal: signalName ?? null,
        elapsedMs: Date.now() - args.startedAt,
        timedOut,
      });
    });
  });
}

export interface CommandRunRequest {
  cmd: string;
  args?: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  allowlist?: string[] | null;
}

export interface CommandRunResult {
  commandLine: string;
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
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

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export function isGitPushCommand(cmd: string, args: string[] = []): boolean {
  const executable = path.basename(cmd).toLowerCase();
  if (executable !== "git") return false;
  const first = String(args[0] ?? "").toLowerCase();
  return first === "push";
}

export function assertCommandAllowed(cmd: string, args: string[], allowlist: string[] | null | undefined): void {
  if (allowlist && hasPathSeparator(cmd)) {
    throw new Error(`command path is not allowed when allowlist is enabled: ${cmd}`);
  }

  const executable = path.basename(cmd).toLowerCase();
  if (allowlist && !allowlist.includes(executable)) {
    throw new Error(`command not allowed: ${executable}`);
  }

  if (isGitPushCommand(cmd, args)) {
    throw new Error("git push is blocked; push manually if needed");
  }
}

export function getExecAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.AGENT_EXEC_TOOL_ALLOWLIST;
  if (raw === undefined) {
    return null;
  }
  const parsed = parseCsv(raw)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) {
    return null;
  }
  if (parsed.includes("*") || parsed.includes("all")) {
    return null;
  }
  return parsed;
}

export async function runCommand(request: CommandRunRequest): Promise<CommandRunResult> {
  const cmd = String(request.cmd ?? "").trim();
  if (!cmd) {
    throw new Error("missing cmd");
  }
  const args = Array.isArray(request.args) ? request.args.map((arg) => String(arg)) : [];
  const cwd = request.cwd;
  const timeoutMs = Math.max(1, request.timeoutMs);
  const env = request.env ?? process.env;
  const maxOutputBytes = typeof request.maxOutputBytes === "number" && request.maxOutputBytes > 0
    ? Math.floor(request.maxOutputBytes)
    : DEFAULT_MAX_OUTPUT_BYTES;

  const allowlist = request.allowlist;
  assertCommandAllowed(cmd, args, allowlist);

  const commandLine = [cmd, ...args].join(" ").trim();
  const startedAt = Date.now();

  if (!supportsPipedStdios()) {
    return await runCommandViaFiles({ cmd, args, cwd, env, timeoutMs, signal: request.signal, maxOutputBytes, startedAt, commandLine });
  }

  const child = spawn(cmd, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let truncatedStdout = false;
  let truncatedStderr = false;

  const append = (target: Buffer, chunk: Buffer, kind: "stdout" | "stderr"): Buffer => {
    if (target.length >= maxOutputBytes) {
      if (kind === "stdout") truncatedStdout = true;
      if (kind === "stderr") truncatedStderr = true;
      return target;
    }
    const remaining = maxOutputBytes - target.length;
    if (chunk.length > remaining) {
      if (kind === "stdout") truncatedStdout = true;
      if (kind === "stderr") truncatedStderr = true;
      return Buffer.concat([target, chunk.subarray(0, remaining)]);
    }
    return Buffer.concat([target, chunk]);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk, "stdout");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk, "stderr");
  });

  const exit = await waitForChildProcess({ child, timeoutMs, signal: request.signal, startedAt });

  return {
    commandLine,
    exitCode: exit.exitCode,
    signal: exit.signal,
    elapsedMs: exit.elapsedMs,
    timedOut: exit.timedOut,
    stdout: stdout.toString("utf8").trimEnd(),
    stderr: stderr.toString("utf8").trimEnd(),
    truncatedStdout,
    truncatedStderr,
  };
}

async function runCommandViaFiles(args: {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
  startedAt: number;
  commandLine: string;
}): Promise<CommandRunResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-runcommand-"));
  const stdoutPath = path.join(tmpDir, "stdout.txt");
  const stderrPath = path.join(tmpDir, "stderr.txt");

  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");

  let child: ChildProcess;
  try {
    child = spawn(args.cmd, args.args, {
      cwd: args.cwd,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: args.env,
    });
  } finally {
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

  const maxOutputBytes = args.maxOutputBytes;

  const readLimited = (filePath: string): { text: string; truncated: boolean } => {
    try {
      const stat = fs.statSync(filePath);
      const size = typeof stat.size === "number" && Number.isFinite(stat.size) ? stat.size : 0;
      const truncated = size > maxOutputBytes;
      const toRead = Math.max(0, Math.min(size, maxOutputBytes));
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
        return { text: buf.subarray(0, bytesRead).toString("utf8").trimEnd(), truncated };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { text: "", truncated: false };
    }
  };

  let tmpDirRemoved = false;
  try {
    const exit = await waitForChildProcess({
      child,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
      startedAt: args.startedAt,
    });

    const stdout = readLimited(stdoutPath);
    const stderr = readLimited(stderrPath);

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDirRemoved = true;
    } catch {
      // ignore
    }

    return {
      commandLine: args.commandLine,
      exitCode: exit.exitCode,
      signal: exit.signal,
      elapsedMs: exit.elapsedMs,
      timedOut: exit.timedOut,
      stdout: stdout.text,
      stderr: stderr.text,
      truncatedStdout: stdout.truncated,
      truncatedStderr: stderr.truncated,
    };
  } catch (error) {
    throw normalizeError(error);
  } finally {
    if (!tmpDirRemoved) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
