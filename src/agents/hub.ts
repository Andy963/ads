import type { Input } from "./protocol/types.js";

import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { createLogger } from "../utils/logger.js";
import { ActivityTracker, resolveExploredConfig } from "../utils/activityTracker.js";
import { detectWorkspaceFrom } from "../workspace/detector.js";
import { SupervisorPromptLoader } from "./tasks/supervisorPrompt.js";
import { isCoordinatorEnabled, TaskCoordinator } from "./tasks/taskCoordinator.js";

export type { CollaborationHooks, CollaborativeTurnOptions, CollaborativeTurnResult, DelegationSummary } from "./hub/types.js";
import type { CollaborativeTurnOptions, CollaborativeTurnResult, DelegationSummary } from "./hub/types.js";

import { applyGuides, buildCoordinatorFinalPrompt, buildSupervisorPrompt, injectSupervisorPrompt } from "./hub/prompts.js";
import {
  extractDelegationDirectives,
  looksLikeSupervisorVerdict,
  resolveAgentName,
  runDelegationQueue,
  stripDelegationBlocks,
} from "./hub/delegations.js";

const logger = createLogger("AgentHub");
const supervisorPromptLoader = new SupervisorPromptLoader({ logger });

function createAbortError(message = "用户中断了请求"): Error {
  const abortError = new Error(message);
  abortError.name = "AbortError";
  return abortError;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

export async function runCollaborativeTurn(
  orchestrator: HybridOrchestrator,
  input: Input,
  options: CollaborativeTurnOptions = {},
): Promise<CollaborativeTurnResult> {
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

  const maxSupervisorRounds = options.maxSupervisorRounds ?? 2;
  const maxDelegations = options.maxDelegations ?? 6;
  const activeAgentId = orchestrator.getActiveAgentId();
  const supervisorName = resolveAgentName(orchestrator, activeAgentId);

  const supportsStructuredOutput = activeAgentId === "codex";
  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: supportsStructuredOutput ? options.outputSchema : undefined,
    signal: options.signal,
    env: options.env,
  };
  const cwd = options.cwd ?? process.cwd();
  const historyNamespace = options.historyNamespace;
  const historySessionId = options.historySessionId;
  const workspaceRoot = detectWorkspaceFrom(cwd);
  const supervisorGuide =
    activeAgentId === "codex" && orchestrator.listAgents().length > 1
      ? supervisorPromptLoader.load(workspaceRoot).text
      : "";

  const prompt = applyGuides(
    injectSupervisorPrompt(input, supervisorGuide),
    orchestrator,
    activeAgentId,
    false,
  );
  try {
    let result: AgentRunResult = await orchestrator.invokeAgent(activeAgentId, prompt, sendOptions);

    let rounds = 0;
    const allDelegations: DelegationSummary[] = [];

    const coordinatorEnabled =
      activeAgentId === "codex" &&
      orchestrator.listAgents().length > 1 &&
      isCoordinatorEnabled();

    if (coordinatorEnabled) {
      const maxParallelDelegations = parsePositiveInt(process.env.ADS_TASK_MAX_PARALLEL, 3);
      const taskTimeoutMs = parsePositiveInt(process.env.ADS_TASK_TIMEOUT_MS, 2 * 60 * 1000);
      const maxTaskAttempts = parsePositiveInt(process.env.ADS_TASK_MAX_ATTEMPTS, 2);
      const retryBackoffMs = parsePositiveInt(process.env.ADS_TASK_RETRY_BACKOFF_MS, 1200);

      const coordinator = new TaskCoordinator(orchestrator, {
        workspaceRoot,
        namespace: historyNamespace ?? "agent",
        sessionId: historySessionId ?? "default",
        invokeAgent: async (agentId, inputText, invokeOptions) =>
          await orchestrator.invokeAgent(agentId, inputText, { streaming: false, signal: invokeOptions?.signal, env: options.env }),
        supervisorAgentId: activeAgentId,
        supervisorName,
        maxSupervisorRounds,
        maxDelegations,
        maxParallelDelegations,
        taskTimeoutMs,
        maxTaskAttempts,
        retryBackoffMs,
        verificationCwd: cwd,
        signal: options.signal,
        hooks: options.hooks,
        logger,
      });

      const coordination = await coordinator.run({
        initialSupervisorResult: result,
        // Verdict round should not enforce structured output schema and should not execute tool blocks.
        runSupervisor: async (inputText: string) =>
          await orchestrator.invokeAgent(activeAgentId, inputText, {
            streaming: false,
            signal: options.signal,
            env: options.env,
          }),
      });

      result = coordination.finalResult;
      rounds = coordination.rounds;
      allDelegations.push(...coordination.delegations);

      // After coordination completes, ask supervisor for a user-facing final response (not the verdict JSON).
      if (rounds > 0 || allDelegations.length > 0 || looksLikeSupervisorVerdict(result.response)) {
        const finalPrompt = buildCoordinatorFinalPrompt({
          supervisorName,
          rounds,
          supervisorGuide,
        });
        result = await orchestrator.invokeAgent(activeAgentId, finalPrompt, sendOptions);

        if (looksLikeSupervisorVerdict(result.response)) {
          const retryPrompt = [
            finalPrompt,
            "",
            "⚠️ 注意：不要输出任何 JSON（包括 SupervisorVerdict）。请只用自然语言给用户最终答复。",
          ].join("\n");
          result = await orchestrator.invokeAgent(activeAgentId, retryPrompt, sendOptions);
        }
      }
    } else {
      while (rounds < maxSupervisorRounds) {
        throwIfAborted(options.signal);
        const directives = extractDelegationDirectives(result.response, activeAgentId);
        if (directives.length === 0) {
          break;
        }

        rounds += 1;
        await options.hooks?.onSupervisorRound?.(rounds, directives.length);
        const delegations = await runDelegationQueue(orchestrator, result.response, {
          maxDelegations,
          hooks: options.hooks,
          supervisorAgentId: activeAgentId,
          signal: options.signal,
          env: options.env,
        });
        allDelegations.push(...delegations);

        const supervisorPrompt = buildSupervisorPrompt(delegations, rounds, supervisorName, supervisorGuide);
        if (!supervisorPrompt.trim()) {
          break;
        }

        result = await orchestrator.invokeAgent(activeAgentId, supervisorPrompt, sendOptions);
      }
    }

    const explored = exploredTracker
      ? exploredTracker.compact({ maxItems: exploredConfig.maxItems, dedupe: exploredConfig.dedupe })
      : undefined;
    const finalResponse = stripDelegationBlocks(result.response);
    return { ...result, response: finalResponse, delegations: allDelegations, supervisorRounds: rounds, explored };
  } finally {
    unsubscribeExplored();
  }
}

export function isExecutorAgent(agentId: AgentIdentifier): boolean {
  return agentId === "codex";
}
