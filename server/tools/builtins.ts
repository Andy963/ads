import type { NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";
import type {
  ActionToolName,
  ActionToolResult,
  ActionTools,
} from "../agents/actionTools.js";

export const BUILTIN_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "review_action",
      description: "Pin the current Issue-backed pull request and enqueue a read-only Reviewer job in the Actions lane. Wait for its structured result, which also appears in the Actions queue and conversation; review execution never runs in the Acopilot lane.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export function isBuiltinTool(name: string): name is ActionToolName {
  return name === "review_action";
}

export function builtinToolDefinitions(): NativeToolDefinition[] {
  return BUILTIN_TOOL_DEFINITIONS;
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
  if (isBuiltinTool(name)) {
    if (!context.actionTools) {
      throw new Error("review_action is unavailable without an authenticated Acopilot project context.");
    }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
      throw new Error("Reviewer tools accept an empty argument object only.");
    }
    throwIfAborted(context.signal);
    return await context.actionTools[name]();
  }
  throw new Error("Unknown built-in tool");
}
