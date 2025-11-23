import { SystemPromptManager, resolveReinjectionConfig } from "../systemPrompt/manager.js";
import { CodexAgentAdapter } from "../agents/adapters/codexAdapter.js";
import { HybridOrchestrator } from "../agents/orchestrator.js";
import type { WorkflowInfo } from "../workspace/context.js";
import type { ReviewReport, ReviewIssue } from "./types.js";
import { resolveClaudeAgentConfig } from "../agents/config.js";
import { ClaudeAgentAdapter } from "../agents/adapters/claudeAdapter.js";

const REVIEW_PROMPT = (bundleDir: string) => `
You are an independent reviewer agent. Your task is to evaluate the latest code changes using the artifacts stored under:
\`${bundleDir}\`

Available files inside the bundle include:
- diff.patch / stats.txt — Git diff and statistics
- requirements.md, design.md, implementation.md — latest spec documents
- tests.log — most recent test output
- deps.txt — dependency changes

Instructions:
1. Use shell commands (e.g. \`ls\`, \`cat\`, \`grep\`, \`npm test -- --runInBand\`) to inspect files inside the bundle directory. DO NOT modify any code or files.
2. Focus on correctness, requirement alignment, documentation sync, dependency risks, and test results.
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
4. Only set "verdict":"approved" when there are no errors and tests look healthy. Any serious concern must result in "blocked".
5. Respond ONLY with the JSON object.`;

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
}): Promise<ReviewerAgentResult> {
  const { workspace, workflow, reviewDir, bundleDir, preferredAgent } = options;
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
      id: "reviewer",
      name: "Reviewer",
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
  });

  const prompt = [
    `Workflow: ${workflow.title ?? workflow.workflow_id}`,
    `Bundle directory: ${bundleDir}`,
    `Report directory: ${reviewDir}`,
    REVIEW_PROMPT(bundleDir),
  ].join("\n\n");

  try {
    const result = await orchestrator.send(prompt, { streaming: false });
    const parsed = safeParseJson(result.response.trim());
    if (!parsed) {
      throw new Error("Reviewer 未返回有效 JSON。");
    }
    validateReport(parsed);
    return { report: parsed, agentId: defaultAgentId, warnings };
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

function safeParseJson(text: string): ReviewReport | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateReport(report: ReviewReport): void {
  if (report.verdict !== "approved" && report.verdict !== "blocked" && report.verdict !== "failed") {
    throw new Error("verdict 字段无效。");
  }
  if (!Array.isArray(report.issues)) {
    report.issues = [];
  } else {
    report.issues = report.issues.map(normalizeIssue);
  }
  report.summary = report.summary ?? "";
}

function normalizeIssue(issue: ReviewIssue): ReviewIssue {
  const severity = issue.severity === "warning" ? "warning" : "error";
  return {
    severity,
    file: issue.file,
    line: typeof issue.line === "number" ? issue.line : undefined,
    message: issue.message ?? "",
    suggestion: issue.suggestion,
  };
}
