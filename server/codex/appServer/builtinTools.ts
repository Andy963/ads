import { isDeepStrictEqual } from "node:util";
import { ACTION_TOOL_DEFINITIONS, isActionTool } from "../../agents/actionTools.js";

import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool, type BuiltinToolContext } from "../../tools/builtins.js";
import type { DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "./protocol/v2/DynamicToolSpec.js";
import type { JsonValue } from "./protocol/serde_json/JsonValue.js";

export function builtinDynamicTools(includeActions = false): DynamicToolSpec[] {
  return [...BUILTIN_TOOL_DEFINITIONS, ...(includeActions ? ACTION_TOOL_DEFINITIONS : [])].map(({ function: tool }) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JsonValue,
    deferLoading: false,
  }));
}

type TurnScope = { threadId: string | null; turnId: string | null; active: boolean };

function failure(message: string): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: message }) }] };
}

/** Owns only the current turn's calls; never routes by tool name alone. */
export function createBuiltinToolBridge(options: {
  context: BuiltinToolContext;
  scope: () => TurnScope;
  markSideEffect: (callId: string) => void;
}): {
  matches: (params: unknown) => boolean;
  handle: (params: unknown) => DynamicToolCallResponse;
} {
  const completed = new Map<string, { tool: string; arguments: unknown; response: DynamicToolCallResponse }>();
  const matches = (params: unknown): boolean => {
    if (!params || typeof params !== "object" || options.context.signal?.aborted) return false;
    const request = params as Partial<DynamicToolCallParams>;
    const scope = options.scope();
    return Boolean(!isActionTool(String(request.tool)) && scope.active && scope.threadId && scope.turnId
      && request.threadId === scope.threadId && request.turnId === scope.turnId);
  };
  return {
    matches,
    handle(params) {
      if (!matches(params)) return failure("Built-in tool request does not belong to an active turn.");
      const request = params as DynamicToolCallParams;
      if (typeof request.callId !== "string" || !request.callId.trim()) return failure("Built-in tool call requires a callId.");
      if (request.namespace != null) return failure("Unsupported ADS built-in tool namespace.");
      if (!BUILTIN_TOOL_DEFINITIONS.some(tool => tool.function.name === request.tool)) return failure("Unknown ADS built-in tool.");
      const previous = completed.get(request.callId);
      if (previous) {
        return previous.tool === request.tool && isDeepStrictEqual(previous.arguments, request.arguments)
          ? previous.response : failure("Built-in tool callId was reused with different arguments.");
      }
      let response: DynamicToolCallResponse;
      try {
        // Even an ambiguous host failure must never cause a turn retry to replay dispatch.
        options.markSideEffect(request.callId);
        const result = executeBuiltinTool(request.tool, request.arguments, options.context);
        response = { success: result.ok, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
      } catch (error) {
        response = failure(error instanceof Error ? error.message : "ADS built-in tool failed.");
      }
      completed.set(request.callId, { tool: request.tool, arguments: structuredClone(request.arguments), response });
      return response;
    },
  };
}
