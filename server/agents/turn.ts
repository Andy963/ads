import type { Input } from "./protocol/types.js";

import type { AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { ActivityTracker, resolveExploredConfig, type ExploredEntry, type ExploredEntryCallback } from "../utils/activityTracker.js";
import { executeToolDirectives, stripToolDirectives } from "../skills/builtinTools.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";

export interface AgentTurnOptions extends AgentSendOptions {
  cwd?: string;
  workspaceRoot?: string;
  historySessionId?: string;
  onExploredEntry?: ExploredEntryCallback;
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
  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: activeAgentId === "codex" ? options.outputSchema : undefined,
    signal: options.signal,
    env: options.env,
  };

  try {
    const result: AgentRunResult = await orchestrator.invokeAgent(activeAgentId, input, sendOptions);
    const workspaceRoot = options.workspaceRoot ?? detectWorkspaceFrom(options.cwd ?? process.cwd());
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

    const explored = exploredTracker
      ? exploredTracker.compact({ maxItems: exploredConfig.maxItems, dedupe: exploredConfig.dedupe })
      : undefined;
    return { ...result, response, explored };
  } finally {
    unsubscribeExplored();
  }
}
