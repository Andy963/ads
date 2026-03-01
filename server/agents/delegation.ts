import type { Usage } from "./protocol/types.js";
import type { AgentIdentifier } from "./types.js";
import type { AgentRunResult } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";

import { extractDelegationDirectivesWithRanges } from "./delegationParser.js";

interface DelegationDirective {
  raw: string;
  start: number;
  end: number;
  agentId: AgentIdentifier;
  prompt: string;
}

export interface DelegationSummary {
  agentId: AgentIdentifier;
  agentName: string;
  prompt: string;
  response: string;
}

export interface DelegationHooks {
  onInvoke?: (agentId: AgentIdentifier, prompt: string) => void | Promise<void>;
  onResult?: (summary: DelegationSummary) => void | Promise<void>;
}

export interface DelegationOutcome {
  response: string;
  usage: Usage | null;
  summaries: DelegationSummary[];
}

export function supportsAutoDelegation(orchestrator: HybridOrchestrator): boolean {
  const agents = orchestrator.listAgents?.() ?? [];
  return agents.length > 1;
}

export function injectDelegationGuide(
  input: string,
  orchestrator: HybridOrchestrator,
): string {
  if (!supportsAutoDelegation(orchestrator)) {
    return input;
  }
  const activeAgentId = orchestrator.getActiveAgentId?.();
  const availableAgents = (orchestrator.listAgents?.() ?? [])
    .filter((agent) => agent.metadata.id !== activeAgentId)
    .map((agent) => ({ id: agent.metadata.id, name: agent.metadata.name }));

  if (availableAgents.length === 0) {
    return input;
  }

  const guide = [
    "【协作代理指令】",
    "当需要协作代理协助时，请输出以下格式的指令块：",
    ...availableAgents.flatMap((agent) => [
      `<<<agent.${agent.id}`,
      `在此填写要让 ${agent.name} 处理的任务，附带必要上下文、文件路径与输出要求。`,
      ">>>",
    ]),
    "系统会把指令发送给对应代理并返回结果，由你继续执行后续命令/修改。",
  ].join("\n");

  return `${input}\n\n${guide}`;
}

export async function resolveDelegations(
  result: AgentRunResult,
  orchestrator: HybridOrchestrator,
  hooks?: DelegationHooks,
): Promise<DelegationOutcome> {
  if (!supportsAutoDelegation(orchestrator)) {
    return { response: result.response, usage: result.usage, summaries: [] };
  }

  if (!orchestrator.invokeAgent) {
    return { response: result.response, usage: result.usage, summaries: [] };
  }

  const directives: DelegationDirective[] = extractDelegationDirectivesWithRanges(result.response).map((d) => ({
    raw: d.raw,
    start: d.start,
    end: d.end,
    agentId: d.agentId,
    prompt: d.prompt,
  }));
  let finalResponse = result.response;
  const summaries: DelegationSummary[] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  const runDelegation = async (agentId: AgentIdentifier, prompt: string) => {
    const agentName = resolveAgentName(orchestrator, agentId);
    await hooks?.onInvoke?.(agentId, prompt);
    try {
      const agentResult = await orchestrator.invokeAgent(agentId, prompt, { streaming: false });
      const summary: DelegationSummary = {
        agentId,
        agentName,
        prompt: prompt.trim(),
        response: agentResult.response,
      };
      summaries.push(summary);
      await hooks?.onResult?.(summary);
      return formatDelegationReplacement(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary: DelegationSummary = {
        agentId,
        agentName,
        prompt: prompt.trim(),
        response: `⚠️ 协作代理调用失败：${message}`,
      };
      summaries.push(summary);
      await hooks?.onResult?.(summary);
      return formatDelegationReplacement(summary);
    }
  };

  for (const directive of directives) {
    if (!orchestrator.hasAgent?.(directive.agentId)) {
      const summary: DelegationSummary = {
        agentId: directive.agentId,
        agentName: resolveAgentName(orchestrator, directive.agentId),
        prompt: directive.prompt.trim(),
        response: "⚠️ 协作代理未启用或未注册，已跳过。",
      };
      summaries.push(summary);
      await hooks?.onResult?.(summary);
      replacements.push({ start: directive.start, end: directive.end, text: formatDelegationReplacement(summary) });
      continue;
    }

    const replacement = await runDelegation(directive.agentId, directive.prompt);
    if (replacement) {
      replacements.push({ start: directive.start, end: directive.end, text: replacement });
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  for (const rep of replacements) {
    finalResponse = finalResponse.slice(0, rep.start) + rep.text + finalResponse.slice(rep.end);
  }

  return {
    response: finalResponse,
    usage: result.usage,
    summaries,
  };
}

function resolveAgentName(orchestrator: HybridOrchestrator, agentId: AgentIdentifier): string {
  const descriptor = orchestrator.listAgents?.().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

function formatDelegationReplacement(summary: DelegationSummary): string {
  const promptPreview =
    summary.prompt.length > 160
      ? `${summary.prompt.slice(0, 157)}…`
      : summary.prompt;

  return [
    `🤝 **${summary.agentName}（协作代理）已完成以下子任务**`,
    `> ${promptPreview}`,
    "",
    summary.response.trim(),
    "",
    "---",
  ].join("\n");
}
