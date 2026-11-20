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
      description: "Enqueue a read-only Reviewer job for the current Issue-backed pull request and return immediately. The verdict is published as a comment on the backing Issue (marker: ads:review-verdict) and the Acopilot lane is woken to read it.",
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

/** Return a short tool result that the provider can present as normal prose. */
export function formatBuiltinToolResult(tool: string, result: BuiltinToolResult): string {
  const lines = [`${tool} ${result.ok ? "completed" : "failed"}.`];
  const jobId = stringValue(result.jobId);
  const status = stringValue(result.status);
  if (jobId) lines.push(`Actions job: ${jobId}.`);

  if (tool === "review_action") {
    // The tool is an enqueue acknowledgement now; the verdict arrives later.
    if (status) lines.push(`Status: ${status}.`);
    const issueId = numberValue(result.issueId);
    if (issueId !== undefined) lines.push(`Issue: #${issueId}.`);
    const note = stringValue(result.note);
    if (note) lines.push(note);
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
