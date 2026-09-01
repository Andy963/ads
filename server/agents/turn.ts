import type { Input } from "./protocol/types.js";

import type { AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { ActivityTracker, resolveExploredConfig, type ExploredEntry, type ExploredEntryCallback } from "../utils/activityTracker.js";
import { executeToolDirectives, stripToolDirectives } from "../skills/builtinTools.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import type { MiddlewarePipeline, TurnContext } from "../middleware/index.js";

export interface AgentTurnOptions extends AgentSendOptions {
  cwd?: string;
  workspaceRoot?: string;
  historySessionId?: string;
  onExploredEntry?: ExploredEntryCallback;
  middleware?: MiddlewarePipeline;
  middlewareContext?: Omit<TurnContext, "prompt" | "workspaceRoot"> & { workspaceRoot?: string };
}

export interface AgentTurnResult extends AgentRunResult {
  explored?: ExploredEntry[];
}

export async function runAgentTurn(
  orchestrator: HybridOrchestrator,
  input: Input,
  options: AgentTurnOptions = {},
): Promise<AgentTurnResult> {
  const exploredConfig = resolveExploredConfig();
  const exploredTracker = exploredConfig.enabled ? new ActivityTracker(options.onExploredEntry) : null;

  const unsubscribeExplored = exploredTracker
    ? orchestrator.onEvent((event) => {
      try {
        exploredTracker.ingestThreadEvent(event.raw);
      } catch {
        // ignore
      }
    })
    : () => undefined;

  const activeAgentId = orchestrator.getActiveAgentId();
  const workspaceRoot = options.workspaceRoot ?? detectWorkspaceFrom(options.cwd ?? process.cwd());
  const middlewareContext: TurnContext | undefined = options.middleware
    ? {
        turnId: options.middlewareContext?.turnId ?? options.historySessionId ?? "agent-turn",
        sessionId: options.middlewareContext?.sessionId ?? options.historySessionId ?? "agent-session",
        workspaceRoot: options.middlewareContext?.workspaceRoot ?? workspaceRoot,
        channel: options.middlewareContext?.channel ?? "web",
        prompt: typeof input === "string" ? input : "",
        metadata: options.middlewareContext?.metadata,
      }
    : undefined;
  let effectiveInput = input;
  if (options.middleware && middlewareContext) {
    const middlewarePrompt = await options.middleware.executeBeforeInput(middlewareContext);
    if (typeof input === "string") effectiveInput = middlewarePrompt;
    middlewareContext.prompt = typeof effectiveInput === "string" ? effectiveInput : middlewareContext.prompt;
    await options.middleware.executeTurnStart(middlewareContext);
  }
  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: activeAgentId === "codex" ? options.outputSchema : undefined,
    signal: options.signal,
    env: options.env,
  };

  try {
    const result: AgentRunResult = await orchestrator.invokeAgent(activeAgentId, effectiveInput, sendOptions);
    const toolResults = await executeToolDirectives({
      text: result.response,
      workspaceRoot,
      sessionId: options.historySessionId,
    });
    const cleanedResponse = stripToolDirectives(result.response);
    let response = cleanedResponse;
    if (toolResults.length > 0) {
      response = [cleanedResponse, "", ...toolResults].join("\n").trim();
    }
    if (options.middleware && middlewareContext) {
      await options.middleware.executeAfterOutput(middlewareContext, response);
    }

    const explored = exploredTracker
      ? exploredTracker.compact({ maxItems: exploredConfig.maxItems, dedupe: exploredConfig.dedupe })
      : undefined;
    return { ...result, response, explored };
  } catch (error) {
    if (options.middleware && middlewareContext) {
      await options.middleware.executeTurnError(
        middlewareContext,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    throw error;
  } finally {
    unsubscribeExplored();
  }
}
