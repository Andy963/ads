import type { AgentIdentifier } from "../types.js";
import type { HybridOrchestrator } from "../orchestrator.js";

import { createAbortError } from "../../utils/abort.js";
import { createLogger } from "../../utils/logger.js";

import { SupervisorVerdictSchema, extractJsonPayload } from "../tasks/schemas.js";

import type { CollaborationHooks, DelegationDirective, DelegationSummary } from "./types.js";

import { extractDelegationDirectivesWithRanges, stripDelegationDirectives } from "../delegationParser.js";

const logger = createLogger("AgentHub");

export function stripDelegationBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const directives = extractDelegationDirectivesWithRanges(text, { requirePrompt: false });
  const stripped = stripDelegationDirectives(text, directives).trim();
  return stripped.replace(/\n{3,}/g, "\n\n");
}

export function looksLikeSupervisorVerdict(text: string): boolean {
  const payload = extractJsonPayload(text);
  if (!payload) {
    return false;
  }
  try {
    const parsed = JSON.parse(payload);
    return SupervisorVerdictSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

export function extractDelegationDirectives(text: string, excludeAgentId?: AgentIdentifier): DelegationDirective[] {
  return extractDelegationDirectivesWithRanges(text, { excludeAgentId, requirePrompt: true }).map((d) => ({
    raw: d.raw,
    agentId: d.agentId,
    prompt: d.prompt,
  }));
}

export function resolveAgentName(orchestrator: HybridOrchestrator, agentId: AgentIdentifier): string {
  const descriptor = orchestrator.listAgents().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

export async function runDelegationQueue(
  orchestrator: HybridOrchestrator,
  initialText: string,
  options: {
    maxDelegations: number;
    hooks?: CollaborationHooks;
    supervisorAgentId: AgentIdentifier;
    signal?: AbortSignal;
    env?: Record<string, string>;
  },
): Promise<DelegationSummary[]> {
  const queue: DelegationDirective[] = extractDelegationDirectives(initialText, options.supervisorAgentId);
  if (queue.length === 0) {
    return [];
  }

  const results: DelegationSummary[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < options.maxDelegations) {
    if (options.signal?.aborted) {
      throw createAbortError("用户中断了请求");
    }
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
      const agentResult = await orchestrator.invokeAgent(next.agentId, next.prompt, {
        streaming: false,
        signal: options.signal,
        env: options.env,
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
