import type { VerificationCommand } from "../agents/tasks/schemas.js";
import type { VerificationReport } from "../agents/tasks/verificationRunner.js";

export type BootstrapProjectRef =
  | { kind: "local_path"; value: string }
  | { kind: "git_url"; value: string };

export type BootstrapRecipe = {
  version: 1;
  install: VerificationCommand[];
  lint: VerificationCommand[];
  test: VerificationCommand[];
  env?: Record<string, string>;
};

export type BootstrapSandboxSpec = {
  backend: "bwrap" | "none";
};

export type BootstrapWorktreeSpec = {
  branchPrefix: string;
};

export type BootstrapCommitSpec = {
  enabled: boolean;
  messageTemplate: string;
};

export type BootstrapRunSpec = {
  project: BootstrapProjectRef;
  goal: string;
  maxIterations: number;
  allowNetwork: boolean;
  allowInstallDeps: boolean;
  requireHardSandbox: boolean;
  sandbox: BootstrapSandboxSpec;
  worktree: BootstrapWorktreeSpec;
  commit: BootstrapCommitSpec;
  recipe?: BootstrapRecipe;
};

export type BootstrapIterationOutcome = {
  iteration: number;
  diffPatchPath: string | null;
  installReport: VerificationReport | null;
  lintReport: VerificationReport | null;
  testReport: VerificationReport | null;
  ok: boolean;
  strategy: "normal_fix" | "clean_deps" | "restart_agent";
};

export type BootstrapRunContext = {
  projectId: string;
  runId: string;
  bootstrapRoot: string;
  repoDir: string;
  worktreeDir: string;
  artifactsDir: string;
  branchName: string;
};

export type BootstrapIterationProgress = {
  iteration: number;
  ok: boolean;
  strategy: BootstrapIterationOutcome["strategy"];
  changedFiles: string[];
  diffPatchPath: string | null;
  lint: { ok: boolean; summary: string };
  test: { ok: boolean; summary: string };
};

export type BootstrapRunResult = {
  ok: boolean;
  iterations: number;
  strategyChanges: number;
  finalCommit?: string;
  finalBranch?: string;
  lastReportPath: string;
  error?: string;
};

export type BootstrapLoopHooks = {
  onStarted?: (ctx: BootstrapRunContext, detail: { spec: BootstrapRunSpec; recipe: BootstrapRecipe }) => void | Promise<void>;
  onIteration?: (progress: BootstrapIterationProgress, ctx: BootstrapRunContext) => void | Promise<void>;
  onFinished?: (result: BootstrapRunResult, ctx: BootstrapRunContext) => void | Promise<void>;
};

export function normalizeBootstrapRunSpec(spec: Partial<BootstrapRunSpec> & Pick<BootstrapRunSpec, "project" | "goal">): BootstrapRunSpec {
  const maxIterationsRaw = typeof spec.maxIterations === "number" && Number.isFinite(spec.maxIterations) ? Math.floor(spec.maxIterations) : 10;
  const maxIterations = Math.max(1, Math.min(10, maxIterationsRaw));

  const allowNetwork = spec.allowNetwork !== false;
  const allowInstallDeps = spec.allowInstallDeps !== false;
  const requireHardSandbox = spec.requireHardSandbox !== false;

  const sandboxBackend = spec.sandbox?.backend ?? "bwrap";
  const sandbox: BootstrapSandboxSpec = { backend: sandboxBackend };

  const branchPrefix = spec.worktree?.branchPrefix?.trim() || "bootstrap";
  const worktree: BootstrapWorktreeSpec = { branchPrefix };

  const commitEnabled = spec.commit?.enabled !== false;
  const messageTemplate = spec.commit?.messageTemplate?.trim() || "bootstrap: ${goal}";
  const commit: BootstrapCommitSpec = { enabled: commitEnabled, messageTemplate };

  const goal = String(spec.goal ?? "").trim();
  if (!goal) {
    throw new Error("goal is required");
  }

  return {
    project: spec.project,
    goal,
    maxIterations,
    allowNetwork,
    allowInstallDeps,
    requireHardSandbox,
    sandbox,
    worktree,
    commit,
    recipe: spec.recipe,
  };
}
