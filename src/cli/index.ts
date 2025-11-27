#!/usr/bin/env node

import "../utils/logSink.js";

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { parseSlashCommand } from "../codexConfig.js";
import {
  listWorkflows,
  checkoutWorkflow,
  getWorkflowStatusSummary,
  commitStep,
  listWorkflowLog,
} from "../workflow/service.js";
import { buildAdsHelpMessage } from "../workflow/commands.js";
import { createWorkflowFromTemplate } from "../workflow/templateService.js";
import { createLogger } from "../utils/logger.js";
import { SystemPromptManager, resolveReinjectionConfig } from "../systemPrompt/manager.js";

const cliLogger = createLogger('CLI');
import { initWorkspace, getCurrentWorkspace, syncWorkspaceTemplates } from "../workspace/service.js";
import { detectWorkspace } from "../workspace/detector.js";
import { readRules, listRules } from "../workspace/rulesService.js";
import { syncAllNodesToFiles } from "../graph/service.js";
import { ConversationLogger } from "../utils/conversationLogger.js";
import { CodexAgentAdapter } from "../agents/adapters/codexAdapter.js";
import { ClaudeAgentAdapter } from "../agents/adapters/claudeAdapter.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import { injectDelegationGuide, resolveDelegations } from "../agents/delegation.js";
import type { AgentEvent, AgentPhase } from "../codex/events.js";
import { resolveClaudeAgentConfig } from "../agents/config.js";
import type { AgentAdapter } from "../agents/types.js";
import { WorkflowContext } from "../workspace/context.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import pc from "picocolors";
import { runReview, skipReview, showReviewReport } from "../review/service.js";

interface CommandResult {
  output: string;
  exit?: boolean;
}

const PROMPT = "ADS> ";
const REVIEW_LOCK_SAFE_COMMANDS = new Set([
  "ads.init",
  "ads.review",
  "ads.status",
  "ads.log",
  "ads.help",
  "ads.rules",
  "ads.workspace",
  "ads.branch",
  "ads.checkout",
]);

interface TemplateMetadata {
  id?: string;
  name?: string;
  description?: string;
  steps?: string;
}

interface WorkspaceInfoFields {
  path?: string;
  db_path?: string;
  rules_dir?: string;
  specs_dir?: string;
  name?: string;
  created_at?: string;
  version?: string;
  is_initialized?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTemplateEntry(entry: unknown): TemplateMetadata | null {
  if (!isRecord(entry)) {
    return null;
  }

  const metadata: TemplateMetadata = {
    id: typeof entry.id === "string" ? entry.id : undefined,
    name: typeof entry.name === "string" ? entry.name : undefined,
    description: typeof entry.description === "string" ? entry.description : undefined,
  };

  const stepsValue = entry.steps;
  if (typeof stepsValue === "string") {
    metadata.steps = stepsValue;
  } else if (Array.isArray(stepsValue)) {
    metadata.steps = stepsValue.map((value) => String(value)).join(", ");
  } else if (typeof stepsValue === "number") {
    metadata.steps = stepsValue.toString();
  }

  return metadata;
}

function describeTemplateEntry(entry: unknown, index: number): string | null {
  const metadata = normalizeTemplateEntry(entry);
  if (!metadata) {
    return null;
  }

  const label = metadata.name ?? metadata.id ?? `模板${index + 1}`;
  const descPart = metadata.description ? ` - ${metadata.description}` : "";
  const stepsPart = metadata.steps ? ` (步骤: ${metadata.steps})` : "";
  const idLabel = metadata.id ? ` [${metadata.id}]` : "";
  return `${index + 1}. ${label}${idLabel}${stepsPart}${descPart}`;
}

function normalizeWorkspaceInfo(value: unknown): WorkspaceInfoFields | null {
  if (!isRecord(value)) {
    return null;
  }
  const info: WorkspaceInfoFields = {};
  let hasField = false;

  if (typeof value.path === "string") {
    info.path = value.path;
    hasField = true;
  }
  if (typeof value.db_path === "string") {
    info.db_path = value.db_path;
    hasField = true;
  }
  if (typeof value.rules_dir === "string") {
    info.rules_dir = value.rules_dir;
    hasField = true;
  }
  if (typeof value.specs_dir === "string") {
    info.specs_dir = value.specs_dir;
    hasField = true;
  }
  if (typeof value.name === "string") {
    info.name = value.name;
    hasField = true;
  }
  if (typeof value.created_at === "string") {
    info.created_at = value.created_at;
    hasField = true;
  }
  if (typeof value.version === "string") {
    info.version = value.version;
    hasField = true;
  }
  if (typeof value.is_initialized === "boolean") {
    info.is_initialized = value.is_initialized;
    hasField = true;
  }

  return hasField ? info : null;
}

function formatWorkspaceInfo(info: WorkspaceInfoFields): string {
  const lines: string[] = ["工作空间信息:"];
  if (info.path) lines.push(`  根目录: ${info.path}`);
  if (info.db_path) lines.push(`  数据库: ${info.db_path}`);
  if (info.rules_dir) lines.push(`  规则目录: ${info.rules_dir}`);
  if (info.specs_dir) lines.push(`  规格目录: ${info.specs_dir}`);
  if (info.name) lines.push(`  名称: ${info.name}`);
  if (info.created_at) lines.push(`  创建时间: ${info.created_at}`);
  if (info.version) lines.push(`  版本: ${info.version}`);
  if (info.is_initialized !== undefined) {
    lines.push(`  已初始化: ${info.is_initialized ? "是" : "否"}`);
  }
  return lines.join("\n");
}

async function ensureWorkspace(logger: ConversationLogger): Promise<void> {
  const cwd = process.cwd();
  const marker = path.join(cwd, ".ads", "workspace.json");
  if (fs.existsSync(marker)) {
    syncWorkspaceTemplates();
    return;
  }

  logger.logOutput("未检测到工作空间，正在自动初始化...");
  const response = await initWorkspace({ name: path.basename(cwd) });
  const message = formatResponse(response);
  logger.logOutput(message);
  cliLogger.info(message);
  syncWorkspaceTemplates();
}

function createAgentController(
  workspaceRoot: string,
  systemPromptManager: SystemPromptManager,
): HybridOrchestrator {
  const adapters: AgentAdapter[] = [
    new CodexAgentAdapter({
      workingDirectory: workspaceRoot,
      systemPromptManager,
    }),
  ];

  const claudeConfig = resolveClaudeAgentConfig();
  if (claudeConfig.enabled) {
    adapters.push(new ClaudeAgentAdapter({ config: claudeConfig }));
  }

  return new HybridOrchestrator({
    adapters,
    defaultAgentId: "codex",
    initialWorkingDirectory: workspaceRoot,
  });
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function resolveCommitRefParam(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const bool = parseBooleanParam(value);
  if (bool === undefined) {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return bool ? "HEAD" : undefined;
}

function formatResponse(text: string): string {
  if (!text.trim()) {
    return "(无输出)";
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return text;
    }

    if (typeof parsed.error === "string") {
      return `❌ ${parsed.error}`;
    }
    if (parsed.success === true && typeof parsed.message === "string") {
      return parsed.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }

    if (Array.isArray(parsed.templates)) {
      const lines = parsed.templates
        .map((entry, index) => describeTemplateEntry(entry, index))
        .filter((line): line is string => Boolean(line));
      if (lines.length > 0) {
        lines.unshift("可用模板:");
        return lines.join("\n");
      }
    }

    const workspaceInfo = normalizeWorkspaceInfo(parsed);
    if (workspaceInfo?.path && workspaceInfo.db_path) {
      return formatWorkspaceInfo(workspaceInfo);
    }

    const nestedWorkspaceInfo = normalizeWorkspaceInfo(parsed.workspace);
    if (nestedWorkspaceInfo) {
      return formatWorkspaceInfo(nestedWorkspaceInfo);
    }

    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function normalizeOutput(text: string): string {
  if (typeof text !== "string") {
    return "(无输出)";
  }
  return text.trim() ? text : "(无输出)";
}

function truncateForLog(text: string, limit = 96): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit - 1)}…`;
}

function buildRequirementClarificationPrompt(): string | null {
  try {
    const status = WorkflowContext.getWorkflowStatus();
    if (!status) {
      return null;
    }
    const requirementStep = status.steps.find((step) =>
      step.name.toLowerCase().includes("requirement"),
    );
    if (requirementStep && requirementStep.status !== "finalized") {
      return [
        "系统提示（需求澄清阶段）:",
        "在确认需求前，请持续向用户提问缺失信息，明确业务目标、范围、约束和验收标准。",
        "除非用户明确表示需求已完整、可以进入设计/实现，否则不要提前给出设计或代码方案。",
        "如果信息已经足够，请复述你对需求的理解并询问是否可以继续。",
      ].join("\n");
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveWorkflowSpecDir(workflow: WorkflowInfo, workspace: string): string | null {
  const rootNode = WorkflowContext.getNode(workspace, workflow.workflow_id);
  if (!rootNode) {
    return null;
  }
  const specFolder =
    typeof rootNode.metadata?.spec_folder === "string" && rootNode.metadata.spec_folder
      ? rootNode.metadata.spec_folder
      : workflow.workflow_id;
  if (!specFolder) {
    return null;
  }
  return path.join(workspace, "docs", "spec", specFolder);
}

function formatRelativePath(workspace: string, target?: string | null): string | null {
  if (!target) {
    return null;
  }
  const absolute = path.isAbsolute(target) ? target : path.join(workspace, target);
  const relative = path.relative(workspace, absolute);
  return relative.replace(/\\/g, "/") || ".";
}

function buildWorkflowContextPrompt(): string | null {
  try {
    const workspace = detectWorkspace();
    const status = WorkflowContext.getWorkflowStatus(workspace);
    if (!status) {
      return null;
    }
    const { workflow, steps } = status;
    const specDir = resolveWorkflowSpecDir(workflow, workspace);
    const relativeSpecDir = specDir ? formatRelativePath(workspace, specDir) : null;
    const lines: string[] = [];
    lines.push("📌 当前 ADS 工作流（系统已同步上下文，除非状态过期请勿重复执行 /ads.status）");
    lines.push(`• 标题: ${workflow.title ?? "(未命名)"} (${workflow.workflow_id})`);
    lines.push(`• 模板: ${workflow.template ?? "unknown"}`);
    if (workflow.current_step) {
      lines.push(`• 当前步骤: ${workflow.current_step}`);
    }
    if (relativeSpecDir) {
      lines.push(`• Spec 目录: ${relativeSpecDir}`);
    }
    if (workflow.review) {
      lines.push(
        `• Review 状态: ${workflow.review.status}` +
          (workflow.review.updated_at ? ` (${workflow.review.updated_at})` : ""),
      );
    }
    if (steps.length > 0) {
      lines.push("• 步骤：");
      for (const step of steps) {
        const icon = step.status === "finalized" ? "✅" : "📝";
        const currentMark = step.is_current ? " ← 当前" : "";
        const fileHint = formatRelativePath(workspace, step.file_path);
        const fileSegment = fileHint ? ` [${fileHint}]` : "";
        lines.push(`  - ${icon} ${step.name}${currentMark}${fileSegment}`);
      }
    }
    lines.push("");
    lines.push("⚠️ 当前即在 ADS CLI 内，直接输入 `/ads.*` 命令即可。不要在 shell 里再运行 `ads <<'EOF' ...`、`printf '/ads.status\\n/ads.exit\\n' | ads`，也不要执行 `/ads.exit`。");
    return lines.join("\n");
  } catch (error) {
    cliLogger.warn(
      `[WorkflowContext] Failed to build workflow prompt: ${(error as Error).message}`,
    );
    return null;
  }
}

async function handleAgentInteraction(
  input: string,
  orchestrator: HybridOrchestrator,
  logger: ConversationLogger,
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { output: "" };
  }

  const status = orchestrator.status();
  if (!status.ready) {
    const reason = status.error ?? "请设置 CODEX_API_KEY 或配置 ~/.codex";
    return { output: `❌ 当前代理未启用: ${reason}` };
  }

  try {
    const streamingConfig = orchestrator.getStreamingConfig();
    const startTime = Date.now();
    if (!streamingConfig.enabled) {
      const thinking = "⌛ 代理正在思考...";
      cliLogger.info(thinking);
      logger.logOutput(thinking);
    }
    const renderer = createStatusRenderer(
      startTime,
      streamingConfig.throttleMs,
      logger,
      streamingConfig.enabled,
      orchestrator,
    );
    const unsubscribe = orchestrator.onEvent(renderer.handleEvent);
    const clarification = buildRequirementClarificationPrompt();
    const workflowPrompt = buildWorkflowContextPrompt();
    const promptSections: string[] = [];
    if (workflowPrompt) {
      promptSections.push(workflowPrompt);
    }
    if (clarification) {
      promptSections.push(clarification);
    }
    promptSections.push(`用户输入: ${trimmed}`);
    const basePrompt = promptSections.join("\n\n");
    const finalPrompt = injectDelegationGuide(basePrompt, orchestrator);
    try {
      const result = await orchestrator.send(finalPrompt);
      const delegated = await resolveDelegations(result, orchestrator, {
        onInvoke: (prompt) => {
          logger.logOutput(`[Auto] 调用 Claude 协助：${truncateForLog(prompt)}`);
        },
        onResult: (summary) => {
          logger.logOutput(`[Auto] Claude 完成：${truncateForLog(summary.prompt)}`);
        },
      });
      const elapsed = (Date.now() - startTime) / 1000;
      renderer.finish();
      if (!streamingConfig.enabled) {
        const summary = `[${renderer.getAgentLabel()}] 耗时 ${elapsed.toFixed(1)}s`;
        cliLogger.info(summary);
        logger.logOutput(summary);
      }
      const finalText = delegated.response || "(代理无响应)";
      return { output: finalText };
    } finally {
      unsubscribe();
      renderer.cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `❌ 代理调用失败: ${message}` };
  }
}

async function handleAdsCommand(command: string, rawArgs: string[], _logger: ConversationLogger): Promise<CommandResult> {
  void _logger;
  const positional: string[] = [];
  const params: Record<string, string> = {};

  for (const token of rawArgs) {
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex > -1) {
        const key = token.slice(2, eqIndex);
        const value = token.slice(eqIndex + 1);
        params[key] = value;
      } else {
        params[token.slice(2)] = "true";
      }
      continue;
    }
    positional.push(token.replace(/^['"]|['"]$/g, ""));
  }

  const reviewLocked = WorkflowContext.isReviewLocked();
  if (reviewLocked && !REVIEW_LOCK_SAFE_COMMANDS.has(command)) {
    return { output: "⚠️ 当前工作流正在进行 Review。请等待完成或使用 /ads.review --show 查看报告。", exit: false };
  }

  switch (command) {
    case "ads.help":
      return {
        output: buildAdsHelpMessage("cli"),
      };

    case "ads.init": {
      const name = params.name ?? (positional.length > 0 ? positional.join(" ") : undefined);
      const response = await initWorkspace({ name });
      return { output: formatResponse(response) };
    }

    case "ads.branch": {
      let deleteMode: "none" | "soft" | "hard" = "none";
      let workflowArg: string | undefined;

      for (let i = 0; i < rawArgs.length; i += 1) {
        const token = rawArgs[i];

        if (token === "-d" || token === "--delete-context") {
          deleteMode = "soft";
          workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
          break;
        }

        if (token === "-D" || token === "--delete" || token === "--force-delete") {
          deleteMode = "hard";
          workflowArg = rawArgs.slice(i + 1).join(" ") || workflowArg;
          break;
        }

        if (token.startsWith("--delete=")) {
          deleteMode = "hard";
          workflowArg = token.slice("--delete=".length) || workflowArg;
          if (!workflowArg && i + 1 < rawArgs.length) {
            workflowArg = rawArgs[i + 1];
          }
          break;
        }

        if (token.startsWith("--delete-context=")) {
          deleteMode = "soft";
          workflowArg = token.slice("--delete-context=".length) || workflowArg;
          if (!workflowArg && i + 1 < rawArgs.length) {
            workflowArg = rawArgs[i + 1];
          }
          break;
        }
      }

      const operation = deleteMode === "hard" ? "force_delete" : deleteMode === "soft" ? "delete" : "list";
      const workflow = deleteMode === "none" ? undefined : workflowArg?.trim().replace(/^['"]|['"]$/g, "");

      const response = await listWorkflows({ operation, workflow });
      return { output: formatResponse(response) };
    }

    case "ads.checkout": {
      const identifier = params.workflow_identifier ?? positional[0];
      if (!identifier) {
        return { output: "❌ 需要提供工作流标识" };
      }
      const response = await checkoutWorkflow({ workflow_identifier: identifier, format: "cli" });
      return { output: formatResponse(response) };
    }

    case "ads.status": {
      const response = await getWorkflowStatusSummary({ format: "cli" });
      return { output: normalizeOutput(response) };
    }

    case "ads.log": {
      let limit: number | undefined;
      let workflowFilter: string | undefined;

      if (params.limit) {
        const parsed = Number(params.limit);
        if (Number.isFinite(parsed)) {
          limit = parsed;
        }
      }

      if (params.workflow) {
        workflowFilter = params.workflow;
      }

      if (positional.length > 0) {
        const candidate = Number(positional[0]);
        if (Number.isFinite(candidate)) {
          limit = candidate;
          positional.shift();
        }
      }

      if (!workflowFilter && positional.length > 0) {
        workflowFilter = positional.join(" ");
      }

      const normalizedLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : undefined;
      const response = await listWorkflowLog({
        limit: normalizedLimit,
        workflow: workflowFilter,
        format: "cli",
      });
      return { output: normalizeOutput(response) };
    }

    case "ads.new": {
      let templateArg = params.template_id?.trim();
      let titleArg = params.title?.trim();

      if (positional.length > 0 && !titleArg && !templateArg && positional.length >= 2) {
        templateArg = positional.shift()!.trim();
        titleArg = positional.join(" ").trim();
      } else if (positional.length > 0 && !titleArg) {
        titleArg = positional.join(" ").trim();
      }

      if (!titleArg) {
        return {
          output: "❌ 用法: /ads.new <标题> 或 /ads.new --title=... [--template_id=unified]",
        };
      }

      const response = await createWorkflowFromTemplate({
        template_id: templateArg,
        title: titleArg,
        description: params.description,
        format: "cli",
      });
      return { output: formatResponse(response) };
    }

    case "ads.commit": {
      if (!params.step_name && positional.length > 0) {
        params.step_name = positional.shift()!;
      }
      if (!params.step_name) {
        return { output: "❌ 用法: /ads.commit <step>" };
      }
      const response = await commitStep({ step_name: params.step_name, change_description: params.change_description, format: "cli" });
      return { output: normalizeOutput(response) };
    }

    case "ads.rules": {
      if (params.category || positional.length > 0) {
        const category = params.category ?? positional.join(" ");
        const response = await listRules({ category });
        return { output: formatResponse(response) };
      }
      const response = await readRules();
      return { output: normalizeOutput(response) };
    }

    case "ads.workspace": {
      const response = await getCurrentWorkspace();
      return { output: formatResponse(response) };
    }

    case "ads.sync": {
      const response = await syncAllNodesToFiles({});
      return { output: formatResponse(response) };
    }

    case "ads.review": {
      if (!params.skip && positional[0]?.toLowerCase() === "skip") {
        params.skip = positional.slice(1).join(" ");
      }
      const wantsShow = params.show === "true" || positional[0]?.toLowerCase() === "show";
      const workflowArg =
        params.workflow ??
        (wantsShow ? positional.slice(1).join(" ") : undefined);

      const agent =
        (params.agent as "codex" | "claude" | undefined) ??
        (["codex", "claude"].includes(positional[0]?.toLowerCase() ?? "") ? (positional.shift()!.toLowerCase() as "codex" | "claude") : undefined);

      const specOverride = parseBooleanParam(params.spec);
      const noSpecFlag =
        parseBooleanParam(params["no-spec"]) ??
        parseBooleanParam(params["no_spec"]) ??
        parseBooleanParam(params.nospec);
      let includeSpec = specOverride ?? false;
      let specMode: "default" | "forceInclude" | "forceExclude" =
        specOverride !== undefined ? (includeSpec ? "forceInclude" : "forceExclude") : "default";
      if (noSpecFlag !== undefined) {
        includeSpec = !noSpecFlag;
        specMode = includeSpec ? "forceInclude" : "forceExclude";
      }

      const commitFlagRef = resolveCommitRefParam(params.commit);
      let commitRef = commitFlagRef;
      if (!commitRef && positional[0]?.toLowerCase() === "commit") {
        commitRef = positional[1] && !positional[1].startsWith("--") ? positional[1] : undefined;
        commitRef = commitRef?.trim() || "HEAD";
      }
      if (commitRef) {
        commitRef = commitRef.trim() || "HEAD";
      }

      if (wantsShow) {
        const response = await showReviewReport({ workflowId: workflowArg });
        return { output: response };
      }

      if (params.skip) {
        const response = await skipReview({ reason: params.skip, requestedBy: "cli" });
        return { output: response };
      }

      const response = await runReview({ requestedBy: "cli", agent, includeSpec, commitRef, specMode });
      return { output: response };
    }

    default:
      return { output: `❓ 未知命令: /${command}` };
  }
}

function createStatusRenderer(
  startTime: number,
  throttleMs: number,
  logger: ConversationLogger,
  streamingEnabled: boolean,
  orchestrator: HybridOrchestrator,
): {
  handleEvent: (event: AgentEvent) => void;
  finish: () => void;
  cleanup: () => void;
  getAgentLabel: () => string;
} {
  let lastPrintedAt = 0;
  let lastPhase: AgentPhase | null = null;
  let lastMessageKey: string | null = null;
  let lastRendered = "";
  let dirty = false;
  let cursorHidden = false;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerIndex = 0;
  let currentEvent: AgentEvent | null = streamingEnabled ? createPlaceholderEvent(startTime) : null;

  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const isActivePhase = (phase: AgentPhase) =>
    phase !== "completed" && phase !== "error";

  const hideCursor = () => {
    if (!cursorHidden) {
      process.stdout.write("\u001B[?25l");
      cursorHidden = true;
    }
  };

  const showCursor = () => {
    if (cursorHidden) {
      process.stdout.write("\u001B[?25h");
      cursorHidden = false;
    }
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      spinnerIndex = 0;
    }
  };

  let agentLabel = describeActiveAgent(orchestrator);

  const render = (force = false) => {
    if (!streamingEnabled || !currentEvent) {
      return;
    }
    hideCursor();
    const now = Date.now();
    const elapsedSeconds = (now - startTime) / 1000;
    const spinner = isActivePhase(currentEvent.phase) ? spinnerFrames[spinnerIndex] : undefined;
    agentLabel = describeActiveAgent(orchestrator);
    const message = formatAgentStatus(currentEvent, elapsedSeconds, spinner, agentLabel);
    if (force || message !== lastRendered) {
      updateStatusLine(message);
      lastRendered = message;
      dirty = true;
    }
  };

  const startSpinner = () => {
    if (!streamingEnabled || spinnerTimer || !currentEvent || !isActivePhase(currentEvent.phase)) {
      return;
    }
    spinnerTimer = setInterval(() => {
      if (!currentEvent) {
        return;
      }
      if (!isActivePhase(currentEvent.phase)) {
        stopSpinner();
        render(true);
        return;
      }
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      render();
    }, Math.max(100, Math.min(throttleMs, 200)));
  };

  if (streamingEnabled && currentEvent) {
    render(true);
    startSpinner();
  }

  const handleEvent = (event: AgentEvent) => {
    logger.logEvent(event);
    if (!streamingEnabled) {
      return;
    }

    const now = Date.now();
    const messageKey = `${event.phase}|${event.title}|${event.detail ?? ""}`;
    const messageChanged = messageKey !== lastMessageKey;
    const shouldPrint =
      event.phase === "error" ||
      event.phase === "completed" ||
      lastPhase !== event.phase ||
      messageChanged ||
      now - lastPrintedAt >= throttleMs;

    if (!shouldPrint) {
      return;
    }

    lastPhase = event.phase;
    lastPrintedAt = now;
    lastMessageKey = messageKey;
    currentEvent = event;
    if (!isActivePhase(event.phase)) {
      stopSpinner();
      render(true);
      showCursor();
    } else {
      render(true);
      startSpinner();
    }
  };

  const finish = () => {
    if (!streamingEnabled || !dirty) {
      return;
    }
    stopSpinner();
    showCursor();
    process.stdout.write("\n");
    dirty = false;
  };

  const cleanup = () => {
    if (!streamingEnabled) {
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    stopSpinner();
    showCursor();
    lastPhase = null;
    lastMessageKey = null;
    lastRendered = "";
    dirty = false;
    currentEvent = null;
  };

  const getAgentLabel = () => agentLabel;

  return { handleEvent, finish, cleanup, getAgentLabel };
}

function createPlaceholderEvent(startTime: number): AgentEvent {
  const placeholderEvent: ThreadEvent = { type: "turn.started" };
  return {
    phase: "analysis",
    title: "处理中",
    timestamp: startTime,
    raw: placeholderEvent,
  };
}

const PHASE_LABEL: Record<AgentPhase, string> = {
  boot: "初始化",
  analysis: "分析请求",
  context: "读取上下文",
  editing: "修改文件",
  tool: "调用工具",
  command: "执行命令",
  responding: "生成回复",
  completed: "已完成",
  connection: "网络重连",
  error: "错误",
};

const PHASE_COLOR: Record<AgentPhase, (text: string) => string> = {
  boot: pc.cyan,
  analysis: pc.cyan,
  context: pc.blue,
  editing: pc.magenta,
  tool: pc.yellow,
  command: pc.yellow,
  responding: pc.green,
  completed: pc.green,
  connection: pc.yellow,
  error: pc.red,
};

function describeActiveAgent(orchestrator: HybridOrchestrator): string {
  const activeId = orchestrator.getActiveAgentId();
  const descriptor = orchestrator
    .listAgents()
    .find((entry) => entry.metadata.id === activeId);
  return descriptor?.metadata.name ?? activeId;
}

function formatAgentList(orchestrator: HybridOrchestrator): string {
  const activeId = orchestrator.getActiveAgentId();
  const descriptors = orchestrator.listAgents();
  if (descriptors.length === 0) {
    return "❌ 未检测到可用代理";
  }

  const lines = ["🤖 可用代理："];
  for (const entry of descriptors) {
    const prefix = entry.metadata.id === activeId ? "•" : "○";
    const state = entry.status.ready ? "可用" : entry.status.error ?? "未配置";
    lines.push(`${prefix} ${entry.metadata.name} (${entry.metadata.id}) - ${state}`);
  }
  lines.push(
    "\n使用 /agent <id> 切换当前主代理，例如 /agent claude；需要 Claude 协助时，请插入 <<<agent.claude ...>>> 指令块。",
  );
  return lines.join("\n");
}

function switchAgent(orchestrator: HybridOrchestrator, rawId: string): CommandResult {
  const normalized = rawId.toLowerCase();
  const target = orchestrator
    .listAgents()
    .find(
      (entry) =>
        entry.metadata.id.toLowerCase() === normalized ||
        entry.metadata.name.toLowerCase() === normalized,
    );
  if (!target) {
    return { output: `❌ 未知代理: ${rawId}` };
  }
  if (!target.status.ready) {
    return { output: `❌ ${target.metadata.name} 不可用: ${target.status.error ?? "未配置"}` };
  }
  orchestrator.switchAgent(target.metadata.id);
  return { output: `🤖 已切换至 ${target.metadata.name}` };
}

function formatAgentStatus(
  event: AgentEvent,
  elapsedSeconds: number | undefined,
  spinner: string | undefined,
  agentLabel: string,
): string {
  const phaseLabel = PHASE_LABEL[event.phase] ?? event.phase;
  const detail = event.detail ? ` (${event.detail})` : "";
  const timePart = elapsedSeconds !== undefined ? ` | ${elapsedSeconds.toFixed(1)}s` : "";
  const indicator = spinner ? `${spinner} ` : "";
  const base = `[${agentLabel}] ${indicator}${phaseLabel}${detail}${timePart}`;
  const colorize = PHASE_COLOR[event.phase];
  return colorize ? colorize(base) : base;
}

function updateStatusLine(message: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(message);
}

async function handleLine(
  line: string,
  logger: ConversationLogger,
  orchestrator: HybridOrchestrator,
): Promise<CommandResult> {
  const trimmed = line.trim();
  if (!trimmed) {
    return { output: "" };
  }

  if (trimmed === "/exit" || trimmed === "exit" || trimmed === "quit" || trimmed === "/quit") {
    return { output: "再见!", exit: true };
  }

  if (trimmed === "/help" || trimmed === "help") {
    return handleAdsCommand("ads.help", [], logger);
  }

  const slash = parseSlashCommand(trimmed);

  if (slash && slash.command.startsWith("ads.")) {
    const parts = trimmed.split(/\s+/);
    const rawArgs = parts.slice(1);
    return handleAdsCommand(slash.command, rawArgs, logger);
  }

  if (slash) {
    switch (slash.command) {
      case "reset":
      case "codex.reset":
        orchestrator.reset();
        return { output: "✅ 已重置代理会话" };
      case "codex.status":
      case "agent.status": {
        const status = orchestrator.status();
        const agentLabel = describeActiveAgent(orchestrator);
        return {
          output: status.ready
            ? `✅ ${agentLabel} 已就绪，可直接输入自然语言或 /model 等命令`
            : `❌ ${agentLabel} 未启用: ${status.error ?? "请配置凭证"}`,
        };
      }
      case "agent": {
        const agentArg = slash.body.trim();
        if (!agentArg) {
          return { output: formatAgentList(orchestrator) };
        }
        const normalized = agentArg.toLowerCase();
        if (normalized === "auto") {
          return {
            output: "❌ 自动模式已停用。需要 Claude 协助时，请在回复中插入 <<<agent.claude ...>>> 指令块。",
          };
        }
        if (normalized === "manual") {
          return {
            output: "ℹ️ 当前已处于手动协作模式，请按需使用 <<<agent.claude ...>>> 调用 Claude。",
          };
        }
        return switchAgent(orchestrator, agentArg);
      }
  default:
    return handleAgentInteraction(trimmed, orchestrator, logger);
  }
}

  return handleAgentInteraction(trimmed, orchestrator, logger);
}

async function main(): Promise<void> {
  const logger = new ConversationLogger();

  process.on("exit", () => logger.close());
  process.on("SIGINT", () => {
    logger.close();
    process.exit(0);
  });

  await ensureWorkspace(logger);
  const workspaceRoot = detectWorkspace();
  const systemPromptManager = new SystemPromptManager({
    workspaceRoot,
    reinjection: resolveReinjectionConfig("CLI"),
    logger: cliLogger.child("SystemPrompt"),
  });
  const agents = createAgentController(workspaceRoot, systemPromptManager);

  cliLogger.info("欢迎使用 ADS CLI，输入 /ads.help 查看可用命令。");
  cliLogger.info(`会话日志: ${logger.path}`);

  const activeLabel = describeActiveAgent(agents);
  const initialStatus = agents.status();
  if (initialStatus.ready) {
    cliLogger.info(`[${activeLabel}] 已连接，需要 Claude 时请插入 <<<agent.claude ...>>> 指令块。`);
  } else {
    cliLogger.warn(
      `[${activeLabel}] 未启用: ${initialStatus.error ?? "请配置 CODEX_API_KEY 或 ~/.codex"}`,
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    logger.logInput(line);
    try {
      const result = await handleLine(line, logger, agents);
      const output = normalizeOutput(result.output);
      if (output) {
        console.log(output);
      }
      logger.logOutput(output);
      if (result.exit) {
        rl.close();
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ ${message}`);
      logger.logError(message);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    logger.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
