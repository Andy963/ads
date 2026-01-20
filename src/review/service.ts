import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { detectWorkspace } from "../workspace/detector.js";
import { WorkflowContext } from "../workspace/context.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { GraphNode } from "../graph/types.js";
import type { ReviewState } from "./types.js";
import { runReviewerAgent } from "./orchestrator.js";

const REVIEW_ROOT = path.join(".ads", "review");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function getWorkspacePath(workspacePath?: string): string {
  return workspacePath ? path.resolve(workspacePath) : detectWorkspace();
}

function getReviewDir(workspace: string, workflowId: string): string {
  const dir = path.join(workspace, REVIEW_ROOT, workflowId);
  ensureDir(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function runGit(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[git ${args.join(" ")} 失败] ${message}`;
  }
}

function runGitStrict(workspace: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[git ${args.join(" ")}] ${message}`);
  }
}

function resolveSpecDir(workflow: WorkflowInfo, workspace: string): string | null {
  const rootNode: GraphNode | null = WorkflowContext.getNode(workspace, workflow.workflow_id);
  if (!rootNode) {
    return null;
  }

  // 直接从 metadata 读取 spec_folder，避免依赖全局数据库状态
  const specFolder = rootNode.metadata?.spec_folder;
  if (typeof specFolder === "string" && specFolder) {
    return path.join(workspace, "docs", "spec", specFolder);
  }

  // 回退到 workflow_id
  return path.join(workspace, "docs", "spec", workflow.workflow_id);
}

interface CommitDiffSource {
  type: "commit";
  ref: string;
  sha: string;
  summary?: string;
  author?: string;
  email?: string;
  date?: string;
  message?: string;
}

type ReviewDiffSource = { type: "working" } | CommitDiffSource;

type SpecMode = "default" | "forceInclude" | "forceExclude";

function resolveCommitDiffSource(workspace: string, ref: string): CommitDiffSource {
  const normalizedRef = ref.trim() || "HEAD";
  const sha = runGitStrict(workspace, ["rev-parse", normalizedRef]).trim();
  const pretty = runGitStrict(workspace, ["show", "-s", "--format=%H%n%an%n%ae%n%ad%n%s%n%b", sha]);
  const lines = pretty.split("\n");
  const hash = lines.shift() ?? sha;
  const author = lines.shift();
  const email = lines.shift();
  const date = lines.shift();
  const summary = lines.shift();
  const message = lines.join("\n").trim();
  return {
    type: "commit",
    ref: normalizedRef,
    sha: hash || sha,
    author: author || undefined,
    email: email || undefined,
    date: date || undefined,
    summary: summary || undefined,
    message: message || undefined,
  };
}

function toReviewStateTarget(diffSource: ReviewDiffSource): ReviewState["target"] {
  if (diffSource.type === "commit") {
    return {
      type: "commit",
      commit_ref: diffSource.ref,
      commit_sha: diffSource.sha,
      commit_summary: diffSource.summary,
    };
  }
  return { type: "working" };
}

function describeDiffSource(diffSource: ReviewDiffSource): string {
  if (diffSource.type === "commit") {
    const shortSha = diffSource.sha.slice(0, 12);
    const summary = diffSource.summary ? ` - ${diffSource.summary}` : "";
    return `🔁 Review 目标: 提交 ${shortSha}${summary}`;
  }
  return "🔁 Review 目标: 当前未提交的工作区变更";
}

interface BundleResult {
  bundleDir: string;
  warnings: string[];
  specFilesCopied: number;
  includeSpecFiles: boolean;
}

interface BuildBundleOptions {
  includeSpecFiles?: boolean;
  diffSource?: ReviewDiffSource;
  specMode?: SpecMode;
}

function buildBundle(
  workspace: string,
  workflow: WorkflowInfo,
  reviewDir: string,
  options?: BuildBundleOptions,
): BundleResult {
  const bundleDir = path.join(reviewDir, "bundle");
  const warnings: string[] = [];
  ensureDir(bundleDir);
  const includeSpecFiles = options?.includeSpecFiles ?? true;
  const diffSource: ReviewDiffSource = options?.diffSource ?? { type: "working" };
  const specMode = options?.specMode ?? "default";

  const diffArgs =
    diffSource.type === "commit"
      ? ["diff", "--binary", `${diffSource.sha}^!`]
      : ["diff", "--binary"];
  const statsArgs =
    diffSource.type === "commit"
      ? ["diff", "--stat", `${diffSource.sha}^!`]
      : ["diff", "--stat"];
  const depsArgs =
    diffSource.type === "commit"
      ? ["diff", `${diffSource.sha}^!`, "--", "package.json", "package-lock.json"]
      : ["diff", "--", "package.json", "package-lock.json"];

  // Git diff
  const diffContent = runGit(workspace, diffArgs);
  fs.writeFileSync(path.join(bundleDir, "diff.patch"), diffContent, "utf-8");
  if (!diffContent.trim() || diffContent.includes("[git diff")) {
    warnings.push("未检测到代码变更（git diff 为空或失败）");
  }

  fs.writeFileSync(path.join(bundleDir, "stats.txt"), runGit(workspace, statsArgs), "utf-8");
  fs.writeFileSync(path.join(bundleDir, "deps.txt"), runGit(workspace, depsArgs), "utf-8");

  // Spec files
  const specDir = resolveSpecDir(workflow, workspace);
  let specCount = 0;
  if (includeSpecFiles && specDir && fs.existsSync(specDir)) {
    const specFiles = ["requirements.md", "design.md", "implementation.md"];
    for (const file of specFiles) {
      const sourcePath = path.join(specDir, file);
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, path.join(bundleDir, file));
        specCount++;
      }
    }
  }
  if (!includeSpecFiles) {
    if (specMode === "forceExclude") {
      warnings.push("已根据 --no-spec 指令跳过 spec 文件，本次 Review 仅依据代码 diff。");
    } else {
      warnings.push("默认未附带 spec 文件，本次 Review 仅依据代码 diff。");
    }
  } else if (specCount === 0) {
    warnings.push(`未找到 spec 文件（spec 目录: ${specDir ?? "无法解析"}）`);
  }

  const metadata = {
    workflow_id: workflow.workflow_id,
    title: workflow.title ?? "",
    template: workflow.template ?? "",
    head: runGit(workspace, ["rev-parse", "HEAD"]).trim(),
    branch: runGit(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    generated_at: new Date().toISOString(),
    spec_dir: specDir,
    spec_files_found: specCount,
    spec_files_included: includeSpecFiles,
    target:
      diffSource.type === "commit"
        ? {
            type: "commit",
            ref: diffSource.ref,
            sha: diffSource.sha,
            summary: diffSource.summary,
            author: diffSource.author,
            email: diffSource.email,
            date: diffSource.date,
          }
        : { type: "working" },
    commit_message: diffSource.type === "commit" ? diffSource.message : undefined,
  };
  writeJson(path.join(bundleDir, "metadata.json"), metadata);

  return { bundleDir, warnings, specFilesCopied: specCount, includeSpecFiles };
}

function formatStateTarget(target?: ReviewState["target"]): string | null {
  if (!target) {
    return null;
  }
  if (target.type === "commit") {
    const label = target.commit_sha?.slice(0, 10) ?? target.commit_ref ?? "commit";
    const summary = target.commit_summary ? ` - ${target.commit_summary}` : "";
    return `Commit ${label}${summary}`;
  }
  return "Working tree (未提交变更)";
}

function writeReport(reportPath: string, workflow: WorkflowInfo, state: ReviewState): void {
  const lines: string[] = [];
  lines.push(`# Reviewer Report - ${workflow.title ?? workflow.workflow_id}`);
  lines.push(`- Verdict: ${state.verdict === "approved" ? "✅ Approved" : state.verdict === "blocked" ? "❌ Blocked" : "⚠️ Failed"}`);
  lines.push(`- Reviewed At: ${state.updated_at ?? new Date().toISOString()}`);
  if (state.summary) {
    lines.push(`- Summary: ${state.summary}`);
  }
  const targetLine = formatStateTarget(state.target);
  if (targetLine) {
    lines.push(`- Target: ${targetLine}`);
  }
  lines.push("");
  lines.push("## Issues");
  if (state.issues && state.issues.length > 0) {
    state.issues.forEach((issue, index) => {
      const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "N/A";
      lines.push(`${index + 1}. [${issue.severity.toUpperCase()}] ${location} - ${issue.message}`);
      if (issue.suggestion) {
        lines.push(`   - Suggestion: ${issue.suggestion}`);
      }
    });
  } else {
    lines.push("- 无");
  }
  fs.writeFileSync(reportPath, lines.join("\n"), "utf-8");
}

function writeState(reviewDir: string, state: ReviewState, workspace: string): void {
  writeJson(path.join(reviewDir, "state.json"), state);
  WorkflowContext.setReviewState({
    workspace,
    workflowId: state.workflow_id,
    review: state,
  });
}

function lockWorkflow(workspace: string, workflowId: string, locked: boolean): void {
  WorkflowContext.setReviewLock({
    workspace,
    workflowId,
    locked,
  });
}

export async function runReview(
  options: {
    workspace_path?: string;
    requestedBy?: string;
    agent?: "codex";
    includeSpec?: boolean;
    commitRef?: string;
    specMode?: SpecMode;
  } = {},
): Promise<string> {
  const workspace = getWorkspacePath(options.workspace_path);
  const workflowStatus = WorkflowContext.getWorkflowStatus(workspace);
  if (!workflowStatus) {
    return "❌ 没有活动工作流，无法执行 Review。";
  }

  const workflow = workflowStatus.workflow;
  const includeSpec = options.includeSpec ?? false;
  const specMode: SpecMode = options.specMode ?? "default";
  const diffSource: ReviewDiffSource =
    options.commitRef && options.commitRef.trim()
      ? resolveCommitDiffSource(workspace, options.commitRef)
      : { type: "working" };

  const implementationStep = workflowStatus.steps.find((step) => step.name === "implementation");
  const implementationFinalized = implementationStep?.status === "finalized";
  const workflowWarning = implementationFinalized ? null : "实施步骤尚未定稿，本次 Review 仅供参考。";

  const reviewDir = getReviewDir(workspace, workflow.workflow_id);
  const now = new Date().toISOString();
  const targetInfo = toReviewStateTarget(diffSource);
  const runningState: ReviewState = {
    workflow_id: workflow.workflow_id,
    status: "running",
    requested_by: options.requestedBy ?? "cli",
    requested_at: now,
    updated_at: now,
    target: targetInfo,
  };
  writeState(reviewDir, runningState, workspace);
  lockWorkflow(workspace, workflow.workflow_id, true);

  try {
    const { bundleDir, warnings: bundleWarnings } = buildBundle(workspace, workflow, reviewDir, {
      includeSpecFiles: includeSpec,
      diffSource,
      specMode,
    });
    const reviewerResult = await runReviewerAgent({
      workspace,
      workflow,
      reviewDir,
      bundleDir,
      includeSpecFiles: includeSpec,
    });
    const report = reviewerResult.report;
    const finalState: ReviewState = {
      workflow_id: workflow.workflow_id,
      status: report.verdict === "approved" || report.verdict === "blocked" ? report.verdict : "failed",
      verdict: report.verdict,
      summary: report.summary,
      issues: report.issues,
      updated_at: new Date().toISOString(),
      target: targetInfo,
    };

    const reportPath = path.join(reviewDir, "report.md");
    writeReport(reportPath, workflow, finalState);
    finalState.report_path = reportPath;

    writeState(reviewDir, finalState, workspace);

    const issuesText =
      finalState.issues && finalState.issues.length > 0
        ? `发现 ${finalState.issues.length} 个问题，其中 ${finalState.issues.filter((issue) => issue.severity === "error").length} 个严重。`
        : "未发现问题。";

    const lines = [
      finalState.status === "approved" ? "✅ Review 通过" : finalState.status === "blocked" ? "❌ Review 阻塞" : "⚠️ Review 失败",
      `Reviewer: ${reviewerResult.agentId}`,
      describeDiffSource(diffSource),
      report.summary ?? "",
      issuesText,
      "查看详细报告: /ads.review --show",
    ];
    // 添加 bundle 警告和 reviewer 警告
    const warningCandidates = [
      workflowWarning,
      ...bundleWarnings,
      ...(reviewerResult.warnings ?? []),
    ].filter((warning): warning is string => Boolean(warning));
    warningCandidates.forEach((warning) => lines.splice(1, 0, `⚠️ ${warning}`));
    return lines
      .filter(Boolean)
      .join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedState: ReviewState = {
      workflow_id: workflow.workflow_id,
      status: "failed",
      summary: `Reviewer 执行失败：${message}`,
      updated_at: new Date().toISOString(),
      target: targetInfo,
    };
    writeState(reviewDir, failedState, workspace);
    return `⚠️ Review 执行失败：${message}`;
  } finally {
    lockWorkflow(workspace, workflow.workflow_id, false);
  }
}

export async function skipReview(options: { workspace_path?: string; reason: string; requestedBy?: string }): Promise<string> {
  const workspace = getWorkspacePath(options.workspace_path);
  const workflow = WorkflowContext.getActiveWorkflow(workspace);
  if (!workflow) {
    return "❌ 没有活动工作流。";
  }
  const reviewDir = getReviewDir(workspace, workflow.workflow_id);
  const now = new Date().toISOString();
  const state: ReviewState = {
    workflow_id: workflow.workflow_id,
    status: "skipped",
    skip_reason: options.reason,
    requested_by: options.requestedBy ?? "cli",
    requested_at: now,
    updated_at: now,
  };
  writeState(reviewDir, state, workspace);
  lockWorkflow(workspace, workflow.workflow_id, false);
  return `⚠️ Review 已按请求跳过：${options.reason}`;
}

export async function showReviewReport(options: { workspace_path?: string; workflowId?: string } = {}): Promise<string> {
  const workspace = getWorkspacePath(options.workspace_path);
  const context = WorkflowContext.loadContext(workspace);
  const workflowId = options.workflowId ?? context.active_workflow_id;
  if (!workflowId) {
    return "❌ 尚未选择工作流。";
  }
  const reviewDir = path.join(workspace, REVIEW_ROOT, workflowId);
  const reportPath = path.join(reviewDir, "report.md");
  if (fs.existsSync(reportPath)) {
    return readFileSafe(reportPath);
  }
  const statePath = path.join(reviewDir, "state.json");
  if (fs.existsSync(statePath)) {
    const stateContent = readFileSafe(statePath);
    return stateContent ? ["```json", stateContent, "```"].join("\n") : stateContent;
  }
  return "ℹ️ 尚未执行 Review。";
}
