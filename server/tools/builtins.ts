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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function executeBuiltinTool(name: string, args: unknown, context: BuiltinToolContext): Promise<BuiltinToolResult> {
  throwIfAborted(context.signal);
  if (isActionTool(name)) {
    if (!context.actionTools) {
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
        throw new Error("Implementation task-slot validation is unavailable in this lane.");
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
