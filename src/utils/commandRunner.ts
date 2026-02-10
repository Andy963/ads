import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 48 * 1024;

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

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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
  if (allowlist && hasPathSeparator(cmd)) {
    throw new Error(`command path is not allowed when allowlist is enabled: ${cmd}`);
  }

  const executable = path.basename(cmd).toLowerCase();
  if (allowlist && !allowlist.includes(executable)) {
    throw new Error(`command not allowed: ${executable}`);
  }

  if (executable === "git" && args.length > 0 && args[0].toLowerCase() === "push") {
    throw new Error("git push is blocked; push manually if needed");
  }

  const commandLine = [cmd, ...args].join(" ").trim();
  const startedAt = Date.now();

  if (!supportsPipedStdios()) {
    return await runCommandViaFiles({ cmd, args, cwd, env, timeoutMs, signal: request.signal, maxOutputBytes, startedAt, commandLine });
  }

  return await new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const signal = request.signal;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;
    let settled = false;
    let abortKillTimer: NodeJS.Timeout | null = null;

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

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      timedOut = false;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      abortKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1200);
      cleanup();
      const abortError = new Error("AbortError");
      abortError.name = "AbortError";
      reject(abortError);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk, "stderr");
    });

    child.on("error", (error) => {
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
        abortKillTimer = null;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, signalName) => {
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
        abortKillTimer = null;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      resolve({
        commandLine,
        exitCode: typeof code === "number" ? code : null,
        signal: signalName ?? null,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        stdout: stdout.toString("utf8").trimEnd(),
        stderr: stderr.toString("utf8").trimEnd(),
        truncatedStdout,
        truncatedStderr,
      });
    });
  });
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

  let child;
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

  const startedAt = args.startedAt;
  const timeoutMs = args.timeoutMs;
  const maxOutputBytes = args.maxOutputBytes;
  const signal = args.signal;

  let timedOut = false;
  let settled = false;
  let abortKillTimer: NodeJS.Timeout | null = null;

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const onAbort = () => {
    if (settled) {
      return;
    }
    settled = true;
    timedOut = false;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    abortKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1200);
    cleanup();
    const abortError = new Error("AbortError");
    abortError.name = "AbortError";
    rejectPromise(abortError);
  };

  let rejectPromise: (error: Error) => void = () => {};
  const resultPromise = new Promise<CommandRunResult>((resolve, reject) => {
    rejectPromise = (error: Error) => reject(error);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
        abortKillTimer = null;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (code, signalName) => {
      if (abortKillTimer) {
        clearTimeout(abortKillTimer);
        abortKillTimer = null;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

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

      const stdout = readLimited(stdoutPath);
      const stderr = readLimited(stderrPath);

      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }

      resolve({
        commandLine: args.commandLine,
        exitCode: typeof code === "number" ? code : null,
        signal: signalName ?? null,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        stdout: stdout.text,
        stderr: stderr.text,
        truncatedStdout: stdout.truncated,
        truncatedStderr: stderr.truncated,
      });
    });
  });

  try {
    return await resultPromise;
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}
