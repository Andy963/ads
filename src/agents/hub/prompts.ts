import type { Input } from "@openai/codex-sdk";

import { injectDelegationGuide } from "../delegation.js";
import type { AgentIdentifier } from "../types.js";
import type { HybridOrchestrator } from "../orchestrator.js";

import type { DelegationSummary } from "./types.js";

export function injectSupervisorPrompt(input: Input, guide: string): Input {
  const normalizedGuide = String(guide ?? "").trim();
  if (!normalizedGuide) {
    return input;
  }
  if (typeof input === "string") {
    return [input, "", normalizedGuide].join("\n\n").trim();
  }
  if (Array.isArray(input)) {
    return [...input, { type: "text", text: normalizedGuide }];
  }
  return [String(input ?? ""), "", normalizedGuide].join("\n\n").trim();
}

export function applyGuides(input: Input, orchestrator: HybridOrchestrator, agentId: AgentIdentifier, invokeAgentEnabled?: boolean): Input {
  void agentId;
  void invokeAgentEnabled;
  if (typeof input === "string") {
    return injectDelegationGuide(input, orchestrator);
  }

  if (Array.isArray(input)) {
    const guide = injectDelegationGuide("", orchestrator).trim();
    if (!guide) {
      return input;
    }
    return [{ type: "text", text: guide }, ...input];
  }

  return input;
}

export function buildSupervisorPrompt(
  summaries: DelegationSummary[],
  rounds: number,
  supervisorName: string,
  supervisorGuide?: string,
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
      return ["---", `【协作结果 ${idx + 1}】${agentLabel}`, `任务：${summary.prompt.trim()}`, "", summary.response.trim()].join("\n");
    })
    .join("\n\n");

  const guide = String(supervisorGuide ?? "").trim();
  return [header, guide, body].filter(Boolean).join("\n\n").trim();
}

export function buildCoordinatorFinalPrompt(options: { supervisorName: string; rounds: number; supervisorGuide?: string }): string {
  const header = [
    "协作代理任务已执行并完成验收。",
    `你仍然是主管（${options.supervisorName}）：请给用户最终答复。`,
    "要求：",
    "- 不要输出 SupervisorVerdict JSON。",
    "- 不要输出任何 <<<agent.*>>> 指令块。",
    "- 若仍需补充修改，可直接使用工具完成，然后给出如何验证。",
    "",
    `（协作轮次：${options.rounds}）`,
  ].join("\n");

  const guide = String(options.supervisorGuide ?? "").trim();
  return [header, guide].filter(Boolean).join("\n\n").trim();
}
