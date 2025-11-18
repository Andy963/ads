import type { Usage } from "@openai/codex-sdk";
import type { AgentRunResult } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";

export type AgentMode = "manual" | "auto";

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
  mode: AgentMode,
): string {
  if (mode !== "auto") {
    return input;
  }
  if (!supportsAutoDelegation(orchestrator)) {
    return input;
  }
  if (orchestrator.getActiveAgentId?.() !== CODEX_AGENT_ID) {
    return input;
  }

  const guide = [
    "【Claude 协作指令】",
    "当需要 Claude 协助（如前端稿、长文撰写等）时，请输出以下格式的指令块：",
    "<<<agent.claude",
    "在此填写要让 Claude 处理的任务描述，使用中文或英文均可。",
    "描述应包含足够上下文，例如目标、期望输出格式或注意事项。",
    ">>>",
    "系统会自动调用 Claude 并将结果返回给你，无需手动提示用户。",
  ].join("\n");

  return `${input}\n\n${guide}`;
}

export async function resolveDelegations(
  result: AgentRunResult,
  orchestrator: HybridOrchestrator,
  mode: AgentMode,
  hooks?: DelegationHooks,
): Promise<DelegationOutcome> {
  if (
    mode !== "auto" ||
    result.agentId !== CODEX_AGENT_ID ||
    !supportsAutoDelegation(orchestrator)
  ) {
    return { response: result.response, usage: result.usage, summaries: [] };
  }

  const directives = extractDelegationBlocks(result.response);
  if (directives.length === 0) {
    return { response: result.response, usage: result.usage, summaries: [] };
  }

  let finalResponse = result.response;
  const summaries: DelegationSummary[] = [];

  for (const directive of directives) {
    await hooks?.onInvoke?.(directive.prompt);
    const claudeResult = await orchestrator.invokeAgent?.(CLAUDE_AGENT_ID, directive.prompt, {
      streaming: false,
    });
    if (!claudeResult) {
      continue;
    }

    const summary: DelegationSummary = {
      prompt: directive.prompt.trim(),
      response: claudeResult.response,
    };
    summaries.push(summary);
    await hooks?.onResult?.(summary);

    const replacement = formatClaudeReplacement(summary);
    finalResponse = finalResponse.replace(directive.raw, replacement);
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
    "🤝 **Claude（自动代理）已完成以下子任务：**",
    `> ${promptPreview}`,
    "",
    summary.response.trim(),
    "",
    "---",
  ].join("\n");
}
