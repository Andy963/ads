import type { Usage } from "@openai/codex-sdk";
import type { AgentRunResult } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";

const CLAUDE_AGENT_ID = "claude";
const GEMINI_AGENT_ID = "gemini";
const CODEX_AGENT_ID = "codex";
const AGENT_DELEGATION_REGEX = /<<<agent\.(claude|gemini)[\t ]*\n([\s\S]*?)>>>/gi;

type DelegationAgentId = typeof CLAUDE_AGENT_ID | typeof GEMINI_AGENT_ID;

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

export interface DelegationHooks {
  onInvoke?: (agentId: DelegationAgentId, prompt: string) => void | Promise<void>;
  onResult?: (summary: DelegationSummary) => void | Promise<void>;
}

export interface DelegationOutcome {
  response: string;
  usage: Usage | null;
  summaries: DelegationSummary[];
}

export function supportsAutoDelegation(orchestrator: HybridOrchestrator): boolean {
  return (
    (orchestrator.hasAgent?.(CLAUDE_AGENT_ID) ?? false) ||
    (orchestrator.hasAgent?.(GEMINI_AGENT_ID) ?? false)
  );
}

export function injectDelegationGuide(
  input: string,
  orchestrator: HybridOrchestrator,
): string {
  if (!supportsAutoDelegation(orchestrator)) {
    return input;
  }
  if (orchestrator.getActiveAgentId?.() !== CODEX_AGENT_ID) {
    return input;
  }

  const availableAgents: { id: DelegationAgentId; name: string }[] = [];
  if (orchestrator.hasAgent?.(CLAUDE_AGENT_ID)) {
    availableAgents.push({ id: CLAUDE_AGENT_ID, name: "Claude" });
  }
  if (orchestrator.hasAgent?.(GEMINI_AGENT_ID)) {
    availableAgents.push({ id: GEMINI_AGENT_ID, name: "Gemini" });
  }

  const guide = [
    "【协作代理指令】",
    "默认由 Codex 负责执行命令/修改文件；协作代理用于补充建议、审阅与长文本输出。",
    "（可选）若启用 ENABLE_AGENT_EXEC_TOOL=1，Claude/Gemini 也可通过 <<<tool.exec ...>>> 执行白名单内命令。",
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
  if (
    result.agentId !== CODEX_AGENT_ID ||
    !supportsAutoDelegation(orchestrator)
  ) {
    return { response: result.response, usage: result.usage, summaries: [] };
  }

  const directives = extractDelegationBlocks(result.response);
  let finalResponse = result.response;
  const summaries: DelegationSummary[] = [];

  const runDelegation = async (agentId: DelegationAgentId, prompt: string) => {
    if (!orchestrator.invokeAgent) {
      return null;
    }
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
      finalResponse = finalResponse.replace(directive.raw, formatDelegationReplacement(summary));
      continue;
    }

    const replacement = await runDelegation(directive.agentId, directive.prompt);
    if (replacement) {
      finalResponse = finalResponse.replace(directive.raw, replacement);
    }
  }

  return {
    response: finalResponse,
    usage: result.usage,
    summaries,
  };
}

function extractDelegationBlocks(response: string): DelegationDirective[] {
  const directives: DelegationDirective[] = [];
  let match: RegExpExecArray | null;
  while ((match = AGENT_DELEGATION_REGEX.exec(response)) !== null) {
    const rawAgentId = (match[1] ?? "").trim().toLowerCase();
    const agentId =
      rawAgentId === GEMINI_AGENT_ID ? GEMINI_AGENT_ID : CLAUDE_AGENT_ID;
    directives.push({
      raw: match[0],
      agentId,
      prompt: (match[2] ?? "").trim(),
    });
  }
  return directives;
}

function resolveAgentName(orchestrator: HybridOrchestrator, agentId: DelegationAgentId): string {
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
