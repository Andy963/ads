import type { NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";
import type {
  ActionToolName,
  ActionToolResult,
  ActionTools,
} from "../agents/actionTools.js";

export const BUILTIN_TOOL_DEFINITIONS: NativeToolDefinition[] = [];

export const ACTION_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "begin_implementation",
      description: "Confirm the requested Issue owns the current workspace task slot before changing files or branches. Refuses a different open PR or a branch assigned to another Issue.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          issue_id: { type: "integer", minimum: 1, description: "GitHub Issue number being implemented." },
        },
        required: ["issue_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_action",
      description: "Pin the current Issue-backed pull request and enqueue a read-only Reviewer job in the Actions lane. Wait for its structured result, which also appears in the Actions queue and conversation; review execution never runs in the Acopilot lane.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export function isActionTool(name: string): name is ActionToolName {
  return name === "begin_implementation" || name === "review_action";
}

export function isBuiltinTool(name: string): boolean {
  return isActionTool(name);
}

export function builtinToolDefinitions(includeActions = false): NativeToolDefinition[] {
  return includeActions ? ACTION_TOOL_DEFINITIONS : BUILTIN_TOOL_DEFINITIONS;
}

export interface BuiltinToolContext {
  workspaceRoot: string;
  authUserId?: string;
  actionTools?: ActionTools;
  signal?: AbortSignal;
}

export type BuiltinToolResult = ActionToolResult;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Return a short tool result that the provider can present as normal prose. */
export function formatBuiltinToolResult(tool: string, result: BuiltinToolResult): string {
  const lines = [`${tool} ${result.ok ? "completed" : "failed"}.`];
  const jobId = stringValue(result.jobId);
  const status = stringValue(result.status);
  if (jobId) lines.push(`Actions job: ${jobId}.`);

  if (tool === "review_action") {
    const verdict = recordValue(result.verdict);
    const verdictStatus = stringValue(verdict?.status);
    const summary = stringValue(verdict?.summary);
    if (verdictStatus) lines.push(`Status: ${verdictStatus}.`);
    else if (status) lines.push(`Status: ${status}.`);
    if (summary) lines.push(`Summary: ${summary}`);
    const defects = Array.isArray(verdict?.defects) ? verdict.defects : [];
    const findings = defects.flatMap((defect) => {
      const finding = recordValue(defect);
      const file = stringValue(finding?.file);
      const severity = stringValue(finding?.severity);
      const description = stringValue(finding?.description);
      if (!description) return [];
      const line = numberValue(finding?.line);
      const location = file ? `${file}${line !== undefined ? `:${line}` : ""}` : "review finding";
      return [`- ${location}${severity ? ` (${severity})` : ""}: ${description}`];
    });
    if (findings.length) lines.push("Findings:", ...findings);
  } else {
    if (status) lines.push(`Status: ${status}.`);
    const issueId = numberValue(result.issueId ?? result.issue_id);
    const branch = stringValue(result.branch);
    const pullRequestNumber = numberValue(result.pullRequestNumber ?? result.pr_number);
    if (issueId !== undefined) lines.push(`Issue: #${issueId}.`);
    if (branch) lines.push(`Branch: ${branch}.`);
    if (pullRequestNumber !== undefined) lines.push(`Pull request: #${pullRequestNumber}.`);
  }

  const error = stringValue(result.error);
  if (error) lines.push(`Reason: ${error}`);
  return lines.join("\n");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function executeBuiltinTool(name: string, args: unknown, context: BuiltinToolContext): Promise<BuiltinToolResult> {
  throwIfAborted(context.signal);
  if (isActionTool(name)) {
    if (!context.actionTools) {
      if (name === "begin_implementation") {
        throw new Error(
          "begin_implementation is not exposed in this execution environment. Perform the equivalent read-only task-slot preflight; tool absence is not a blocker.",
        );
      }
      throw new Error("Acopilot workflow tools are unavailable in this lane.");
    }
    if (name === "begin_implementation") {
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("begin_implementation requires an issue_id argument.");
      }
      const input = args as Record<string, unknown>;
      if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.issue_id) || Number(input.issue_id) < 1) {
        throw new Error("begin_implementation requires a positive integer issue_id argument.");
      }
      if (!context.actionTools.begin_implementation) {
        throw new Error(
          "begin_implementation is not exposed in this execution environment. Perform the equivalent read-only task-slot preflight; tool absence is not a blocker.",
        );
      }
      throwIfAborted(context.signal);
      return await context.actionTools.begin_implementation({ issue_id: Number(input.issue_id) });
    }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw new Error("Reviewer tools accept an empty argument object only.");
    }
    throwIfAborted(context.signal);
    return await context.actionTools[name]();
  }
  throw new Error("Unknown built-in tool");
}
