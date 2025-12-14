import type { Input } from "@openai/codex-sdk";

import { injectDelegationGuide } from "./delegation.js";
import { injectToolGuide } from "./tools.js";
import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { createLogger } from "../utils/logger.js";

type DelegationAgentId = "claude" | "gemini";

interface DelegationDirective {
  raw: string;
  agentId: DelegationAgentId;
  prompt: string;
}

export interface DelegationSummary {
  agentId: DelegationAgentId;
  agentName: string;
  prompt: string;
  response: string;
}

export interface CollaborationHooks {
  onDelegationStart?: (summary: { agentId: DelegationAgentId; agentName: string; prompt: string }) => void | Promise<void>;
  onDelegationResult?: (summary: DelegationSummary) => void | Promise<void>;
  onSupervisorRound?: (round: number, directives: number) => void | Promise<void>;
}

export interface CollaborativeTurnOptions extends AgentSendOptions {
  maxSupervisorRounds?: number;
  maxDelegations?: number;
  hooks?: CollaborationHooks;
}

export interface CollaborativeTurnResult extends AgentRunResult {
  delegations: DelegationSummary[];
  supervisorRounds: number;
}

const logger = createLogger("AgentHub");

const DELEGATION_REGEX = /<<<agent\.(claude|gemini)[\t ]*\n([\s\S]*?)>>>/gi;

function stripDelegationBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const regex = new RegExp(DELEGATION_REGEX.source, DELEGATION_REGEX.flags);
  const stripped = text.replace(regex, "").trim();
  return stripped.replace(/\n{3,}/g, "\n\n");
}

function extractDelegationDirectives(text: string): DelegationDirective[] {
  const directives: DelegationDirective[] = [];
  let match: RegExpExecArray | null;
  while ((match = DELEGATION_REGEX.exec(text)) !== null) {
    const agentId = (match[1] ?? "").trim().toLowerCase() as DelegationAgentId;
    const prompt = (match[2] ?? "").trim();
    if (!prompt) {
      continue;
    }
    directives.push({
      raw: match[0],
      agentId: agentId === "gemini" ? "gemini" : "claude",
      prompt,
    });
  }
  return directives;
}

function resolveAgentName(orchestrator: HybridOrchestrator, agentId: DelegationAgentId): string {
  const descriptor = orchestrator.listAgents().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

function applyGuides(input: Input, orchestrator: HybridOrchestrator): Input {
  if (typeof input === "string") {
    const withTools = injectToolGuide(input);
    return injectDelegationGuide(withTools, orchestrator);
  }

  if (Array.isArray(input)) {
    const toolGuide = injectToolGuide("").trim();
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
): string {
  const header = [
    "系统已执行你上一轮输出的协作代理指令块，并拿到了结果。",
    "你仍然是主管（Codex）：需要整合、落地并验收这些结果，确保与现有后端/接口对接一致。",
    "要求：",
    "- 只要可以落地，就直接修改代码/运行必要命令（你有权限）。",
    "- 验收：检查前端/后端接口契约是否一致、类型/字段是否匹配、错误处理是否到位。",
    "- 若仍需协作代理继续（例如需要补充 UI、文案、组件、样式、可访问性等），可以继续输出 <<<agent.gemini ...>>> / <<<agent.claude ...>>>。",
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
  options: { maxDelegations: number; hooks?: CollaborationHooks },
): Promise<DelegationSummary[]> {
  const queue: DelegationDirective[] = extractDelegationDirectives(initialText);
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
      const agentResult = await orchestrator.invokeAgent(next.agentId, next.prompt, { streaming: false });
      const summary: DelegationSummary = {
        agentId: next.agentId,
        agentName,
        prompt: next.prompt,
        response: agentResult.response,
      };
      results.push(summary);
      await options.hooks?.onDelegationResult?.(summary);

      const nested = extractDelegationDirectives(agentResult.response);
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
  const activeAgentId = orchestrator.getActiveAgentId();

  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: options.outputSchema,
    signal: options.signal,
  };

  const prompt = applyGuides(input, orchestrator);
  let result: AgentRunResult = await orchestrator.send(prompt, sendOptions);

  if (activeAgentId !== "codex") {
    return { ...result, delegations: [], supervisorRounds: 0 };
  }

  let rounds = 0;
  const allDelegations: DelegationSummary[] = [];

  while (rounds < maxSupervisorRounds) {
    const directives = extractDelegationDirectives(result.response);
    if (directives.length === 0) {
      break;
    }

    rounds += 1;
    await options.hooks?.onSupervisorRound?.(rounds, directives.length);
    const delegations = await runDelegationQueue(orchestrator, result.response, {
      maxDelegations,
      hooks: options.hooks,
    });
    allDelegations.push(...delegations);

    const supervisorPrompt = buildSupervisorPrompt(delegations, rounds);
    if (!supervisorPrompt.trim()) {
      break;
    }

    result = await orchestrator.send(supervisorPrompt, sendOptions);
  }

  const finalResponse = stripDelegationBlocks(result.response);
  return { ...result, response: finalResponse, delegations: allDelegations, supervisorRounds: rounds };
}

export function isExecutorAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}
