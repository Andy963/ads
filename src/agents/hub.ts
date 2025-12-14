import type { Input } from "@openai/codex-sdk";

import { injectDelegationGuide } from "./delegation.js";
import {
  executeToolBlocks,
  injectToolGuide,
  stripToolBlocks,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolHooks,
} from "./tools.js";
import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { createLogger } from "../utils/logger.js";

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
}

export interface CollaborativeTurnResult extends AgentRunResult {
  delegations: DelegationSummary[];
  supervisorRounds: number;
}

const logger = createLogger("AgentHub");

const DELEGATION_REGEX = /<<<agent\.([a-z0-9_-]+)[\t ]*\n([\s\S]*?)>>>/gi;

function isStatefulAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
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
  let result = await orchestrator.invokeAgent(agentId, input, sendOptions);
  if (options.maxToolRounds <= 0) {
    return result;
  }

  const stateful = isStatefulAgent(agentId);
  const basePrompt = stateful ? "" : normalizeInputToText(input).trim();

  for (let round = 1; round <= options.maxToolRounds; round += 1) {
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

    result = await orchestrator.invokeAgent(agentId, nextInput, sendOptions);
  }

  logger.warn(`[AgentHub] Tool loop reached max rounds (${options.maxToolRounds}) for agent=${agentId}`);
  return {
    ...result,
    response: [
      stripToolBlocks(result.response).trim(),
      `⚠️ 已达到工具执行轮次上限（${options.maxToolRounds}），剩余工具调用未执行。`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim(),
  };
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

function applyGuides(input: Input, orchestrator: HybridOrchestrator, agentId: AgentIdentifier): Input {
  if (typeof input === "string") {
    const withTools = injectToolGuide(input, { activeAgentId: agentId });
    return injectDelegationGuide(withTools, orchestrator);
  }

  if (Array.isArray(input)) {
    const toolGuide = injectToolGuide("", { activeAgentId: agentId }).trim();
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
  },
): Promise<DelegationSummary[]> {
  const queue: DelegationDirective[] = extractDelegationDirectives(initialText, options.supervisorAgentId);
  if (queue.length === 0) {
    return [];
  }

  const results: DelegationSummary[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < options.maxDelegations) {
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
      const agentResult = await runAgentTurnWithTools(orchestrator, next.agentId, delegateInput, { streaming: false }, {
        maxToolRounds: options.maxToolRounds,
        toolContext: options.toolContext,
        toolHooks: options.toolHooks,
      });
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
  const maxSupervisorRounds = options.maxSupervisorRounds ?? 2;
  const maxDelegations = options.maxDelegations ?? 6;
  const maxToolRounds = options.maxToolRounds ?? 4;
  const activeAgentId = orchestrator.getActiveAgentId();
  const supervisorName = resolveAgentName(orchestrator, activeAgentId);

  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: options.outputSchema,
    signal: options.signal,
  };
  const toolContext: ToolExecutionContext = options.toolContext ?? { cwd: process.cwd() };

  const prompt = applyGuides(input, orchestrator, activeAgentId);
  let result: AgentRunResult = await runAgentTurnWithTools(orchestrator, activeAgentId, prompt, sendOptions, {
    maxToolRounds,
    toolContext,
    toolHooks: options.toolHooks,
  });

  let rounds = 0;
  const allDelegations: DelegationSummary[] = [];

  while (rounds < maxSupervisorRounds) {
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
      toolHooks: options.toolHooks,
    });
    allDelegations.push(...delegations);

    const supervisorPrompt = buildSupervisorPrompt(delegations, rounds, supervisorName);
    if (!supervisorPrompt.trim()) {
      break;
    }

    result = await runAgentTurnWithTools(orchestrator, activeAgentId, supervisorPrompt, sendOptions, {
      maxToolRounds,
      toolContext,
      toolHooks: options.toolHooks,
    });
  }

  const finalResponse = stripDelegationBlocks(result.response);
  return { ...result, response: finalResponse, delegations: allDelegations, supervisorRounds: rounds };
}

export function isExecutorAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}
