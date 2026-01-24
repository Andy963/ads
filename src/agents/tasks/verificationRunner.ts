import path from "node:path";

import { getExecAllowlistFromEnv, runCommand } from "../../utils/commandRunner.js";

import type { VerificationCommand } from "./schemas.js";

export interface VerificationResult {
  cmd: string;
  args: string[];
  ok: boolean;
  expectedExitCode: number;
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  notes?: string[];
}

export interface VerificationReport {
  enabled: boolean;
  results: VerificationResult[];
}

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isVerificationEnabled(): boolean {
  const enabled = parseBoolean(process.env.ADS_TASK_VERIFICATION_ENABLED, true);
  if (!enabled) {
    return false;
  }
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, true);
}

function stringifyCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ").trim();
}

function buildOutputForAssertions(stdout: string, stderr: string): string {
  return [stdout ?? "", stderr ?? ""].join("\n").trim();
}

function checkAssertions(command: VerificationCommand, stdout: string, stderr: string): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const output = buildOutputForAssertions(stdout, stderr);

  const contains = command.assertContains ?? [];
  for (const needle of contains) {
    if (!output.includes(needle)) {
      notes.push(`missing required output: ${needle}`);
    }
  }

  const notContains = command.assertNotContains ?? [];
  for (const needle of notContains) {
    if (output.includes(needle)) {
      notes.push(`output must not contain: ${needle}`);
    }
  }

  const regexes = command.assertRegex ?? [];
  for (const pattern of regexes) {
    try {
      const re = new RegExp(pattern);
      if (!re.test(output)) {
        notes.push(`output does not match regex: ${pattern}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`invalid regex "${pattern}": ${message}`);
    }
  }

  return { ok: notes.length === 0, notes };
}

export async function runVerification(
  commands: VerificationCommand[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<VerificationReport> {
  if (!isVerificationEnabled()) {
    return { enabled: false, results: [] };
  }

  const cwd = path.resolve(options.cwd);
  const allowlist = getExecAllowlistFromEnv();
  const results: VerificationResult[] = [];

  for (const command of commands) {
    const cmd = String(command.cmd ?? "").trim();
    const args = Array.isArray(command.args) ? command.args.map((arg) => String(arg)) : [];
    const timeoutMs =
      typeof command.timeoutMs === "number" && Number.isFinite(command.timeoutMs) && command.timeoutMs > 0
        ? Math.floor(command.timeoutMs)
        : 5 * 60 * 1000;
    const expectedExitCode =
      typeof command.expectExitCode === "number" && Number.isFinite(command.expectExitCode)
        ? Math.floor(command.expectExitCode)
        : 0;

    if (!cmd) {
      results.push({
        cmd,
        args,
        ok: false,
        expectedExitCode,
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        notes: ["missing cmd"],
      });
      continue;
    }

    const executable = path.basename(cmd).toLowerCase();
    if (allowlist && !allowlist.includes(executable)) {
      results.push({
        cmd,
        args,
        ok: false,
        expectedExitCode,
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        notes: [`command not allowlisted: ${executable}`],
      });
      continue;
    }

    try {
      const run = await runCommand({
        cmd,
        args,
        cwd,
        timeoutMs,
        signal: options.signal,
        allowlist,
      });

      const exitOk = run.exitCode === expectedExitCode && !run.timedOut;
      const assertions = checkAssertions(command, run.stdout, run.stderr);
      const ok = exitOk && assertions.ok;
      const notes = assertions.notes;

      results.push({
        cmd,
        args,
        ok,
        expectedExitCode,
        exitCode: run.exitCode,
        signal: run.signal,
        elapsedMs: run.elapsedMs,
        timedOut: run.timedOut,
        stdout: run.stdout,
        stderr: run.stderr,
        notes: notes.length ? notes : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        cmd,
        args,
        ok: false,
        expectedExitCode,
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        notes: [`failed to run ${stringifyCommand(cmd, args)}: ${message}`],
      });
    }
  }

  return { enabled: true, results };
}

