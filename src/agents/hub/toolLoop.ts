import type { Input } from "@openai/codex-sdk";

import { createLogger } from "../../utils/logger.js";

import { executeToolBlocks, stripToolBlocks, type ToolExecutionContext, type ToolExecutionResult, type ToolHooks } from "../tools.js";
import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "../types.js";
import type { HybridOrchestrator } from "../orchestrator.js";

const logger = createLogger("AgentHub");

function createAbortError(message = "用户中断了请求"): Error {
  const abortError = new Error(message);
  abortError.name = "AbortError";
  return abortError;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isStatefulAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}

function shouldRunToolLoop(agentId: AgentIdentifier): boolean {
  void agentId;
  return true;
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

export function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

export function resolveDefaultMaxToolRounds(): number {
  const parsed = parseMaxRounds(process.env.ADS_AGENT_MAX_TOOL_ROUNDS) ?? parseMaxRounds(process.env.AGENT_MAX_TOOL_ROUNDS);
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

export async function runAgentTurnWithTools(
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

