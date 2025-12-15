import { SystemPromptManager, resolveReinjectionConfig } from "../systemPrompt/manager.js";
import { CodexAgentAdapter } from "../agents/adapters/codexAdapter.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { ReviewReport, ReviewIssue } from "./types.js";
import { resolveClaudeAgentConfig } from "../agents/config.js";
import { ClaudeAgentAdapter } from "../agents/adapters/claudeAdapter.js";
import { z } from "zod";

import { safeParseJsonWithSchema } from "../utils/json.js";

const reviewIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]).catch("error"),
    file: z.string().optional(),
    line: z.union([z.number().int(), z.null()]).optional(),
    message: z.string().catch(""),
    suggestion: z.string().optional(),
  })
  .passthrough();

const reviewReportSchema = z
  .object({
    verdict: z.enum(["approved", "blocked", "failed"]).catch("blocked"),
    summary: z.string().catch(""),
    issues: z.array(reviewIssueSchema).catch([]),
    notes: z.string().optional(),
  })
  .passthrough();

const REVIEW_PROMPT = (
  bundleDir: string,
  options?: {
    includeSpecFiles?: boolean;
    specSummary?: string;
    workflowTitle?: string;
  },
) => {
  const includeSpec = options?.includeSpecFiles ?? true;
  const specInstruction = includeSpec
    ? "- Does the code change align with the spec (requirements, design, implementation)?"
    : "- Spec files are unavailable on purpose. Evaluate whether the code change is correct, safe, and self-consistent based on the diff.";
  return `
You are an independent reviewer agent. Your task is to evaluate the latest code changes against the spec using the artifacts stored under:
\`${bundleDir}\`

Available files inside the bundle include:
- diff.patch / stats.txt — Git diff and statistics
- ${includeSpec ? "requirements.md, design.md, implementation.md — spec documents" : "Spec documents (omitted in this run)"}
- deps.txt — dependency changes

Instructions:
1. Use shell commands (e.g. \`ls\`, \`cat\`, \`grep\`) to inspect files inside the bundle directory. DO NOT modify any code or files.
2. Focus on:
   ${specInstruction}
   - Are there any obvious bugs or issues in the diff?
   - Are dependency changes reasonable?
3. When ready, produce a JSON object **without code fences** using the schema:
{
  "verdict": "approved" | "blocked",
  "summary": "<short summary>",
  "issues": [
    {
      "severity": "error" | "warning",
      "file": "<relative path or context>",
      "line": <line number or null>,
      "message": "<problem description>",
      "suggestion": "<proposed fix>"
    }
  ],
  "notes": "<optional free-form notes>"
}
4. Only set "verdict":"approved" when the changes align with the spec and there are no serious concerns. Any serious issue must result in "blocked".
5. Respond ONLY with the JSON object.`;
};

export interface ReviewerAgentResult {
  report: ReviewReport;
  agentId: string;
  warnings?: string[];
}

export async function runReviewerAgent(options: {
  workspace: string;
  workflow: WorkflowInfo;
  reviewDir: string;
  bundleDir: string;
  preferredAgent?: "codex" | "claude";
  includeSpecFiles?: boolean;
}): Promise<ReviewerAgentResult> {
  const { workspace, workflow, reviewDir, bundleDir, preferredAgent, includeSpecFiles } = options;
  const systemPromptManager = new SystemPromptManager({
    workspaceRoot: workspace,
    reinjection: resolveReinjectionConfig("REVIEW"),
  });

  const adapters = [];
  const warnings: string[] = [];

  const codexAdapter = new CodexAgentAdapter({
    workingDirectory: workspace,
    systemPromptManager,
    metadata: {
      id: "codex",
      name: "Codex Reviewer",
      vendor: "OpenAI",
    },
  });
  adapters.push(codexAdapter);
  let defaultAgentId = codexAdapter.id;

  if (preferredAgent === "claude") {
    const claudeConfig = resolveClaudeAgentConfig();
    if (claudeConfig.enabled) {
      const claudeAdapter = new ClaudeAgentAdapter({ config: claudeConfig });
      adapters.push(claudeAdapter);
      defaultAgentId = claudeAdapter.id;
    } else {
      warnings.push("未启用 Claude，已回退到 Codex Reviewer。");
    }
  }

  const orchestrator = new HybridOrchestrator({
    adapters,
    defaultAgentId,
    initialWorkingDirectory: workspace,
    systemPromptManager,
  });

  const prompt = [
    `Workflow: ${workflow.title ?? workflow.workflow_id}`,
    `Bundle directory: ${bundleDir}`,
    `Report directory: ${reviewDir}`,
    REVIEW_PROMPT(bundleDir, { includeSpecFiles }),
  ].join("\n\n");

  try {
    const result = await orchestrator.send(prompt, { streaming: false });
    const parsed = safeParseJsonWithSchema(result.response.trim(), reviewReportSchema);
    if (!parsed) {
      throw new Error("Reviewer 未返回有效 JSON。");
    }

    const report: ReviewReport = {
      verdict: parsed.verdict,
      summary: parsed.summary,
      issues: parsed.issues.map((issue): ReviewIssue => ({
        severity: issue.severity,
        file: issue.file,
        line: typeof issue.line === "number" ? issue.line : undefined,
        message: issue.message,
        suggestion: issue.suggestion,
      })),
      notes: parsed.notes,
    };

    return { report, agentId: defaultAgentId, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      report: {
        verdict: "failed",
        summary: `Reviewer 执行失败：${message}`,
        issues: [],
        notes: "请修复问题后重新运行 /ads.review。",
      },
      agentId: defaultAgentId,
      warnings,
    };
  }
}
