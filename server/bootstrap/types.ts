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

export type BootstrapReviewSpec = {
  enabled: boolean;
  maxRounds: number;
  model?: string;
};

export type BootstrapSkillsSpec = {
  enabled: boolean;
  executor: string;
  reviewer: string;
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
  review: BootstrapReviewSpec;
  skills: BootstrapSkillsSpec;
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
  review?: {
    enabled: boolean;
    ok: boolean;
    summary: string;
    round: number;
    verdictPath: string | null;
    rawResponsePath: string | null;
    attempts: number;
  } | null;
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
  review?: { ok: boolean; summary: string } | null;
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

  const reviewEnabled = spec.review?.enabled === true;
  const maxRoundsRaw =
    typeof spec.review?.maxRounds === "number" && Number.isFinite(spec.review.maxRounds) ? Math.floor(spec.review.maxRounds) : 2;
  const maxRounds = Math.max(1, Math.min(2, maxRoundsRaw));
  const reviewModel = spec.review?.model ? String(spec.review.model).trim() : undefined;
  const review: BootstrapReviewSpec = { enabled: reviewEnabled, maxRounds, model: reviewModel && reviewModel.length > 0 ? reviewModel : undefined };

  const skillsEnabled = spec.skills?.enabled !== false;
  const executorSkill = spec.skills?.executor?.trim() || "bootstrap-executor";
  const reviewerSkill = spec.skills?.reviewer?.trim() || "bootstrap-reviewer";
  const skills: BootstrapSkillsSpec = { enabled: skillsEnabled, executor: executorSkill, reviewer: reviewerSkill };

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
    review,
    skills,
    recipe: spec.recipe,
  };
}
