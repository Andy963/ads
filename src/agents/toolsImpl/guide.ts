import { ensureApiKeys, resolveSearchConfig } from "../../tools/search/config.js";
import { checkTavilySetup } from "../../tools/search/setupCodexMcp.js";
import { loadVectorSearchConfig } from "../../vectorSearch/config.js";
import { isApplyPatchEnabled, isExecToolEnabled, isFileToolsEnabled } from "../tools/shared.js";

export function injectToolGuide(
  input: string,
  options?: {
    activeAgentId?: string;
    invokeAgentEnabled?: boolean;
  },
): string {
  const activeAgentId = options?.activeAgentId ?? "codex";
  const usesToolBlocks = true;
  const wantsSearchGuide = () => {
    const searchEnabled = !ensureApiKeys(resolveSearchConfig());
    if (!searchEnabled) {
      return false;
    }
    if (activeAgentId !== "codex") {
      return true;
    }
    const mcpStatus = checkTavilySetup();
    return !mcpStatus.configured;
  };

  const wantsVectorSearchGuide = () => {
    const { config } = loadVectorSearchConfig();
    return !!config?.enabled;
  };

  const guideLines: string[] = [];

  if (usesToolBlocks && wantsSearchGuide()) {
    guideLines.push(
      [
        "【可用工具】",
        "search - 调用 Tavily 搜索，格式：",
        "<<<tool.search",
        '{"query":"关键词","maxResults":5,"lang":"en"}',
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && wantsVectorSearchGuide()) {
    guideLines.push(
      [
        "【可用工具】",
        "vsearch - 调用本地向量搜索（语义搜索），可检索 Spec 文档、ADR 和历史对话，格式：",
        "建议：当你需要回忆/引用已有 Spec、ADR 或历史对话里的信息时，先用 vsearch 检索再回答。",
        "<<<tool.vsearch",
        "如何实现用户认证？",
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && options?.invokeAgentEnabled) {
    guideLines.push(
      [
        "agent - 调用协作代理协助处理子任务，格式：",
        "<<<tool.agent",
        '{"agentId":"codex","prompt":"请帮我处理这个子任务..."}',
        ">>>",
      ].join("\n"),
    );
  }

  if (usesToolBlocks && activeAgentId !== "codex" && isFileToolsEnabled()) {
    guideLines.push(
      [
        "write - 写入本地文件（默认启用；可用 ENABLE_AGENT_FILE_TOOLS=0 禁用；受目录白名单限制），格式：",
        "<<<tool.write",
        '{"path":"src/example.txt","content":"hello"}',
        ">>>",
      ].join("\n"),
    );
    if (isApplyPatchEnabled()) {
      guideLines.push(
        [
          "apply_patch - 通过 unified diff 应用补丁（默认启用；可用 ENABLE_AGENT_APPLY_PATCH=0 禁用；需要 git；受目录白名单限制），格式：",
          "<<<tool.apply_patch",
          "diff --git a/src/a.ts b/src/a.ts",
          "index 0000000..1111111 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +1,1 @@",
          "-old",
          "+new",
          ">>>",
        ].join("\n"),
      );
    }
  }

  if (usesToolBlocks && activeAgentId !== "codex" && isExecToolEnabled()) {
    guideLines.push(
      [
        "exec - 在本机执行命令（默认启用；可用 ENABLE_AGENT_EXEC_TOOL=0 禁用；可选用 AGENT_EXEC_TOOL_ALLOWLIST 限制命令，'*' 表示不限制），格式：",
        "<<<tool.exec",
        "npm test",
        ">>>",
        "（可选 JSON）",
        "<<<tool.exec",
        '{"cmd":"npm","args":["run","build"],"timeoutMs":600000}',
        ">>>",
      ].join("\n"),
    );
  }

  const guide = guideLines.filter(Boolean).join("\n\n").trim();
  if (!guide) {
    return input;
  }
  return `${input}\n\n${guide}`;
}
