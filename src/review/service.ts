import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { detectWorkspace } from "../workspace/detector.js";
import { WorkflowContext } from "../workspace/context.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { GraphNode } from "../graph/types.js";
import { getSpecDir } from "../graph/fileManager.js";
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
    return execSync(`git ${args.join(" ")}`, {
      cwd: workspace,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[git ${args.join(" ")} 失败] ${message}`;
  }
}

function resolveSpecDir(workflow: WorkflowInfo, workspace: string): string | null {
  const rootNode: GraphNode | null = WorkflowContext.getNode(workspace, workflow.workflow_id);
  if (!rootNode) {
    return null;
  }
  return getSpecDir(rootNode, workspace);
}

interface BundleResult {
  bundleDir: string;
  warnings: string[];
}

function buildBundle(workspace: string, workflow: WorkflowInfo, reviewDir: string): BundleResult {
  const bundleDir = path.join(reviewDir, "bundle");
  const warnings: string[] = [];
  ensureDir(bundleDir);

  // Git diff
  const diffContent = runGit(workspace, ["diff", "--binary"]);
  fs.writeFileSync(path.join(bundleDir, "diff.patch"), diffContent, "utf-8");
  if (!diffContent.trim() || diffContent.includes("[git diff")) {
    warnings.push("未检测到代码变更（git diff 为空或失败）");
  }

  fs.writeFileSync(path.join(bundleDir, "stats.txt"), runGit(workspace, ["diff", "--stat"]), "utf-8");
  fs.writeFileSync(path.join(bundleDir, "deps.txt"), runGit(workspace, ["diff", "--", "package.json", "package-lock.json"]), "utf-8");

  // Spec files
  const specDir = resolveSpecDir(workflow, workspace);
  let specCount = 0;
  if (specDir && fs.existsSync(specDir)) {
    const specFiles = ["requirements.md", "design.md", "implementation.md"];
    for (const file of specFiles) {
      const sourcePath = path.join(specDir, file);
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, path.join(bundleDir, file));
        specCount++;
      }
    }
  }
  if (specCount === 0) {
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
  };
  writeJson(path.join(bundleDir, "metadata.json"), metadata);

  // Tests log
  const latestTestsLog = path.join(workspace, ".ads", "logs", "latest-tests.log");
  if (fs.existsSync(latestTestsLog)) {
    fs.writeFileSync(path.join(bundleDir, "tests.log"), readFileSafe(latestTestsLog), "utf-8");
  } else {
    fs.writeFileSync(path.join(bundleDir, "tests.log"), "尚未捕获测试输出。", "utf-8");
    warnings.push("未找到测试日志（.ads/logs/latest-tests.log）");
  }

  return { bundleDir, warnings };
}

function writeReport(reportPath: string, workflow: WorkflowInfo, state: ReviewState): void {
  const lines: string[] = [];
  lines.push(`# Reviewer Report - ${workflow.title ?? workflow.workflow_id}`);
  lines.push(`- Verdict: ${state.verdict === "approved" ? "✅ Approved" : state.verdict === "blocked" ? "❌ Blocked" : "⚠️ Failed"}`);
  lines.push(`- Reviewed At: ${state.updated_at ?? new Date().toISOString()}`);
  if (state.summary) {
    lines.push(`- Summary: ${state.summary}`);
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

export async function runReview(options: { workspace_path?: string; requestedBy?: string; agent?: "codex" | "claude" } = {}): Promise<string> {
  const workspace = getWorkspacePath(options.workspace_path);
  const workflowStatus = WorkflowContext.getWorkflowStatus(workspace);
  if (!workflowStatus) {
    return "❌ 没有活动工作流，无法执行 Review。";
  }

  const workflow = workflowStatus.workflow;
  const implementationStep = workflowStatus.steps.find((step) => step.name === "implementation");
  if (!implementationStep || implementationStep.status !== "finalized") {
    return "❌ 实施步骤尚未定稿，无法执行 Review。";
  }

  const reviewDir = getReviewDir(workspace, workflow.workflow_id);
  const now = new Date().toISOString();
  const runningState: ReviewState = {
    workflow_id: workflow.workflow_id,
    status: "running",
    requested_by: options.requestedBy ?? "cli",
    requested_at: now,
    updated_at: now,
  };
  writeState(reviewDir, runningState, workspace);
  lockWorkflow(workspace, workflow.workflow_id, true);

  try {
    const { bundleDir, warnings: bundleWarnings } = buildBundle(workspace, workflow, reviewDir);
    const reviewerResult = await runReviewerAgent({
      workspace,
      workflow,
      reviewDir,
      bundleDir,
      preferredAgent: options.agent,
    });
    const report = reviewerResult.report;
    const finalState: ReviewState = {
      workflow_id: workflow.workflow_id,
      status: report.verdict === "approved" || report.verdict === "blocked" ? report.verdict : "failed",
      verdict: report.verdict,
      summary: report.summary,
      issues: report.issues,
      updated_at: new Date().toISOString(),
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
      report.summary ?? "",
      issuesText,
      "查看详细报告: /ads.review --show",
    ];
    // 添加 bundle 警告和 reviewer 警告
    const allWarnings = [...bundleWarnings, ...(reviewerResult.warnings ?? [])];
    allWarnings.forEach((warning) => lines.splice(1, 0, `⚠️ ${warning}`));
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
    return readFileSafe(statePath);
  }
  return "ℹ️ 尚未执行 Review。";
}
