import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { getExecAllowlistFromEnv, runCommand } from "../../utils/commandRunner.js";

import type { CommandRunRequest, CommandRunResult } from "../../utils/commandRunner.js";

import type { ManagedServiceSpec, UiSmokeSpec, UiSmokeStep, VerificationCommand, VerificationSpec } from "./schemas.js";

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
  suite?: string;
  notes?: string[];
}

export interface VerificationReport {
  enabled: boolean;
  results: VerificationResult[];
}

export interface VerificationRunnerDeps {
  runCommand?: (request: CommandRunRequest) => Promise<CommandRunResult>;
  getExecAllowlistFromEnv?: (env?: NodeJS.ProcessEnv) => string[] | null;
  fetch?: typeof fetch;
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

type AssertionsSpec = Pick<VerificationCommand, "assertContains" | "assertNotContains" | "assertRegex">;

function checkAssertions(command: AssertionsSpec, stdout: string, stderr: string): { ok: boolean; notes: string[] } {
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

function createSuiteLabel(uiSmoke: UiSmokeSpec, index: number): string {
  const name = String(uiSmoke.name ?? "").trim();
  if (name) return name;
  return `ui_smoke_${index + 1}`;
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withAgentBrowserEnv(parentEnv: NodeJS.ProcessEnv, suite: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };

  // Do not trust inherited values here: in sandboxed environments the default runtime dir
  // (e.g. /run/user/<uid>) can be non-writable and breaks agent-browser daemon startup.
  const base = createTempDir("ads-agent-browser-");
  const resolved = path.join(base, "sock");
  ensureDirSync(resolved);
  env.AGENT_BROWSER_SOCKET_DIR = resolved;

  env.AGENT_BROWSER_SESSION = `ads-ui-smoke-${suite}-${crypto.randomBytes(6).toString("hex")}`;

  const browsersPath = String(env.PLAYWRIGHT_BROWSERS_PATH ?? "").trim();
  if (!browsersPath) {
    const fallback = path.join(os.tmpdir(), "ms-playwright");
    ensureDirSync(fallback);
    env.PLAYWRIGHT_BROWSERS_PATH = fallback;
  }

  if (!String(env.NPM_CONFIG_CACHE ?? "").trim()) {
    const cacheDir = path.join(os.tmpdir(), "npm-cache");
    ensureDirSync(cacheDir);
    env.NPM_CONFIG_CACHE = cacheDir;
  }

  return env;
}

async function waitForReadyUrl(
  url: string,
  timeoutMs: number,
  deps: Pick<Required<VerificationRunnerDeps>, "fetch">,
  options: { signal?: AbortSignal; isServiceExited?: () => boolean },
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const startedAt = Date.now();
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));

  while (Date.now() - startedAt < normalizedTimeoutMs) {
    if (options.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }
    if (options.isServiceExited?.()) {
      return { ok: false, error: "service exited before ready" };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await deps.fetch(url, { signal: controller.signal });
        if (response.ok) {
          return { ok: true, status: response.status };
        }
        // Non-2xx: keep retrying until timeout.
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // ignore transient network errors
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { ok: false, error: `timeout after ${normalizedTimeoutMs}ms` };
}

function truncateOutput(text: string, maxChars: number): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function collectChildOutput(child: ReturnType<typeof spawn>, maxBytes: number): { getStdout: () => string; getStderr: () => string } {
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  const append = (target: Buffer<ArrayBufferLike>, chunk: Buffer): Buffer<ArrayBufferLike> => {
    if (target.length >= maxBytes) return target;
    const remaining = maxBytes - target.length;
    if (chunk.length > remaining) {
      return Buffer.concat([target, chunk.subarray(0, remaining)]);
    }
    return Buffer.concat([target, chunk]);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  return {
    getStdout: () => stdout.toString("utf8").trimEnd(),
    getStderr: () => stderr.toString("utf8").trimEnd(),
  };
}

async function stopService(
  child: ReturnType<typeof spawn> | null,
  options: { graceMs: number },
): Promise<void> {
  if (!child) return;
  if (child.exitCode !== null) return;

  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }

  const deadline = Date.now() + Math.max(1, options.graceMs);
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (child.exitCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

async function runUiSmokeSuite(
  uiSmoke: UiSmokeSpec,
  index: number,
  context: { cwd: string; allowlist: string[] | null; signal?: AbortSignal; baseEnv: NodeJS.ProcessEnv },
  deps: Required<Pick<VerificationRunnerDeps, "runCommand" | "fetch">>,
): Promise<VerificationResult[]> {
  const suite = createSuiteLabel(uiSmoke, index);
  const env = withAgentBrowserEnv(context.baseEnv, suite);
  const results: VerificationResult[] = [];

  const artifactsDir = createTempDir(`ads-ui-smoke-${suite}-`);
  const safeClose = async () => {
    try {
      await deps.runCommand({
        cmd: "agent-browser",
        args: ["close"],
        cwd: context.cwd,
        timeoutMs: 15_000,
        signal: context.signal,
        allowlist: context.allowlist,
        env,
      });
    } catch {
      // ignore
    }
  };

  let serviceChild: ReturnType<typeof spawn> | null = null;
  let serviceOutput: { getStdout: () => string; getStderr: () => string } | null = null;

  try {
    if (uiSmoke.service) {
      const svc: ManagedServiceSpec = uiSmoke.service;
      const cmd = String(svc.cmd ?? "").trim();
      const args = Array.isArray(svc.args) ? svc.args.map((a) => String(a)) : [];
      const svcCwd = svc.cwd ? path.resolve(context.cwd, svc.cwd) : context.cwd;
      const svcEnv: NodeJS.ProcessEnv = { ...env, ...(svc.env ?? {}) };

      const startedAt = Date.now();
      serviceChild = spawn(cmd, args, {
        cwd: svcCwd,
        env: svcEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      serviceOutput = collectChildOutput(serviceChild, 24 * 1024);

      const readyTimeoutMs =
        typeof svc.readyTimeoutMs === "number" && Number.isFinite(svc.readyTimeoutMs) && svc.readyTimeoutMs > 0
          ? Math.floor(svc.readyTimeoutMs)
          : 30_000;

      const ready = await waitForReadyUrl(
        svc.readyUrl,
        readyTimeoutMs,
        deps,
        {
          signal: context.signal,
          isServiceExited: () => serviceChild?.exitCode !== null,
        },
      );

      results.push({
        cmd,
        args,
        ok: ready.ok,
        expectedExitCode: 0,
        exitCode: serviceChild.exitCode,
        signal: serviceChild.signalCode ?? null,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        stdout: serviceOutput?.getStdout() ?? "",
        stderr: serviceOutput?.getStderr() ?? "",
        suite,
        notes: ready.ok
          ? [`readyUrl ok: ${svc.readyUrl}${ready.status ? ` (status=${ready.status})` : ""}`]
          : [`readyUrl failed: ${svc.readyUrl}${ready.error ? ` (${ready.error})` : ""}`],
      });

      if (!ready.ok) {
        return results;
      }
    }

    for (let stepIndex = 0; stepIndex < (uiSmoke.steps?.length ?? 0); stepIndex += 1) {
      const step: UiSmokeStep = uiSmoke.steps[stepIndex]!;
      const args = Array.isArray(step.args) ? step.args.map((a) => String(a)) : [];
      const timeoutMs =
        typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs) && step.timeoutMs > 0
          ? Math.floor(step.timeoutMs)
          : 60_000;
      const expectedExitCode =
        typeof step.expectExitCode === "number" && Number.isFinite(step.expectExitCode)
          ? Math.floor(step.expectExitCode)
          : 0;

      let run: CommandRunResult;
      try {
        run = await deps.runCommand({
          cmd: "agent-browser",
          args,
          cwd: context.cwd,
          timeoutMs,
          signal: context.signal,
          allowlist: context.allowlist,
          env,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          cmd: "agent-browser",
          args,
          ok: false,
          expectedExitCode,
          exitCode: null,
          signal: null,
          elapsedMs: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          suite,
          notes: [`failed to run agent-browser: ${message}`],
        });
        break;
      }

      const exitOk = run.exitCode === expectedExitCode && !run.timedOut;
      const assertions = checkAssertions(step, run.stdout, run.stderr);
      const ok = exitOk && assertions.ok;
      const notes: string[] = [...assertions.notes];

      if (!ok) {
        const screenshotPath = path.join(artifactsDir, `failure-step-${stepIndex + 1}.png`);
        try {
          await deps.runCommand({
            cmd: "agent-browser",
            args: ["screenshot", screenshotPath],
            cwd: context.cwd,
            timeoutMs: 20_000,
            signal: context.signal,
            allowlist: context.allowlist,
            env,
          });
          notes.push(`artifact screenshot: ${screenshotPath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notes.push(`failed to capture screenshot: ${message}`);
        }

        try {
          const errors = await deps.runCommand({
            cmd: "agent-browser",
            args: ["errors"],
            cwd: context.cwd,
            timeoutMs: 10_000,
            signal: context.signal,
            allowlist: context.allowlist,
            env,
            maxOutputBytes: 48 * 1024,
          });
          const pageErrors = truncateOutput(errors.stdout || errors.stderr, 1200);
          if (pageErrors) {
            notes.push(`page errors: ${pageErrors}`);
          }
        } catch {
          // ignore
        }
      }

      results.push({
        cmd: "agent-browser",
        args,
        ok,
        expectedExitCode,
        exitCode: run.exitCode,
        signal: run.signal,
        elapsedMs: run.elapsedMs,
        timedOut: run.timedOut,
        stdout: run.stdout,
        stderr: run.stderr,
        suite,
        notes: notes.length ? notes : undefined,
      });

      if (!ok) {
        break;
      }
    }
  } finally {
    await safeClose();
    const graceMs =
      typeof uiSmoke.service?.shutdownGraceMs === "number" && Number.isFinite(uiSmoke.service.shutdownGraceMs) && uiSmoke.service.shutdownGraceMs > 0
        ? Math.floor(uiSmoke.service.shutdownGraceMs)
        : 2_500;
    await stopService(serviceChild, { graceMs });
  }

  return results;
}

export async function runVerification(
  spec: VerificationSpec,
  options: { cwd: string; signal?: AbortSignal },
  deps: VerificationRunnerDeps = {},
): Promise<VerificationReport> {
  if (!isVerificationEnabled()) {
    return { enabled: false, results: [] };
  }

  const cwd = path.resolve(options.cwd);
  const resolvedDeps: Required<Pick<VerificationRunnerDeps, "runCommand" | "getExecAllowlistFromEnv" | "fetch">> = {
    runCommand: deps.runCommand ?? runCommand,
    getExecAllowlistFromEnv: deps.getExecAllowlistFromEnv ?? getExecAllowlistFromEnv,
    fetch: deps.fetch ?? fetch,
  };

  const allowlist = resolvedDeps.getExecAllowlistFromEnv();
  const results: VerificationResult[] = [];

  const commands = spec.commands ?? [];
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
      const run = await resolvedDeps.runCommand({
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

  const uiSmokes = spec.uiSmokes ?? [];
  for (let i = 0; i < uiSmokes.length; i += 1) {
    const uiSmoke = uiSmokes[i]!;
    const uiResults = await runUiSmokeSuite(
      uiSmoke,
      i,
      { cwd, allowlist, signal: options.signal, baseEnv: process.env },
      { runCommand: resolvedDeps.runCommand, fetch: resolvedDeps.fetch },
    );
    results.push(...uiResults);
  }

  return { enabled: true, results };
}
