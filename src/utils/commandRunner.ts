import path from "node:path";
import { spawn } from "node:child_process";

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

  const executable = path.basename(cmd).toLowerCase();
  const allowlist = request.allowlist;
  if (allowlist && !allowlist.includes(executable)) {
    throw new Error(`command not allowed: ${executable}`);
  }

  const commandLine = [cmd, ...args].join(" ").trim();
  const startedAt = Date.now();

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
