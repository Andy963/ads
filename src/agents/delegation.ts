import type { Usage } from "@openai/codex-sdk";
import type { AgentRunResult } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";

const CLAUDE_AGENT_ID = "claude";
const CODEX_AGENT_ID = "codex";
const CLAUDE_DELEGATION_REGEX = /<<<agent\.claude[\t ]*\n([\s\S]*?)>>>/gi;

interface DelegationDirective {
  raw: string;
  prompt: string;
}

export interface DelegationSummary {
  prompt: string;
  response: string;
}

export interface DelegationHooks {
  onInvoke?: (prompt: string) => void | Promise<void>;
  onResult?: (summary: DelegationSummary) => void | Promise<void>;
}

export interface DelegationOutcome {
  response: string;
  usage: Usage | null;
  summaries: DelegationSummary[];
}

export function supportsAutoDelegation(orchestrator: HybridOrchestrator): boolean {
  return orchestrator.hasAgent?.(CLAUDE_AGENT_ID) ?? false;
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

  const guide = [
    "【Claude 协作指令】",
    "Codex 负责命令/后端，Claude 擅长前端界面与长文本说明。",
    "当需要 Claude 协助时，请输出以下格式的指令块：",
    "<<<agent.claude",
    "在此填写要让 Claude 处理的任务，附带必要上下文、文件路径与输出要求。",
    ">>>",
    "系统会把指令发送给 Claude 并返回结果，由你继续执行后续命令/修改。",
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

  const runDelegation = async (prompt: string) => {
    if (!orchestrator.invokeAgent) {
      return null;
    }
    await hooks?.onInvoke?.(prompt);
    const claudeResult = await orchestrator.invokeAgent(CLAUDE_AGENT_ID, prompt, { streaming: false });
    if (!claudeResult) {
      return null;
    }
    const summary: DelegationSummary = {
      prompt: prompt.trim(),
      response: claudeResult.response,
    };
    summaries.push(summary);
    await hooks?.onResult?.(summary);
    return formatClaudeReplacement(summary);
  };

  for (const directive of directives) {
    const replacement = await runDelegation(directive.prompt);
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
  while ((match = CLAUDE_DELEGATION_REGEX.exec(response)) !== null) {
    directives.push({
      raw: match[0],
      prompt: (match[1] ?? "").trim(),
    });
  }
  return directives;
}

function formatClaudeReplacement(summary: DelegationSummary): string {
  const promptPreview =
    summary.prompt.length > 160
      ? `${summary.prompt.slice(0, 157)}…`
      : summary.prompt;

  return [
    "🤝 **Claude（协作代理）已完成以下子任务**",
    `> ${promptPreview}`,
    "",
    summary.response.trim(),
    "",
    "---",
  ].join("\n");
}
