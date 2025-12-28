import type { Input } from "@openai/codex-sdk";

import { injectDelegationGuide } from "./delegation.js";
import {
  executeToolBlocks,
  injectToolGuide,
  stripToolBlocks,
  type ToolCallSummary,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolHooks,
} from "./tools.js";
import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { createLogger } from "../utils/logger.js";
import { ActivityTracker, resolveExploredConfig, type ExploredEntry, type ExploredEntryCallback } from "../utils/activityTracker.js";

interface DelegationDirective {
  raw: string;
  agentId: AgentIdentifier;
  prompt: string;
}

export interface DelegationSummary {
  agentId: AgentIdentifier;
  agentName: string;
  prompt: string;
  response: string;
}

export interface CollaborationHooks {
  onDelegationStart?: (summary: { agentId: AgentIdentifier; agentName: string; prompt: string }) => void | Promise<void>;
  onDelegationResult?: (summary: DelegationSummary) => void | Promise<void>;
  onSupervisorRound?: (round: number, directives: number) => void | Promise<void>;
}

export interface CollaborativeTurnOptions extends AgentSendOptions {
  maxSupervisorRounds?: number;
  maxDelegations?: number;
  maxToolRounds?: number;
  toolContext?: ToolExecutionContext;
  toolHooks?: ToolHooks;
  hooks?: CollaborationHooks;
  onExploredEntry?: ExploredEntryCallback;
}

export interface CollaborativeTurnResult extends AgentRunResult {
  delegations: DelegationSummary[];
  supervisorRounds: number;
  explored?: ExploredEntry[];
}

const logger = createLogger("AgentHub");

const DELEGATION_REGEX = /<<<agent\.([a-z0-9_-]+)[\t ]*\n([\s\S]*?)>>>/gi;

function createAbortError(message = "用户中断了请求"): Error {
  const abortError = new Error(message);
  abortError.name = "AbortError";
  return abortError;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isStatefulAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}

function shouldRunToolLoop(agentId: AgentIdentifier): boolean {
  return agentId !== "claude";
}

function parseMaxRounds(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["0", "off", "none", "unlimited", "infinite", "inf"].includes(normalized)) {
    return 0;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function resolveDefaultMaxToolRounds(): number {
  const parsed =
    parseMaxRounds(process.env.ADS_AGENT_MAX_TOOL_ROUNDS) ??
    parseMaxRounds(process.env.AGENT_MAX_TOOL_ROUNDS);
  // 默认不限制：避免轻易打断“主代理执行完整任务”的闭环
  return parsed ?? 0;
}

function normalizeInputToText(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((part) => {
        const current = part as { type?: string; text?: string; path?: string };
        if (current.type === "text" && typeof current.text === "string") {
          return current.text;
        }
        if (current.type === "local_image") {
          return `[image:${current.path ?? "blob"}]`;
        }
        return current.type ? `[${current.type}]` : "[content]";
      })
      .join("\n\n");
  }
  return String(input);
}

function buildToolFeedbackPrompt(toolResults: ToolExecutionResult[], round: number): string {
  const truncatePayload = (text: string, limit = 1200) => {
    const trimmed = text.trim();
    if (trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, Math.max(0, limit - 1))}…`;
  };

  const header = [
    "系统已执行你上一条回复中的工具调用，并返回结果。",
    "请基于这些结果继续完成任务；如果仍需调用工具，请继续输出 <<<tool.*>>> 指令块。",
    `（工具回合：${round}）`,
    "",
  ].join("\n");

  const body = toolResults
    .map((result, idx) => {
      const title = `【工具结果 ${idx + 1}】tool.${result.tool} (${result.ok ? "ok" : "fail"})`;
      const payloadLine = result.payload ? `payload:\n${truncatePayload(result.payload)}` : "";
      return [title, payloadLine, result.output.trim()].filter(Boolean).join("\n\n");
    })
    .join("\n\n---\n\n");

  return [header, body].filter(Boolean).join("\n").trim();
}

async function runAgentTurnWithTools(
  orchestrator: HybridOrchestrator,
  agentId: AgentIdentifier,
  input: Input,
  sendOptions: AgentSendOptions,
  options: { maxToolRounds: number; toolContext: ToolExecutionContext; toolHooks?: ToolHooks },
): Promise<AgentRunResult> {
  throwIfAborted(sendOptions.signal);
  const agentSendOptions: AgentSendOptions = {
    ...sendOptions,
    toolContext: options.toolContext,
    toolHooks: options.toolHooks,
  };
  let result = await orchestrator.invokeAgent(agentId, input, agentSendOptions);

  const stateful = isStatefulAgent(agentId);
  const basePrompt = stateful ? "" : normalizeInputToText(input).trim();
  const unlimited = options.maxToolRounds <= 0;
  if (!shouldRunToolLoop(agentId)) {
    return result;
  }

  for (let round = 1; unlimited || round <= options.maxToolRounds; round += 1) {
    throwIfAborted(sendOptions.signal);
    const executed = await executeToolBlocks(result.response, options.toolHooks, options.toolContext);
    if (executed.results.length === 0) {
      return result;
    }

    const feedback = buildToolFeedbackPrompt(executed.results, round);
    const nextInput = stateful
      ? feedback
      : [
          basePrompt,
          "",
          "你上一条回复（已去掉工具块）：",
          stripToolBlocks(result.response).trim(),
          "",
          feedback,
        ]
          .filter(Boolean)
          .join("\n\n")
          .trim();

    result = await orchestrator.invokeAgent(agentId, nextInput, agentSendOptions);
  }

  logger.warn(`[AgentHub] Tool loop reached max rounds (${options.maxToolRounds}) for agent=${agentId}`);
  return { ...result, response: stripToolBlocks(result.response).trim() };
}

function stripDelegationBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const regex = new RegExp(DELEGATION_REGEX.source, DELEGATION_REGEX.flags);
  const stripped = text.replace(regex, "").trim();
  return stripped.replace(/\n{3,}/g, "\n\n");
}

function extractDelegationDirectives(text: string, excludeAgentId?: AgentIdentifier): DelegationDirective[] {
  const directives: DelegationDirective[] = [];
  const regex = new RegExp(DELEGATION_REGEX.source, DELEGATION_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const agentId = (match[1] ?? "").trim().toLowerCase();
    const prompt = (match[2] ?? "").trim();
    if (!prompt) {
      continue;
    }
    if (excludeAgentId && agentId === excludeAgentId) {
      continue;
    }
    directives.push({
      raw: match[0],
      agentId,
      prompt,
    });
  }
  return directives;
}

function resolveAgentName(orchestrator: HybridOrchestrator, agentId: AgentIdentifier): string {
  const descriptor = orchestrator.listAgents().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

function applyGuides(
  input: Input,
  orchestrator: HybridOrchestrator,
  agentId: AgentIdentifier,
  invokeAgentEnabled?: boolean,
): Input {
  if (typeof input === "string") {
    const withTools = injectToolGuide(input, { activeAgentId: agentId, invokeAgentEnabled });
    return injectDelegationGuide(withTools, orchestrator);
  }

  if (Array.isArray(input)) {
    const toolGuide = injectToolGuide("", { activeAgentId: agentId, invokeAgentEnabled }).trim();
    const delegationGuide = injectDelegationGuide("", orchestrator).trim();
    const guide = [toolGuide, delegationGuide].filter(Boolean).join("\n\n").trim();
    if (!guide) {
      return input;
    }
    return [{ type: "text", text: guide }, ...input];
  }

  return input;
}

function buildSupervisorPrompt(
  summaries: DelegationSummary[],
  rounds: number,
  supervisorName: string,
): string {
  const header = [
    "系统已执行你上一轮输出的协作代理指令块，并拿到了结果。",
    `你仍然是主管（${supervisorName}）：需要整合、落地并验收这些结果。`,
    "要求：",
    "- 只要可以落地，就直接修改代码/运行必要命令（你有权限）。",
    "- 验收：检查前端/后端接口契约是否一致、类型/字段是否匹配、错误处理是否到位。",
    "- 若仍需协作代理继续，可以继续输出 <<<agent.{agentId} ...>>> 指令块。",
    "- 若不再需要协作代理，则不要输出任何 <<<agent.*>>> 指令块，直接给用户最终结果与下一步验证方式。",
    "",
    `（协作轮次：${rounds}）`,
  ].join("\n");

  const body = summaries
    .map((summary, idx) => {
      const agentLabel = `${summary.agentName} (${summary.agentId})`;
      return [
        `---`,
        `【协作结果 ${idx + 1}】${agentLabel}`,
        `任务：${summary.prompt.trim()}`,
        "",
        summary.response.trim(),
      ].join("\n");
    })
    .join("\n\n");

  return [header, body].filter(Boolean).join("\n\n").trim();
}

async function runDelegationQueue(
  orchestrator: HybridOrchestrator,
  initialText: string,
  options: {
    maxDelegations: number;
    hooks?: CollaborationHooks;
    supervisorAgentId: AgentIdentifier;
    maxToolRounds: number;
    toolContext: ToolExecutionContext;
    toolHooks?: ToolHooks;
    signal?: AbortSignal;
  },
): Promise<DelegationSummary[]> {
  const queue: DelegationDirective[] = extractDelegationDirectives(initialText, options.supervisorAgentId);
  if (queue.length === 0) {
    return [];
  }

  const results: DelegationSummary[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < options.maxDelegations) {
    throwIfAborted(options.signal);
    const next = queue.shift();
    if (!next) {
      break;
    }
    const signature = `${next.agentId}::${next.prompt}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);

    if (!orchestrator.hasAgent(next.agentId)) {
      const agentName = resolveAgentName(orchestrator, next.agentId);
      const summary: DelegationSummary = {
        agentId: next.agentId,
        agentName,
        prompt: next.prompt,
        response: "⚠️ 协作代理未启用或未注册，已跳过。",
      };
      results.push(summary);
      await options.hooks?.onDelegationResult?.(summary);
      continue;
    }

    const agentName = resolveAgentName(orchestrator, next.agentId);
    await options.hooks?.onDelegationStart?.({ agentId: next.agentId, agentName, prompt: next.prompt });
    try {
      const delegateInput = injectToolGuide(next.prompt, { activeAgentId: next.agentId });
      const agentResult = await runAgentTurnWithTools(
        orchestrator,
        next.agentId,
        delegateInput,
        { streaming: false, signal: options.signal },
        {
          maxToolRounds: options.maxToolRounds,
          toolContext: options.toolContext,
          toolHooks: options.toolHooks,
        },
      );
      const summary: DelegationSummary = {
        agentId: next.agentId,
        agentName,
        prompt: next.prompt,
        response: agentResult.response,
      };
      results.push(summary);
      await options.hooks?.onDelegationResult?.(summary);

      const nested = extractDelegationDirectives(agentResult.response, options.supervisorAgentId);
      for (const directive of nested) {
        queue.push(directive);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary: DelegationSummary = {
        agentId: next.agentId,
        agentName,
        prompt: next.prompt,
        response: `⚠️ 协作代理调用失败：${message}`,
      };
      results.push(summary);
      await options.hooks?.onDelegationResult?.(summary);
    }
  }

  if (queue.length > 0) {
    logger.warn(`[AgentHub] Delegation queue truncated (${results.length}/${options.maxDelegations})`);
  }

  return results;
}

export async function runCollaborativeTurn(
  orchestrator: HybridOrchestrator,
  input: Input,
  options: CollaborativeTurnOptions = {},
): Promise<CollaborativeTurnResult> {
  const exploredConfig = resolveExploredConfig();
  const exploredTracker = exploredConfig.enabled ? new ActivityTracker(options.onExploredEntry) : null;
  const toolHooks = (() => {
    if (!exploredTracker) {
      return options.toolHooks;
    }
    return {
      onInvoke: async (tool: string, payload: string) => {
        try {
          exploredTracker.ingestToolInvoke(tool, payload);
        } catch {
          // ignore
        }
        await options.toolHooks?.onInvoke?.(tool, payload);
      },
      onResult: async (summary: ToolCallSummary) => {
        await options.toolHooks?.onResult?.(summary);
      },
    };
  })();

  const unsubscribeExplored = exploredTracker
    ? orchestrator.onEvent((event) => {
        try {
          exploredTracker.ingestThreadEvent(event.raw);
        } catch {
          // ignore
        }
      })
    : () => undefined;

  const maxSupervisorRounds = options.maxSupervisorRounds ?? 2;
  const maxDelegations = options.maxDelegations ?? 6;
  const maxToolRounds = options.maxToolRounds ?? resolveDefaultMaxToolRounds();
  const activeAgentId = orchestrator.getActiveAgentId();
  const supervisorName = resolveAgentName(orchestrator, activeAgentId);

  // outputSchema 只对 codex 有效，gemini/claude 不支持结构化输出
  const supportsStructuredOutput = activeAgentId === "codex";
  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: supportsStructuredOutput ? options.outputSchema : undefined,
    signal: options.signal,
  };
  const toolContext: ToolExecutionContext = options.toolContext ?? { cwd: process.cwd() };

  // 提供 invokeAgent 能力，允许 Agent 通过工具调用其他 Agent
  if (!toolContext.invokeAgent) {
    toolContext.invokeAgent = async (agentId: string, prompt: string) => {
      const agentResult = await runAgentTurnWithTools(
        orchestrator,
        agentId as AgentIdentifier,
        injectToolGuide(prompt, { activeAgentId: agentId }),
        { streaming: false, signal: options.signal },
        {
          maxToolRounds: maxToolRounds,
          toolContext,
          toolHooks,
        },
      );
      return agentResult.response;
    };
  }

  const prompt = applyGuides(input, orchestrator, activeAgentId, !!toolContext.invokeAgent);
  try {
    let result: AgentRunResult = await runAgentTurnWithTools(orchestrator, activeAgentId, prompt, sendOptions, {
      maxToolRounds,
      toolContext,
      toolHooks,
    });

    let rounds = 0;
    const allDelegations: DelegationSummary[] = [];

    while (rounds < maxSupervisorRounds) {
      throwIfAborted(options.signal);
      const directives = extractDelegationDirectives(result.response, activeAgentId);
      if (directives.length === 0) {
        break;
      }

      rounds += 1;
      await options.hooks?.onSupervisorRound?.(rounds, directives.length);
      const delegations = await runDelegationQueue(orchestrator, result.response, {
        maxDelegations,
        hooks: options.hooks,
        supervisorAgentId: activeAgentId,
        maxToolRounds,
        toolContext,
        toolHooks,
        signal: options.signal,
      });
      allDelegations.push(...delegations);

      const supervisorPrompt = buildSupervisorPrompt(delegations, rounds, supervisorName);
      if (!supervisorPrompt.trim()) {
        break;
      }

      result = await runAgentTurnWithTools(orchestrator, activeAgentId, supervisorPrompt, sendOptions, {
        maxToolRounds,
        toolContext,
        toolHooks,
      });
    }

    const explored = exploredTracker
      ? exploredTracker.compact({ maxItems: exploredConfig.maxItems, dedupe: exploredConfig.dedupe })
      : undefined;
    const finalResponse = stripDelegationBlocks(result.response);
    return { ...result, response: finalResponse, delegations: allDelegations, supervisorRounds: rounds, explored };
  } finally {
    unsubscribeExplored();
  }
}

export function isExecutorAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}
