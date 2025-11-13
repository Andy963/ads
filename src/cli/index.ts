#!/usr/bin/env node

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
import { CodexSession } from "./codexChat.js";
import type { AgentEvent, AgentPhase } from "../codex/events.js";
import { WorkflowContext } from "../workspace/context.js";
import {
  cancelIntake,
  getActiveIntakeState,
  handleIntakeAnswer,
  startIntake,
} from "../intake/service.js";
import pc from "picocolors";

const YES_SET = new Set([
  "y",
  "yes",
  "是",
  "是的",
  "好",
  "好的",
  "确认",
  "ok",
  "可以",
  "行",
  "要",
]);

const NO_SET = new Set([
  "n",
  "no",
  "否",
  "不是",
  "不用",
  "不要",
  "算了",
  "取消",
  "不了",
]);

let pendingIntakeRequest: string | null = null;

interface CommandResult {
  output: string;
  exit?: boolean;
}

const PROMPT = "ADS> ";

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

function formatResponse(text: string): string {
  if (!text.trim()) {
    return "(无输出)";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) {
      return `❌ ${parsed.error}`;
    }
    if (parsed.success && parsed.message) {
      return parsed.message;
    }
    if (parsed.message) {
      return parsed.message;
    }
    if (parsed.templates && Array.isArray(parsed.templates)) {
      const lines: string[] = [];
      lines.push("可用模板:");
      parsed.templates.forEach((tpl: any, index: number) => {
        const title = tpl.name ?? tpl.id ?? `模板${index + 1}`;
        const desc = tpl.description ? ` - ${tpl.description}` : "";
        const steps = tpl.steps ? ` (步骤: ${tpl.steps})` : "";
        const idLabel = tpl.id ? ` [${tpl.id}]` : "";
        lines.push(`${index + 1}. ${title}${idLabel}${steps}${desc}`);
      });
      return lines.join("\n");
    }
    if (parsed.path && parsed.db_path) {
      const lines: string[] = [];
      lines.push("工作空间信息:");
      lines.push(`  根目录: ${parsed.path}`);
      lines.push(`  数据库: ${parsed.db_path}`);
      if (parsed.rules_dir) {
        lines.push(`  规则目录: ${parsed.rules_dir}`);
      }
      if (parsed.specs_dir) {
        lines.push(`  规格目录: ${parsed.specs_dir}`);
      }
      if (parsed.name) {
        lines.push(`  名称: ${parsed.name}`);
      }
      if (parsed.created_at) {
        lines.push(`  创建时间: ${parsed.created_at}`);
      }
      if (parsed.version) {
        lines.push(`  版本: ${parsed.version}`);
      }
      lines.push(`  已初始化: ${parsed.is_initialized ? "是" : "否"}`);
      return lines.join("\n");
    }
    if (parsed.workspace && typeof parsed.workspace === "object") {
      const ws = parsed.workspace as Record<string, unknown>;
      const lines: string[] = [];
      lines.push("工作空间信息:");
      if (ws.path) lines.push(`  根目录: ${ws.path}`);
      if (ws.db_path) lines.push(`  数据库: ${ws.db_path}`);
      if (ws.rules_dir) lines.push(`  规则目录: ${ws.rules_dir}`);
      if (ws.specs_dir) lines.push(`  规格目录: ${ws.specs_dir}`);
      if (ws.name) lines.push(`  名称: ${ws.name}`);
      if (ws.created_at) lines.push(`  创建时间: ${ws.created_at}`);
      if (ws.version) lines.push(`  版本: ${ws.version}`);
      if (ws.is_initialized !== undefined) {
        lines.push(`  已初始化: ${ws.is_initialized ? "是" : "否"}`);
      }
      return lines.join("\n");
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function normalizeOutput(text: string): string {
  return text || "(无输出)";
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

async function handleCodexInteraction(input: string, codex: CodexSession, logger: ConversationLogger): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { output: "" };
  }

  const status = codex.status();
  if (!status.ready) {
    const reason = status.error ?? "请设置 CODEX_API_KEY 或配置 ~/.codex";
    return { output: `❌ Codex 未启用: ${reason}` };
  }

  try {
    const streamingConfig = codex.getStreamingConfig();
    const startTime = Date.now();
    if (!streamingConfig.enabled) {
      const thinking = "⌛ Codex 正在思考...";
      cliLogger.info(thinking);
      logger.logOutput(thinking);
    }
    const renderer = createStatusRenderer(startTime, streamingConfig.throttleMs, logger, streamingConfig.enabled);
    const unsubscribe = codex.onEvent(renderer.handleEvent);
    const clarification = buildRequirementClarificationPrompt();
    const finalPrompt = clarification ? `${clarification}\n\n用户输入: ${trimmed}` : trimmed;
    try {
      const result = await codex.send(finalPrompt);
      const elapsed = (Date.now() - startTime) / 1000;
      renderer.finish();
      if (!streamingConfig.enabled) {
        const summary = `[Codex] 耗时 ${elapsed.toFixed(1)}s`;
        cliLogger.info(summary);
        logger.logOutput(summary);
      }
      return { output: result.response || "(Codex 无响应)" };
    } finally {
      unsubscribe();
      renderer.cleanup();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `❌ Codex 调用失败: ${message}` };
  }
}

async function handleAdsCommand(command: string, rawArgs: string[], _logger: ConversationLogger): Promise<CommandResult> {
  const positional: string[] = [];
  const params: Record<string, string> = {};

  for (const token of rawArgs) {
    const match = token.match(/^--([^=]+)=(.+)$/);
    if (match) {
      params[match[1]] = match[2];
    } else {
      positional.push(token.replace(/^['"]|['"]$/g, ""));
    }
  }

  switch (command) {
    case "ads.help":
      return {
        output: buildAdsHelpMessage("cli"),
      };

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
      const response = await checkoutWorkflow({ workflow_identifier: identifier });
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
      const response = await commitStep({ step_name: params.step_name, change_description: params.change_description });
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

    case "ads.cancel-intake": {
      pendingIntakeRequest = null;
      const result = await cancelIntake();
      return { output: result.messages.join("\n") };
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
): {
  handleEvent: (event: AgentEvent) => void;
  finish: () => void;
  cleanup: () => void;
} {
  let lastPrintedAt = 0;
  let lastPhase: AgentPhase | null = null;
  let lastMessageKey: string | null = null;
  let lastRendered = "";
  let dirty = false;
  let cursorHidden = false;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerIndex = 0;
  let currentEvent: AgentEvent | null = streamingEnabled
    ? {
        phase: "analysis",
        title: "处理中",
        timestamp: startTime,
        raw: { type: "turn.started" } as any,
      }
    : null;

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

  const render = (force = false) => {
    if (!streamingEnabled || !currentEvent) {
      return;
    }
    hideCursor();
    const now = Date.now();
    const elapsedSeconds = (now - startTime) / 1000;
    const spinner = isActivePhase(currentEvent.phase) ? spinnerFrames[spinnerIndex] : undefined;
    const message = formatAgentStatus(currentEvent, elapsedSeconds, spinner);
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

  return { handleEvent, finish, cleanup };
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

function formatAgentStatus(event: AgentEvent, elapsedSeconds?: number, spinner?: string): string {
  const phaseLabel = PHASE_LABEL[event.phase] ?? event.phase;
  const detail = event.detail ? ` (${event.detail})` : "";
  const timePart = elapsedSeconds !== undefined ? ` | ${elapsedSeconds.toFixed(1)}s` : "";
  const indicator = spinner ? `${spinner} ` : "";
  const base = `[Codex] ${indicator}${phaseLabel}${detail}${timePart}`;
  const colorize = PHASE_COLOR[event.phase];
  return colorize ? colorize(base) : base;
}

function updateStatusLine(message: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(message);
}

async function maybeHandleAutoIntake(input: string, codex: CodexSession): Promise<CommandResult | null> {
  if (!input) {
    return null;
  }

  if (pendingIntakeRequest) {
    return null;
  }

  if (WorkflowContext.getActiveWorkflow()) {
    return null;
  }

  const status = codex.status();
  if (!status.ready) {
    return null;
  }

  try {
    const classification = await codex.classifyInput(input);
    if (classification === "task") {
      pendingIntakeRequest = input;
      const preview = input.length > 48 ? `${input.slice(0, 48)}…` : input;
      return {
        output: `检测到你可能提出了新的任务需求：「${preview}」。是否创建工作流？(y/n，可用 /ads.cancel-intake 取消)`,
      };
    }
  } catch (error) {
    if (process.env.ADS_DEBUG === "1") {
      console.warn("自动识别需求失败:", error);
    }
  }

  return null;
}

async function handleLine(line: string, logger: ConversationLogger, codex: CodexSession): Promise<CommandResult> {
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

  if (pendingIntakeRequest) {
    const normalized = trimmed.toLowerCase();
    if (slash) {
      if (slash.command === "ads.cancel" || slash.command === "ads.cancel-intake") {
        pendingIntakeRequest = null;
        return { output: "已取消自动创建工作流的操作。" };
      }
      return {
        output: "❗ 请先回答是否需要创建新的工作流（y/n），如需取消请输入 /ads.cancel-intake。",
      };
    }

    if (YES_SET.has(normalized) || YES_SET.has(trimmed)) {
      const request = pendingIntakeRequest;
      pendingIntakeRequest = null;
      const result = await startIntake(request);
      return { output: result.messages.join("\n") };
    }

    if (NO_SET.has(normalized) || NO_SET.has(trimmed)) {
      pendingIntakeRequest = null;
      return {
        output: "好的，不会自动创建工作流。如需手动创建可使用 /ads.new。",
      };
    }

    return {
      output: "请回答是否需要创建新的工作流：输入 y 确认，或 n 放弃（可用 /ads.cancel-intake 取消）。",
    };
  }

  const intakeState = await getActiveIntakeState();
  if (intakeState) {
    if (slash) {
      if (slash.command === "ads.cancel-intake" || slash.command === "ads.cancel") {
        const result = await cancelIntake();
        return { output: result.messages.join("\n") };
      }
      return {
        output: "❗ 当前正在进行需求澄清，请先回答问题或输入 /ads.cancel-intake 取消。",
      };
    }

    const result = await handleIntakeAnswer(trimmed);
    return { output: result.messages.join("\n") };
  }

  if (slash && slash.command.startsWith("ads.")) {
    const parts = trimmed.split(/\s+/);
    const rawArgs = parts.slice(1);
    return handleAdsCommand(slash.command, rawArgs, logger);
  }

  if (slash) {
    switch (slash.command) {
      case "reset":
      case "codex.reset":
        codex.reset();
        return { output: "✅ 已重置 Codex 会话" };
      case "codex.status": {
        const status = codex.status();
        return {
          output: status.ready
            ? "✅ Codex 已就绪，可直接输入自然语言或 /model 等命令"
            : `❌ Codex 未启用: ${status.error ?? "请配置 CODEX_API_KEY"}`,
        };
      }
      default:
        return handleCodexInteraction(trimmed, codex, logger);
    }
  }

  const autoIntakeResult = await maybeHandleAutoIntake(trimmed, codex);
  if (autoIntakeResult) {
    return autoIntakeResult;
  }

  return handleCodexInteraction(trimmed, codex, logger);
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
  const codex = new CodexSession({
    workingDirectory: workspaceRoot,
    systemPromptManager,
  });

  cliLogger.info("欢迎使用 ADS CLI，输入 /ads.help 查看可用命令。");
  cliLogger.info(`会话日志: ${logger.path}`);

  const codexStatus = codex.status();
  if (codexStatus.ready) {
    cliLogger.info("[Codex] 已连接，直接输入自然语言即可对话。");
  } else {
    cliLogger.warn(`[Codex] 未启用: ${codexStatus.error ?? "请配置 CODEX_API_KEY 或 ~/.codex"}`);
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
      const result = await handleLine(line, logger, codex);
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
