import path from "node:path";

import { getExecAllowlistFromEnv, runCommand as runHostCommand } from "../utils/commandRunner.js";
import type { CommandRunRequest, CommandRunResult } from "../utils/commandRunner.js";
import type { BootstrapSandbox } from "./sandbox.js";

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isGitPush(cmd: string, args: string[]): boolean {
  const executable = path.basename(cmd).toLowerCase();
  if (executable !== "git") return false;
  const first = String(args[0] ?? "").toLowerCase();
  return first === "push";
}

function normalizeAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | null {
  return getExecAllowlistFromEnv(env);
}

function assertAllowlisted(cmd: string, allowlist: string[] | null): void {
  if (!allowlist) {
    return;
  }
  if (hasPathSeparator(cmd)) {
    // Keep parity with src/utils/commandRunner.ts: disallow path-based execution when allowlist is enabled.
    throw new Error(`command path is not allowed when allowlist is enabled: ${cmd}`);
  }
  const executable = path.basename(cmd).toLowerCase();
  if (!allowlist.includes(executable)) {
    throw new Error(`command not allowed: ${executable}`);
  }
}

export function createBootstrapRunCommand(options: { sandbox: BootstrapSandbox; maxOutputBytes?: number; env?: NodeJS.ProcessEnv }): {
  runCommand: (request: CommandRunRequest) => Promise<CommandRunResult>;
  getExecAllowlistFromEnv: (env?: NodeJS.ProcessEnv) => string[] | null;
} {
  const maxOutputBytes = typeof options.maxOutputBytes === "number" && options.maxOutputBytes > 0 ? Math.floor(options.maxOutputBytes) : 1024 * 1024;

  const getAllowlist = (env?: NodeJS.ProcessEnv): string[] | null => normalizeAllowlist(env ?? options.env ?? process.env);

  const runCommand = async (request: CommandRunRequest): Promise<CommandRunResult> => {
    const cmd = String(request.cmd ?? "").trim();
    const args = Array.isArray(request.args) ? request.args.map((a) => String(a)) : [];
    const allowlist = request.allowlist ?? getAllowlist(request.env ?? options.env);

    if (isGitPush(cmd, args)) {
      throw new Error("git push is blocked; push manually if needed");
    }

    // When running under a sandbox wrapper, the underlying runCommand() allowlist applies to the wrapper binary only.
    // Enforce the allowlist for the requested command explicitly.
    assertAllowlisted(cmd, allowlist);

    const wrapped = options.sandbox.wrapSpawn({ cmd, args, cwd: request.cwd, env: request.env ?? options.env });
    return await runHostCommand({
      cmd: wrapped.cmd,
      args: wrapped.args,
      cwd: wrapped.cwd,
      env: wrapped.env,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      maxOutputBytes: request.maxOutputBytes ?? maxOutputBytes,
      allowlist: null,
    });
  };

  return {
    runCommand,
    getExecAllowlistFromEnv: getAllowlist,
  };
}

