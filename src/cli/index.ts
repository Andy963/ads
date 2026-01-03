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
import { GeminiAgentAdapter } from "../agents/adapters/geminiAdapter.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import { runCollaborativeTurn } from "../agents/hub.js";
import type { AgentEvent, AgentPhase } from "../codex/events.js";
import { resolveClaudeAgentConfig, resolveGeminiAgentConfig } from "../agents/config.js";
import type { AgentAdapter } from "../agents/types.js";
import { WorkflowContext } from "../workspace/context.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import pc from "picocolors";
import { runReview, skipReview, showReviewReport } from "../review/service.js";
import { HistoryStore } from "../utils/historyStore.js";
import { parseBooleanParam, resolveCommitRefParam } from "../utils/commandParams.js";
import { normalizeOutput, truncateForLog } from "../utils/text.js";
import { stripLeadingTranslation } from "../utils/assistantText.js";
import { ADS_STRUCTURED_OUTPUT_SCHEMA, formatPlanForCli, parseStructuredOutput } from "../utils/structuredOutput.js";
import { REVIEW_LOCK_SAFE_COMMANDS } from "../utils/reviewLock.js";
import { setStatusLineManager, withStatusLineSuppressed } from "../utils/statusLineManager.js";
import { stringDisplayWidth, truncateToWidth } from "../utils/terminalText.js";
import { SearchTool } from "../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../tools/search/config.js";
import { formatSearchResults } from "../tools/search/format.js";
import { formatExploredEntry, type ExploredEntry } from "../utils/activityTracker.js";
import { formatLocalSearchOutput, searchWorkspaceFiles } from "../utils/localSearch.js";
import { processAdrBlocks } from "../utils/adrRecording.js";
import { runVectorSearch, syncVectorSearch } from "../vectorSearch/run.js";
import { TaskStore } from "../agents/tasks/taskStore.js";

interface CommandResult {
  output: string;
  exit?: boolean;
  reset?: boolean;
  history?: {
    role: string;
    kind?: string;
  };
}

const PROMPT = "ADS> ";
const SHOW_ELAPSED_TIME = process.env.ADS_CLI_SHOW_TIME === "1";

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

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes("aborted") ||
      message.includes("abort") ||
      message.includes("interrupted") ||
      message.includes("用户中断") ||
      message.includes("中断")
    );
  }
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError";
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

  const geminiConfig = resolveGeminiAgentConfig();
  if (geminiConfig.enabled) {
    adapters.push(new GeminiAgentAdapter({ config: geminiConfig }));
  }

  return new HybridOrchestrator({
    adapters,
    defaultAgentId: "codex",
    initialWorkingDirectory: workspaceRoot,
    systemPromptManager,
  });
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
        "如果信息已经足够，请用“请问是让我……？”句式简要复述需求、范围、交付物、约束，并询问是否继续。",
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
  options?: { memory?: string; signal?: AbortSignal },
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
    if (options?.memory?.trim()) {
      promptSections.push(`Memory (user-confirmed):\n${options.memory.trim()}`);
    }
    promptSections.push(`用户输入: ${trimmed}`);
    const basePrompt = promptSections.join("\n\n");
    let exploredHeaderPrinted = false;
    const handleExploredEntry = (entry: ExploredEntry) => {
      withStatusLineSuppressed(() => {
        if (!exploredHeaderPrinted) {
          process.stdout.write("Explored\n");
          exploredHeaderPrinted = true;
        }
        process.stdout.write(`${formatExploredEntry(entry)}\n`);
      });
    };
    try {
      const result = await runCollaborativeTurn(orchestrator, basePrompt, {
        signal: options?.signal,
        outputSchema: ADS_STRUCTURED_OUTPUT_SCHEMA,
        onExploredEntry: handleExploredEntry,
        hooks: {
          onSupervisorRound: (round, directives) =>
            logger.logOutput(`[Auto] 协作轮次 ${round}（指令块 ${directives}）`),
          onDelegationStart: ({ agentId, prompt }) =>
            logger.logOutput(`[Auto] 调用 ${agentId} 协助：${truncateForLog(prompt)}`),
          onDelegationResult: (summary) =>
            logger.logOutput(`[Auto] ${summary.agentName} 完成：${truncateForLog(summary.prompt)}`),
        },
        toolHooks: {
          onInvoke: (tool, payload) => logger.logOutput(`[Tool] ${tool}: ${truncateForLog(payload)}`),
          onResult: (summary) =>
            logger.logOutput(
              `[Tool] ${summary.tool} ${summary.ok ? "完成" : "失败"}: ${truncateForLog(summary.outputPreview)}`,
            ),
        },
        toolContext: {
          cwd: process.cwd(),
          allowedDirs: process.env.ALLOWED_DIRS
            ? process.env.ALLOWED_DIRS.split(",").map((dir) => dir.trim()).filter(Boolean)
            : [process.cwd()],
          signal: options?.signal,
          historyNamespace: "cli",
          historySessionId: "default",
        },
      });
      renderer.finish();
      if (exploredHeaderPrinted) {
        process.stdout.write("\n");
      }
      if (!streamingConfig.enabled && SHOW_ELAPSED_TIME) {
        const elapsed = (Date.now() - startTime) / 1000;
        const summary = `[${renderer.getAgentLabel()}] 耗时 ${elapsed.toFixed(1)}s`;
        cliLogger.info(summary);
        logger.logOutput(summary);
      }
      const rawResponse =
        typeof result.response === "string" ? result.response : String(result.response ?? "");
      const cleanedResponse = stripLeadingTranslation(rawResponse);
      const structured = parseStructuredOutput(cleanedResponse);
      const finalAnswer =
        structured?.answer?.trim() ? structured.answer.trim() : cleanedResponse;
      const planText = structured?.plan?.length ? formatPlanForCli(structured.plan) : null;
      const baseAnswerText = finalAnswer || "(代理无响应)";
      let finalAnswerText = baseAnswerText;
      try {
        const adrProcessed = processAdrBlocks(baseAnswerText, detectWorkspace());
        finalAnswerText = adrProcessed.finalText || baseAnswerText;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finalAnswerText = `${baseAnswerText}\n\n---\nADR warning: failed to record ADR (${message})`;
      }
      const finalText = planText ? `${planText}\n\n${finalAnswerText}` : finalAnswerText;
      return { output: finalText };
    } finally {
      unsubscribe();
      renderer.cleanup();
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
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
      const titleArg = (params.title ?? positional.join(" ")).trim();
      const templateArg = params.template_id?.trim();

      if (!titleArg) {
        return {
          output: "❌ 用法: /ads.new <标题>",
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

    case "ads.tasks": {
      const wantsActive =
        params.active === "true" ||
        params["active-only"] === "true" ||
        params.active_only === "true" ||
        params.activeOnly === "true" ||
        positional[0]?.toLowerCase() === "active";

      if (positional[0]?.toLowerCase() === "active") {
        positional.shift();
      }

      let limit: number | undefined;
      if (params.limit) {
        const parsed = Number(params.limit);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.floor(parsed);
        }
      }

      if (!limit && positional.length > 0) {
        const parsed = Number(positional[0]);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.floor(parsed);
        }
      }

      const store = new TaskStore({
        workspaceRoot: detectWorkspace(),
        namespace: "cli",
        sessionId: "default",
      });
      const tasks = store.listTasks({ limit, activeOnly: wantsActive });
      if (tasks.length === 0) {
        return { output: wantsActive ? "（无进行中的任务）" : "（暂无任务记录）" };
      }

      const lines: string[] = [];
      lines.push(`Tasks (${wantsActive ? "active" : "all"}):`);
      for (const task of tasks) {
        const when = new Date(task.updatedAt || task.createdAt || Date.now()).toISOString();
        const err = task.lastError ? ` err=${task.lastError}` : "";
        lines.push(
          `- ${task.status} taskId=${task.taskId} agent=${task.agentId} rev=${task.revision} attempts=${task.attempts} updated=${when}${err}`,
        );
      }
      return { output: lines.join("\n") };
    }

    case "ads.review": {
      if (!params.skip && positional[0]?.toLowerCase() === "skip") {
        params.skip = positional.slice(1).join(" ");
      }
      if (params.skip === "true" && positional.length > 0) {
        params.skip = positional.join(" ");
      }
      const wantsShow = params.show === "true" || positional[0]?.toLowerCase() === "show";

      if (wantsShow) {
        const workflowCandidate =
          positional[0]?.toLowerCase() === "show" ? positional.slice(1).join(" ") : positional.join(" ");
        const workflowId = (params.workflow ?? workflowCandidate).trim();
        const response = await showReviewReport({ workflowId: workflowId || undefined });
        return { output: response };
      }

      if (params.skip) {
        const response = await skipReview({ reason: params.skip, requestedBy: "cli" });
        return { output: response };
      }

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

  if (streamingEnabled) {
    setStatusLineManager({
      isActive: () => Boolean(process.stdout.isTTY && dirty && lastRendered),
      clear: () => {
        if (!process.stdout.isTTY) {
          return;
        }
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
      },
      render: () => {
        if (!process.stdout.isTTY || !dirty || !lastRendered) {
          return;
        }
        updateStatusLine(lastRendered);
      },
    });
  }

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
    const elapsedSeconds = SHOW_ELAPSED_TIME ? (now - startTime) / 1000 : undefined;
    // In non-TTY mode, don't show spinner animation
    const spinner = process.stdout.isTTY && isActivePhase(currentEvent.phase)
      ? spinnerFrames[spinnerIndex]
      : undefined;
    agentLabel = describeActiveAgent(orchestrator);
    const message = formatAgentStatus(currentEvent, elapsedSeconds, spinner, agentLabel);
    if (force || message !== lastRendered) {
      // force=true means significant state change, output in non-TTY mode
      updateStatusLine(message, force);
      lastRendered = message;
      dirty = true;
    }
  };

  const startSpinner = () => {
    // Only animate spinner in TTY mode to avoid log flooding
    if (!process.stdout.isTTY) {
      return;
    }
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
    // In TTY mode, we need newline to finalize the status line
    // In non-TTY mode, we already output newlines with each status update
    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }
    dirty = false;
  };

  const cleanup = () => {
    if (!streamingEnabled) {
      return;
    }
    setStatusLineManager(null);
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
    "\n使用 /agent <id> 切换当前主代理（如 /agent gemini）。当主代理为 Codex 时，会在需要前端/文案等场景自动调用 Claude/Gemini 协作并整合验收。",
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
  const timePart = elapsedSeconds !== undefined ? ` | ${elapsedSeconds.toFixed(1)}s` : "";
  const indicator = spinner ? `${spinner} ` : "";
  const prefix = `[${agentLabel}] ${indicator}${phaseLabel}`;

  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  const maxCols =
    typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? Math.max(20, Math.floor(columns)) : null;

  const timeWidth = stringDisplayWidth(timePart);
  let renderedPrefix = prefix;
  if (maxCols && stringDisplayWidth(renderedPrefix) + timeWidth > maxCols) {
    renderedPrefix = truncateToWidth(renderedPrefix, Math.max(0, maxCols - timeWidth));
  }

  let detail = "";
  const normalizeDetail = (text: string) => text.trim().replace(/\s+/g, " ");
  if (event.detail) {
    const softLimit = maxCols ?? 80;
    const baseWidth = stringDisplayWidth(renderedPrefix) + timeWidth;
    const available = Math.max(0, softLimit - baseWidth - 3 /* space + () */);
    if (available >= 8) {
      const trimmed = truncateToWidth(normalizeDetail(event.detail), available);
      detail = ` (${trimmed})`;
    }
  }

  const softLimit = maxCols ?? 80;
  let base = `${renderedPrefix}${detail}${timePart}`;
  base = truncateToWidth(base, softLimit);
  const colorize = PHASE_COLOR[event.phase];
  return colorize ? colorize(base) : base;
}

function updateStatusLine(message: string, forceNewLine = false): void {
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(message);
  } else if (forceNewLine) {
    // In non-TTY mode, only output on significant state changes (not spinner updates)
    process.stdout.write(`${message}\n`);
  }
}

function enableBracketedPaste(): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return () => { };
  }

  let disabled = false;
  try {
    // Ask the terminal to wrap pasted text with \x1b[200~ ... \x1b[201~ so we can treat it as one block.
    process.stdout.write("\u001b[?2004h");
  } catch {
    // ignore
  }

  return () => {
    if (disabled) {
      return;
    }
    disabled = true;
    try {
      process.stdout.write("\u001b[?2004l");
    } catch {
      // ignore
    }
  };
}

async function handleLine(
  line: string,
  logger: ConversationLogger,
  orchestrator: HybridOrchestrator,
  workspaceRoot: string,
  signal?: AbortSignal,
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
      case "vsearch": {
        const query = slash.body.trim();
        const output = await runVectorSearch({ workspaceRoot, query, entryNamespace: "cli" });
        const note =
          "ℹ️ 提示：系统会在后台自动用向量召回来补齐 agent 上下文；/vsearch 主要用于手动调试/查看原始召回结果。";
        const decorated = output.startsWith("Vector search results for:") ? `${note}\n\n${output}` : output;
        return { output: decorated, history: { role: "status", kind: "command" } };
      }
      case "vsearch.sync": {
        console.log(pc.cyan("⏳ 正在同步向量索引..."));
        const result = await syncVectorSearch({ workspaceRoot });
        if (result.ok) {
          return { output: pc.green(`✅ ${result.message}`), history: { role: "status", kind: "command" } };
        } else {
          return { output: pc.red(`❌ ${result.message}`), history: { role: "status", kind: "command" } };
        }
      }
      case "search": {
        const query = slash.body.trim();
        if (!query) {
          return { output: "用法: /search <query>", history: { role: "status", kind: "command" } };
        }
        const config = resolveSearchConfig();
        const missingKeys = ensureApiKeys(config);
        if (missingKeys) {
          const local = searchWorkspaceFiles({ workspaceRoot, query });
          return { output: formatLocalSearchOutput({ query, ...local }), history: { role: "status", kind: "command" } };
        }
        try {
          const result = await SearchTool.search({ query }, { config });
          return {
            output: formatSearchResults(query, result),
            history: { role: "status", kind: "command" },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { output: `❌ /search 失败: ${message}`, history: { role: "status", kind: "command" } };
        }
      }
      case "reset":
      case "codex.reset":
        orchestrator.reset();
        return { output: "✅ 已重置代理会话", reset: true };
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
        let agentArg = slash.body.trim();
        if (!agentArg) {
          return { output: formatAgentList(orchestrator) };
        }
        const normalized = agentArg.toLowerCase();
        const aliasMode = normalized === "auto" || normalized === "manual";
        if (aliasMode) {
          agentArg = "codex";
        }
        const switchResult = switchAgent(orchestrator, agentArg);
        if (aliasMode) {
          return { output: `${switchResult.output}\nℹ️ 协作代理由 Codex 按需自动调用。` };
        }
        return switchResult;
      }
      default:
        break;
    }
  }

  return handleAgentInteraction(trimmed, orchestrator, logger, { signal });
}

async function main(): Promise<void> {
  const logger = new ConversationLogger();
  const legacyHistoryPath = path.join(process.cwd(), ".ads", "cli-history.json");
  const historyStore = new HistoryStore({
    storagePath: path.join(process.cwd(), ".ads", "state.db"),
    namespace: "cli",
    migrateFromPaths: [legacyHistoryPath],
    maxEntriesPerSession: 300,
    maxTextLength: 6000,
  });
  const historyKey = "default";
  const START_PASTE = "\x1b[200~";
  const END_PASTE = "\x1b[201~";
  const PASTE_MARKER_TAIL = Math.max(START_PASTE.length, END_PASTE.length) - 1;
  const pasteWindowEnv = Number(process.env.ADS_CLI_PASTE_WINDOW_MS);
  const PASTE_LINE_WINDOW_MS =
    Number.isFinite(pasteWindowEnv) && pasteWindowEnv >= 0 ? pasteWindowEnv : 160;
  let pasteActive = false;
  let pasteBuffer = "";
  let suppressLineFromPaste = false;
  let pendingPasteStart = "";
  let lineBuffer: string[] = [];
  let lineFlushTimer: NodeJS.Timeout | null = null;
  const disableBracketedPaste = enableBracketedPaste();
  let handleInterrupt: (() => void) | null = null;

  process.on("exit", () => {
    disableBracketedPaste();
    logger.close();
  });
  process.on("SIGINT", () => {
    if (handleInterrupt) {
      handleInterrupt();
      return;
    }
    disableBracketedPaste();
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
    cliLogger.info(
      `[${activeLabel}] 已连接。若已配置 Claude/Gemini，Codex 会按需调度协作；用 /agent 查看/切换主代理。`,
    );
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

  let activeAbortController: AbortController | null = null;
  const pendingInputs: string[] = [];
  let processingInputs = false;
  let interruptInFlight = false;
  let skipPromptOnce = false;
  const pendingMultilineLines: string[] = [];
  let pasteLinePrefix = "";

  const clearBufferedInput = () => {
    pendingInputs.length = 0;
    lineBuffer = [];
    if (lineFlushTimer) {
      clearTimeout(lineFlushTimer);
      lineFlushTimer = null;
    }
    pendingMultilineLines.length = 0;
    pasteLinePrefix = "";
  };

  const handleUserInput = async (input: string, signal: AbortSignal) => {
    logger.logInput(input);
    historyStore.add(historyKey, { role: "user", text: input, ts: Date.now() });
    try {
      const result = await handleLine(input, logger, agents, workspaceRoot, signal);
      const output = normalizeOutput(result.output);
      const role = result.history?.role ?? "ai";
      const cleanedOutput = role === "ai" ? stripLeadingTranslation(output) : output;
      if (cleanedOutput) {
        process.stdout.write(cleanedOutput.endsWith("\n") ? cleanedOutput : `${cleanedOutput}\n`);
        historyStore.add(historyKey, {
          role,
          text: cleanedOutput,
          ts: Date.now(),
          kind: result.history?.kind,
        });
      }
      logger.logOutput(cleanedOutput);
      if (result.exit) {
        rl.close();
        return;
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        const message = "⏹ 已中止";
        if (!interruptInFlight) {
          process.stdout.write(`${message}\n`);
          logger.logOutput(message);
          historyStore.add(historyKey, { role: "status", text: message, ts: Date.now(), kind: "abort" });
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`❌ ${message}\n`);
        logger.logError(message);
        historyStore.add(historyKey, { role: "status", text: message, ts: Date.now(), kind: "error" });
      }
    }
    interruptInFlight = false;
    if (skipPromptOnce) {
      skipPromptOnce = false;
      return;
    }
    rl.prompt();
  };

  const processInputQueue = async () => {
    if (processingInputs) {
      return;
    }
    processingInputs = true;
    try {
      while (pendingInputs.length > 0) {
        const next = pendingInputs.shift();
        if (!next) {
          continue;
        }
        activeAbortController = new AbortController();
        try {
          await handleUserInput(next, activeAbortController.signal);
        } finally {
          activeAbortController = null;
        }
      }
    } finally {
      processingInputs = false;
    }
  };

  const enqueueUserInput = (input: string) => {
    pendingInputs.push(input);
    void processInputQueue();
  };

  const flushBufferedLines = () => {
    if (lineFlushTimer) {
      clearTimeout(lineFlushTimer);
      lineFlushTimer = null;
    }
    if (lineBuffer.length === 0) {
      return;
    }
    const bufferedLines = lineBuffer;
    lineBuffer = [];
    if (bufferedLines.length > 1) {
      pendingMultilineLines.push(...bufferedLines);
      return;
    }
    enqueueUserInput(bufferedLines[0] ?? "");
  };

  const enqueueLine = (line: string) => {
    lineBuffer.push(line);
    if (lineFlushTimer) {
      clearTimeout(lineFlushTimer);
      lineFlushTimer = null;
    }
    lineFlushTimer = setTimeout(flushBufferedLines, PASTE_LINE_WINDOW_MS);
  };

  const requestInterrupt = () => {
    const controller = activeAbortController;
    const shouldAbort = Boolean(controller && !controller.signal.aborted);
    interruptInFlight = shouldAbort;
    if (shouldAbort) {
      skipPromptOnce = true;
    }
    clearBufferedInput();
    if (shouldAbort) {
      controller?.abort();
    }
    if (process.stdin.isTTY) {
      rl.write("", { ctrl: true, name: "u" });
    }
    rl.prompt();
  };

  handleInterrupt = requestInterrupt;
  rl.on("SIGINT", requestInterrupt);

  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", (_chunk: string, key: { name?: string; sequence?: string } | undefined) => {
      if (!key) {
        return;
      }
      if (key.name !== "escape") {
        return;
      }
      const maybePastePrefix = (() => {
        const tail = pendingPasteStart;
        if (!tail) {
          return false;
        }
        for (let len = 1; len < START_PASTE.length; len += 1) {
          if (tail.endsWith(START_PASTE.slice(0, len))) {
            return true;
          }
        }
        return false;
      })();
      if (pasteActive || suppressLineFromPaste || maybePastePrefix) {
        return;
      }
      requestInterrupt();
    });
    process.stdin.prependListener("data", (chunk: Buffer | string) => {
      const dataStr = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Detect bracketed paste (common in modern terminals) even if the markers are split across multiple chunks
      if (!pasteActive) {
        pendingPasteStart += dataStr;
        const startIdx = pendingPasteStart.indexOf(START_PASTE);
        if (startIdx === -1) {
          // keep a short tail so we can still match if the marker is split across chunks
          if (pendingPasteStart.length > PASTE_MARKER_TAIL) {
            pendingPasteStart = pendingPasteStart.slice(-PASTE_MARKER_TAIL);
          }
          return;
        }
        pasteActive = true;
        suppressLineFromPaste = true;
        const rlState = rl as unknown as { line?: unknown; cursor?: unknown };
        const currentLine = typeof rlState.line === "string" ? String(rlState.line) : "";
        const cursor =
          typeof rlState.cursor === "number" && Number.isFinite(rlState.cursor) ? rlState.cursor : currentLine.length;
        pasteLinePrefix = currentLine.slice(0, Math.max(0, Math.min(cursor, currentLine.length)));
        pasteBuffer = pendingPasteStart.slice(startIdx + START_PASTE.length);
        pendingPasteStart = "";
      } else {
        pasteBuffer += dataStr;
      }

      const endIdx = pasteBuffer.indexOf(END_PASTE);
      if (endIdx === -1) {
        return;
      }

      const block = pasteBuffer.slice(0, endIdx);
      const remaining = pasteBuffer.slice(endIdx + END_PASTE.length);
      pasteActive = false;
      pasteBuffer = "";
      queueMicrotask(() => {
        suppressLineFromPaste = false;
      });
      if (block.includes("\n") || block.includes("\r")) {
        const normalized = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = normalized.split("\n");
        if (lines.length > 1) {
          const firstLine = `${pasteLinePrefix}${lines[0] ?? ""}`;
          pendingMultilineLines.push(firstLine, ...lines.slice(1, -1));
        } else if (lines[0]) {
          pendingMultilineLines.push(`${pasteLinePrefix}${lines[0]}`);
        }
      }
      pasteLinePrefix = "";
      // If user keeps typing right after paste end, push the rest back into readline
      if (remaining) {
        rl.write(remaining);
      }
    });
  }

  rl.on("line", async (line) => {
    if (suppressLineFromPaste) {
      return;
    }
    if (pendingMultilineLines.length > 0) {
      const payload = [...pendingMultilineLines, line].join("\n");
      pendingMultilineLines.length = 0;
      enqueueUserInput(payload);
      return;
    }
    enqueueLine(line);
  });

  rl.on("close", () => {
    flushBufferedLines();
    disableBracketedPaste();
    logger.close();
    process.exit(0);
  });
}

main().catch((error) => {
  cliLogger.error("启动失败", error);
  process.exit(1);
});
