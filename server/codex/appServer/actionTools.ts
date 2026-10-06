import { isDeepStrictEqual } from "node:util";
import { executeActionTool, isActionTool, type ActionTools } from "../../agents/actionTools.js";
import type { DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.js";

export function createActionToolBridge(options: {
  tools?: ActionTools;
  signal?: AbortSignal;
  scope: () => { threadId: string | null; turnId: string | null; active: boolean };
  markSideEffect: (callId: string) => void;
}) {
  const calls = new Map<string, { name: string; args: unknown; result: Promise<DynamicToolCallResponse> }>();
  const failure = (error: string): DynamicToolCallResponse => ({ success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error }) }] });
  const matches = (params: unknown): boolean => {
    const request = params as Partial<DynamicToolCallParams> | null;
    const scope = options.scope();
    return Boolean(request && isActionTool(String(request.tool)) && scope.active && scope.threadId && scope.turnId
      && request.threadId === scope.threadId && request.turnId === scope.turnId && !options.signal?.aborted);
  };
  return {
    matches,
    handle(params: unknown): Promise<DynamicToolCallResponse> {
      const request = params as DynamicToolCallParams;
      if (!matches(params) || !request.callId || request.namespace != null || !isActionTool(request.tool)) {
        return Promise.resolve(failure("Invalid or inactive Actions tool call."));
      }
      const previous = calls.get(request.callId);
      if (previous) return previous.name === request.tool && isDeepStrictEqual(previous.args, request.arguments)
        ? previous.result : Promise.resolve(failure("Actions callId was reused with different arguments."));
      const name = request.tool;
      const result = Promise.resolve().then(async () => {
        if (!matches(params)) return failure("Actions tool turn is no longer active.");
        options.markSideEffect(request.callId);
        try {
          const value = await executeActionTool(name, request.arguments, options.tools);
          return { success: value.ok, contentItems: [{ type: "inputText" as const, text: JSON.stringify(value) }] };
        } catch (error) {
          return failure(error instanceof Error ? error.message : "Actions tool failed.");
        }
      });
      calls.set(request.callId, { name, args: structuredClone(request.arguments), result });
      return result;
    },
  };
}
