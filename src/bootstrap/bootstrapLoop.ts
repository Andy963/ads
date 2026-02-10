import fs from "node:fs";
import path from "node:path";

import { runVerification } from "../agents/tasks/verificationRunner.js";
import type { VerificationReport } from "../agents/tasks/verificationRunner.js";
import { createLogger, type Logger } from "../utils/logger.js";

import { createBootstrapRunCommand } from "./commandRunner.js";
import { BootstrapArtifactStore } from "./artifacts.js";
import type { BootstrapAgentRunner, BootstrapAgentFeedback } from "./agentRunner.js";
import { BwrapSandbox, NoopSandbox, type BootstrapSandbox } from "./sandbox.js";
import { stageSafeBootstrapChanges, commitBootstrapChanges } from "./gitCommitter.js";
import { resolveBootstrapRecipe } from "./recipeResolver.js";
import {
  normalizeBootstrapRunSpec,
  type BootstrapIterationOutcome,
  type BootstrapIterationProgress,
  type BootstrapLoopHooks,
  type BootstrapRunContext,
  type BootstrapRunResult,
  type BootstrapRunSpec,
} from "./types.js";
import { prepareBootstrapWorktree } from "./worktree.js";

const DEFAULT_LOGGER = createLogger("BootstrapLoop");

function summarizeReport(report: VerificationReport | null): { ok: boolean; summary: string; signature: string } {
  if (!report) {
    return { ok: true, summary: "(skipped)", signature: "skipped" };
  }
  if (!report.enabled) {
    return { ok: false, summary: "verification disabled", signature: "disabled" };
  }
  const failed = (report.results ?? []).find((r) => !r.ok) ?? null;
  if (!failed) {
    return { ok: true, summary: "ok", signature: "ok" };
  }
  const stderrLine = (failed.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const args = Array.isArray(failed.args) ? failed.args.join(" ") : "";
  const summary = `${failed.cmd} ${args}`.trim() + (stderrLine ? `\n${stderrLine}` : "");
  const signature = `${failed.cmd}|${args}|exit=${failed.exitCode ?? "null"}|notes=${(failed.notes ?? []).join(",")}|stderr=${stderrLine}`;
  return { ok: false, summary, signature };
}

async function runStep(
  name: "install" | "lint" | "test",
  commands: Array<{ cmd: string; args?: string[]; timeoutMs?: number }>,
  ctx: { worktreeDir: string; signal?: AbortSignal; runCommand: ReturnType<typeof createBootstrapRunCommand>["runCommand"]; getExecAllowlistFromEnv: ReturnType<typeof createBootstrapRunCommand>["getExecAllowlistFromEnv"] },
): Promise<VerificationReport> {
  const report = await runVerification(
    { commands, uiSmokes: [] },
    { cwd: ctx.worktreeDir, signal: ctx.signal },
    { runCommand: ctx.runCommand, getExecAllowlistFromEnv: ctx.getExecAllowlistFromEnv },
  );
  if (!report.enabled) {
    throw new Error(`${name} verification is disabled`);
  }
  return report;
}

function shouldReinstall(changedFiles: string[]): boolean {
  const markers = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "requirements.txt",
  ]);
  return changedFiles.some((p) => markers.has(path.posix.basename(String(p ?? "").replace(/\\/g, "/"))));
}

function isInstallFailed(report: VerificationReport | null): boolean {
  if (!report || !report.enabled) return false;
  return (report.results ?? []).some((r) => !r.ok);
}

function cleanDeps(worktreeDir: string): void {
  const targets = ["node_modules", ".venv", ".pytest_cache", ".mypy_cache", "__pycache__"];
  for (const rel of targets) {
    const abs = path.join(worktreeDir, rel);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function gitDiffPatch(worktreeDir: string, runCommand: ReturnType<typeof createBootstrapRunCommand>["runCommand"]): Promise<string> {
  const res = await runCommand({
    cmd: "git",
    args: ["diff"],
    cwd: worktreeDir,
    timeoutMs: 60_000,
    maxOutputBytes: 5 * 1024 * 1024,
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git diff exited with code ${res.exitCode}`);
  }
  return res.stdout;
}

async function gitChangedFiles(worktreeDir: string, runCommand: ReturnType<typeof createBootstrapRunCommand>["runCommand"]): Promise<string[]> {
  const res = await runCommand({
    cmd: "git",
    args: ["diff", "--name-only"],
    cwd: worktreeDir,
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `git diff --name-only exited with code ${res.exitCode}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildDiffSummary(changedFiles: string[], patch: string): string {
  const files = changedFiles.slice(0, 50);
  const header = files.length ? `Files changed (${files.length}):\n${files.map((f) => `- ${f}`).join("\n")}` : "No files changed.";
  const snippet = patch.trim() ? patch.trim().split("\n").slice(0, 60).join("\n") : "";
  return snippet ? `${header}\n\nPatch snippet:\n${snippet}` : header;
}

export async function runBootstrapLoop(
  rawSpec: Partial<BootstrapRunSpec> & Pick<BootstrapRunSpec, "project" | "goal">,
  deps: {
    agentRunner: BootstrapAgentRunner;
    logger?: Logger;
    signal?: AbortSignal;
    stateDir?: string;
    hooks?: BootstrapLoopHooks;
  },
): Promise<BootstrapRunResult> {
  const logger = deps.logger ?? DEFAULT_LOGGER;
  const spec = normalizeBootstrapRunSpec(rawSpec);

  const startedAt = new Date().toISOString();
  const worktree = await prepareBootstrapWorktree({
    project: spec.project,
    branchPrefix: spec.worktree.branchPrefix,
    stateDir: deps.stateDir,
  });

  const runCtx: BootstrapRunContext = {
    projectId: worktree.projectId,
    runId: worktree.runId,
    bootstrapRoot: worktree.bootstrapRoot,
    repoDir: worktree.repoDir,
    worktreeDir: worktree.worktreeDir,
    artifactsDir: worktree.artifactsDir,
    branchName: worktree.branchName,
  };

  const sandbox: BootstrapSandbox = (() => {
    if (spec.sandbox.backend === "none") {
      if (spec.requireHardSandbox) {
        throw new Error("hard sandbox is required but sandbox.backend is none");
      }
      return new NoopSandbox();
    }
    return new BwrapSandbox({
      rootDir: worktree.bootstrapRoot,
      worktreeDir: worktree.worktreeDir,
      allowNetwork: spec.allowNetwork,
    });
  })();
  sandbox.ensureAvailable();

  const recipe = spec.recipe ?? (() => {
    const resolved = resolveBootstrapRecipe(worktree.worktreeDir);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    return resolved.recipe;
  })();

  if (deps.hooks?.onStarted) {
    try {
      await deps.hooks.onStarted(runCtx, { spec, recipe });
    } catch {
      // ignore hook failures
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...(recipe.env ?? {}) };
  const runner = createBootstrapRunCommand({ sandbox, env, maxOutputBytes: 1024 * 1024 });
  const artifacts = new BootstrapArtifactStore(worktree.artifactsDir);

  const strategyLog: string[] = [];
  const outcomes: BootstrapIterationOutcome[] = [];

  let strategy: BootstrapIterationOutcome["strategy"] = "normal_fix";
  let strategyChanges = 0;
  let sameFailureStreak = 0;
  let lastSignature = "";

  const installOnce = async (): Promise<VerificationReport | null> => {
    if (!spec.allowInstallDeps) {
      return null;
    }
    if (!recipe.install || recipe.install.length === 0) {
      return { enabled: true, results: [] };
    }
    return await runStep("install", recipe.install, { worktreeDir: worktree.worktreeDir, signal: deps.signal, runCommand: runner.runCommand, getExecAllowlistFromEnv: runner.getExecAllowlistFromEnv });
  };

  let lastInstallReport: VerificationReport | null = await installOnce();

  try {
    for (let iteration = 1; iteration <= spec.maxIterations; iteration += 1) {
      if (deps.signal?.aborted) {
        throw new Error("AbortError");
      }

      const feedback: BootstrapAgentFeedback | null = (() => {
        const last = outcomes[outcomes.length - 1];
        if (!last) return null;
        const lint = summarizeReport(last.lintReport);
        const test = summarizeReport(last.testReport);
        const diffSummary = last.diffPatchPath
          ? (() => {
              try {
                return fs.readFileSync(last.diffPatchPath, "utf8").trim();
              } catch {
                return "";
              }
            })()
          : "";
        return {
          iteration: last.iteration,
          lintSummary: lint.summary,
          testSummary: test.summary,
          diffSummary,
        };
      })();

      if (feedback && strategy !== "normal_fix") {
        feedback.diffSummary += `\n\n[Strategy: ${strategy}${strategy === "clean_deps" ? " — dependencies were cleaned and reinstalled" : " — agent context was reset"}]`;
      }

      try {
        await deps.agentRunner.runIteration({ iteration, goal: spec.goal, cwd: worktree.worktreeDir, feedback, signal: deps.signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[Bootstrap] agent iteration failed iter=${iteration} err=${message}`);
        try {
          const errPath = path.join(artifacts.iterationDir(iteration), "agent_error.txt");
          fs.mkdirSync(path.dirname(errPath), { recursive: true });
          fs.writeFileSync(errPath, message, "utf8");
        } catch {
          // ignore
        }
      }

      const changedFilesQuick = await gitChangedFiles(worktree.worktreeDir, runner.runCommand);

      if (spec.allowInstallDeps && shouldReinstall(changedFilesQuick)) {
        logger.info(`[Bootstrap] dependency markers changed; reinstalling (iter=${iteration})`);
        lastInstallReport = await installOnce();
      }

      const patch = await gitDiffPatch(worktree.worktreeDir, runner.runCommand);
      const diffPatchPath = patch.trim() ? artifacts.writeDiffPatch(iteration, patch) : null;
      const changedFiles = await gitChangedFiles(worktree.worktreeDir, runner.runCommand);

      let lintReport: VerificationReport | null = null;
      let lintSummary: { ok: boolean; summary: string; signature: string };
      let testReport: VerificationReport | null = null;
      let testSummary: { ok: boolean; summary: string; signature: string };

      if (isInstallFailed(lastInstallReport)) {
        lintReport = null;
        lintSummary = { ok: false, summary: "skipped (install failed)", signature: "install_failed" };
        testReport = null;
        testSummary = { ok: false, summary: "skipped (install failed)", signature: "install_failed" };
      } else {
        lintReport = await runStep("lint", recipe.lint, {
          worktreeDir: worktree.worktreeDir,
          signal: deps.signal,
          runCommand: runner.runCommand,
          getExecAllowlistFromEnv: runner.getExecAllowlistFromEnv,
        });
        lintSummary = summarizeReport(lintReport);

        testReport = lintSummary.ok
          ? await runStep("test", recipe.test, {
              worktreeDir: worktree.worktreeDir,
              signal: deps.signal,
              runCommand: runner.runCommand,
              getExecAllowlistFromEnv: runner.getExecAllowlistFromEnv,
            })
          : null;
        testSummary = summarizeReport(testReport);
      }

      const ok = lintSummary.ok && testSummary.ok;

      const signature = `${lintSummary.signature}::${testSummary.signature}`;
      if (signature === lastSignature) {
        sameFailureStreak += 1;
      } else {
        lastSignature = signature;
        sameFailureStreak = 1;
      }

      const diffSummary = buildDiffSummary(changedFiles, patch);

      if (!ok) {
        if (patch.trim().length === 0) {
          sameFailureStreak = Math.max(sameFailureStreak, 2);
        }

        if (sameFailureStreak >= 2 && strategy === "normal_fix") {
          strategy = "clean_deps";
          strategyChanges += 1;
          strategyLog.push(`iter=${iteration} strategy=clean_deps reason=same_failure_streak:${sameFailureStreak}`);
          cleanDeps(worktree.worktreeDir);
          lastInstallReport = await installOnce();
        } else if (sameFailureStreak >= 3 && strategy !== "restart_agent") {
          strategy = "restart_agent";
          strategyChanges += 1;
          strategyLog.push(`iter=${iteration} strategy=restart_agent reason=same_failure_streak:${sameFailureStreak}`);
          await deps.agentRunner.reset();
        }
      }

      const outcome: BootstrapIterationOutcome = {
        iteration,
        diffPatchPath,
        installReport: lastInstallReport,
        lintReport,
        testReport,
        ok,
        strategy,
      };
      outcomes.push(outcome);
      artifacts.writeIteration(outcome);

      if (deps.hooks?.onIteration) {
        const progress: BootstrapIterationProgress = {
          iteration,
          ok,
          strategy,
          changedFiles,
          diffPatchPath,
          lint: { ok: lintSummary.ok, summary: lintSummary.summary },
          test: { ok: testSummary.ok, summary: testSummary.summary },
        };
        try {
          await deps.hooks.onIteration(progress, runCtx);
        } catch {
          // ignore hook failures
        }
      }

      logger.info(`[Bootstrap] iter=${iteration} ok=${ok} changedFiles=${changedFiles.length} lint=${lintSummary.ok} test=${testSummary.ok}`);
      logger.debug(`[Bootstrap] iter=${iteration} diffSummary:\n${diffSummary}`);

      if (ok) {
        if (spec.commit.enabled) {
          const stageOutcome = await stageSafeBootstrapChanges(worktree.worktreeDir, { runCommand: runner.runCommand });
          if (stageOutcome.staged.length === 0) {
            throw new Error("bootstrap passed verification but no safe changes were staged for commit");
          }
          const commit = await commitBootstrapChanges(worktree.worktreeDir, { runCommand: runner.runCommand }, { goal: spec.goal, messageTemplate: spec.commit.messageTemplate });
          if (!commit.commit) {
            throw new Error("bootstrap passed verification but failed to create commit");
          }
          const finishedAt = new Date().toISOString();
          artifacts.writeStrategyLog(strategyLog);
          const result: BootstrapRunResult = {
            ok: true,
            iterations: iteration,
            strategyChanges,
            finalCommit: commit.commit,
            finalBranch: worktree.branchName,
            lastReportPath: "",
          };
          const reportPath = artifacts.writeFinalReport({ spec, result, outcomes, startedAt, finishedAt });
          const finalResult = { ...result, lastReportPath: reportPath };
          if (deps.hooks?.onFinished) {
            try {
              await deps.hooks.onFinished(finalResult, runCtx);
            } catch {
              // ignore hook failures
            }
          }
          return finalResult;
        }

        const finishedAt = new Date().toISOString();
        artifacts.writeStrategyLog(strategyLog);
        const result: BootstrapRunResult = {
          ok: true,
          iterations: iteration,
          strategyChanges,
          finalBranch: worktree.branchName,
          lastReportPath: "",
        };
        const reportPath = artifacts.writeFinalReport({ spec, result, outcomes, startedAt, finishedAt });
        const finalResult = { ...result, lastReportPath: reportPath };
        if (deps.hooks?.onFinished) {
          try {
            await deps.hooks.onFinished(finalResult, runCtx);
          } catch {
            // ignore hook failures
          }
        }
        return finalResult;
      }
    }

    const finishedAt = new Date().toISOString();
    artifacts.writeStrategyLog(strategyLog);
    const result: BootstrapRunResult = {
      ok: false,
      iterations: spec.maxIterations,
      strategyChanges,
      finalBranch: worktree.branchName,
      lastReportPath: "",
      error: "max iterations exceeded",
    };
    const reportPath = artifacts.writeFinalReport({ spec, result, outcomes, startedAt, finishedAt });
    const finalResult = { ...result, lastReportPath: reportPath };
    if (deps.hooks?.onFinished) {
      try {
        await deps.hooks.onFinished(finalResult, runCtx);
      } catch {
        // ignore hook failures
      }
    }
    return finalResult;
  } catch (loopError) {
    const finishedAt = new Date().toISOString();
    artifacts.writeStrategyLog(strategyLog);
    const errorMessage = loopError instanceof Error ? loopError.message : String(loopError);
    const result: BootstrapRunResult = {
      ok: false,
      iterations: outcomes.length,
      strategyChanges,
      finalBranch: worktree.branchName,
      lastReportPath: "",
      error: errorMessage,
    };
    const reportPath = artifacts.writeFinalReport({ spec, result, outcomes, startedAt, finishedAt });
    const finalResult = { ...result, lastReportPath: reportPath };
    if (deps.hooks?.onFinished) {
      try {
        await deps.hooks.onFinished(finalResult, runCtx);
      } catch {
        // ignore hook failures
      }
    }
    if (loopError instanceof Error && loopError.message === "AbortError") {
      throw loopError;
    }
    return finalResult;
  }
}
