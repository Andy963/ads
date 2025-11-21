import type { Usage } from "@openai/codex-sdk";
import type { AgentRunResult } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";

export type AgentMode = "manual" | "auto";

const CLAUDE_AGENT_ID = "claude";
const CODEX_AGENT_ID = "codex";
const CLAUDE_DELEGATION_REGEX = /<<<agent\.claude[\t ]*\n([\s\S]*?)>>>/gi;
const FRONTEND_KEYWORDS = [
  "前端",
  "界面",
  "ui ",
  " ui",
  "页面",
  "页面布局",
  "样式",
  "美化",
  "交互设计",
  "html",
  "css",
  "jsx",
  "tsx",
  "react",
  "vue",
  "component",
  "components",
  "tailwind",
  "chakra",
  "ant design",
  "material ui",
  "semantic ui",
  "bootstrap",
  "grid",
  "flexbox",
  "图标",
  "按钮",
  "表格",
  "表单",
  "landing page",
  "hero section",
  "mockup",
  "figma",
  "设计稿",
  "配色",
  "布局图",
  "wireframe",
];

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

export function detectFrontendIntent(text: string): string | null {
  const normalized = text.toLowerCase();
  for (const keyword of FRONTEND_KEYWORDS) {
    if (normalized.includes(keyword.toLowerCase())) {
      return `检测到前端/UI 关键词「${keyword.trim()}」`;
    }
  }
  const htmlLike = /<\s*(div|section|main|header|footer|button|table|form|input|svg|article)\b/i;
  if (htmlLike.test(text)) {
    return "检测到 HTML/组件结构";
  }
  return null;
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
  let finalResponse = result.response;
  const summaries: DelegationSummary[] = [];

  const runDelegation = async (prompt: string, reason?: string) => {
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
    return formatClaudeReplacement(summary, reason);
  };

  for (const directive of directives) {
    const replacement = await runDelegation(directive.prompt);
    if (replacement) {
      finalResponse = finalResponse.replace(directive.raw, replacement);
    }
  }

  if (
    summaries.length === 0 &&
    mode === "auto" &&
    supportsAutoDelegation(orchestrator)
  ) {
    const reason = detectFrontendIntent(result.response);
    if (reason) {
      const autoPrompt = [
        "Codex 需要你作为前端/UI 专家完成以下内容：",
        result.response.trim(),
        "",
        "请根据以上上下文输出最终的前端/UI 结果（可包含代码、说明或需要的素材）。",
      ].join("\n");
      const replacement = await runDelegation(autoPrompt, reason);
      if (replacement) {
        finalResponse = replacement;
      }
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

function formatClaudeReplacement(summary: DelegationSummary, reason?: string): string {
  const promptPreview =
    summary.prompt.length > 160
      ? `${summary.prompt.slice(0, 157)}…`
      : summary.prompt;

  const headerReason = reason ? `（触发：${reason}）` : "";

  return [
    `🤝 **Claude（协作代理）已完成以下子任务** ${headerReason}`.trim(),
    `> ${promptPreview}`,
    "",
    summary.response.trim(),
    "",
    "---",
  ].join("\n");
}
