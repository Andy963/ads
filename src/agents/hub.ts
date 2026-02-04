import type { Input } from "@openai/codex-sdk";

import {
  injectToolGuide,
  type ToolCallSummary,
  type ToolExecutionContext,
} from "./tools.js";
import type { AgentIdentifier, AgentRunResult, AgentSendOptions } from "./types.js";
import type { HybridOrchestrator } from "./orchestrator.js";
import { createLogger } from "../utils/logger.js";
import { ActivityTracker, resolveExploredConfig } from "../utils/activityTracker.js";
import { maybeBuildVectorAutoContext, type VectorAutoContextReport } from "../vectorSearch/context.js";
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
import { extractVectorQuery, formatVectorAutoContextSummary, injectVectorContext } from "./hub/vectorContext.js";
import { parsePositiveInt, resolveDefaultMaxToolRounds, runAgentTurnWithTools, throwIfAborted } from "./hub/toolLoop.js";

const logger = createLogger("AgentHub");
const supervisorPromptLoader = new SupervisorPromptLoader({ logger });

export async function runCollaborativeTurn(
  orchestrator: HybridOrchestrator,
  input: Input,
  options: CollaborativeTurnOptions = {},
): Promise<CollaborativeTurnResult> {
  const exploredConfig = resolveExploredConfig();
  const exploredTracker = exploredConfig.enabled ? new ActivityTracker(options.onExploredEntry) : null;
  const toolHooks = (() => {
    if (!exploredTracker) {
      return options.toolHooks;
    }
    return {
      onInvoke: async (tool: string, payload: string) => {
        try {
          exploredTracker.ingestToolInvoke(tool, payload);
        } catch {
          // ignore
        }
        await options.toolHooks?.onInvoke?.(tool, payload);
      },
      onResult: async (summary: ToolCallSummary) => {
        await options.toolHooks?.onResult?.(summary);
      },
    };
  })();

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
  const maxToolRounds = options.maxToolRounds ?? resolveDefaultMaxToolRounds();
  const activeAgentId = orchestrator.getActiveAgentId();
  const supervisorName = resolveAgentName(orchestrator, activeAgentId);

  const supportsStructuredOutput = activeAgentId === "codex";
  const sendOptions: AgentSendOptions = {
    streaming: options.streaming,
    outputSchema: supportsStructuredOutput ? options.outputSchema : undefined,
    signal: options.signal,
  };
  const toolContext: ToolExecutionContext = options.toolContext ?? { cwd: process.cwd() };

  // 提供 invokeAgent 能力，允许 Agent 通过工具调用其他 Agent
  if (!toolContext.invokeAgent) {
    toolContext.invokeAgent = async (agentId: string, prompt: string) => {
      const agentResult = await runAgentTurnWithTools(
        orchestrator,
        agentId as AgentIdentifier,
        injectToolGuide(prompt, { activeAgentId: agentId }),
        { streaming: false, signal: options.signal },
        {
          maxToolRounds: maxToolRounds,
          toolContext,
          toolHooks,
        },
      );
      return agentResult.response;
    };
  }

  const workspaceRoot = detectWorkspaceFrom(toolContext.cwd ?? process.cwd());
  const supervisorGuide =
    activeAgentId === "codex" && orchestrator.listAgents().length > 1
      ? supervisorPromptLoader.load(workspaceRoot).text
      : "";
  let vectorContext: string | null = null;
  try {
    const vectorQuery = extractVectorQuery(input);
    const vectorReports: VectorAutoContextReport[] = [];
    vectorContext = await maybeBuildVectorAutoContext({
      workspaceRoot,
      query: vectorQuery,
      historyNamespace: toolContext.historyNamespace,
      historySessionId: toolContext.historySessionId,
      onReport: (report) => {
        vectorReports.push(report);
      },
    });

    const lastReport = vectorReports[vectorReports.length - 1] ?? null;
    // Vector auto-context is an internal optimization; only surface it in the web UI when it actually
    // injected context. Emitting "no hit" / "disabled" / "skipped" lines is noisy for end users.
    if (lastReport && lastReport.injected) {
      const summary = formatVectorAutoContextSummary(lastReport);
      options.onExploredEntry?.({
        category: "Search",
        summary,
        ts: Date.now(),
        source: "tool_hook",
        meta: { tool: "vector_search" },
      });
    } else if (vectorContext && vectorContext.trim()) {
      options.onExploredEntry?.({
        category: "Search",
        summary: `VectorSearch(auto) injected chars=${vectorContext.length}`,
        ts: Date.now(),
        source: "tool_hook",
        meta: { tool: "vector_search" },
      });
    }
  } catch (error) {
    logger.warn("[AgentHub] Failed to build vector auto context", error);
  }

  const prompt = applyGuides(
    injectSupervisorPrompt(
      injectVectorContext(input, vectorContext ?? ""),
      supervisorGuide,
    ),
    orchestrator,
    activeAgentId,
    !!toolContext.invokeAgent,
  );
  try {
    let result: AgentRunResult = await runAgentTurnWithTools(orchestrator, activeAgentId, prompt, sendOptions, {
      maxToolRounds,
      toolContext,
      toolHooks,
    });

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
        namespace: toolContext.historyNamespace ?? "agent",
        sessionId: toolContext.historySessionId ?? "default",
        invokeAgent: async (agentId, inputText, invokeOptions) =>
          await runAgentTurnWithTools(
            orchestrator,
            agentId,
            injectToolGuide(inputText, { activeAgentId: agentId }),
            { streaming: false, signal: invokeOptions?.signal },
            { maxToolRounds, toolContext, toolHooks },
          ),
        supervisorAgentId: activeAgentId,
        supervisorName,
        maxSupervisorRounds,
        maxDelegations,
        maxParallelDelegations,
        taskTimeoutMs,
        maxTaskAttempts,
        retryBackoffMs,
        verificationCwd: toolContext.cwd ?? process.cwd(),
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
        result = await runAgentTurnWithTools(orchestrator, activeAgentId, finalPrompt, sendOptions, {
          maxToolRounds,
          toolContext,
          toolHooks,
        });

        if (looksLikeSupervisorVerdict(result.response)) {
          const retryPrompt = [
            finalPrompt,
            "",
            "⚠️ 注意：不要输出任何 JSON（包括 SupervisorVerdict）。请只用自然语言给用户最终答复。",
          ].join("\n");
          result = await runAgentTurnWithTools(orchestrator, activeAgentId, retryPrompt, sendOptions, {
            maxToolRounds,
            toolContext,
            toolHooks,
          });
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
          maxToolRounds,
          toolContext,
          toolHooks,
          signal: options.signal,
        });
        allDelegations.push(...delegations);

        const supervisorPrompt = buildSupervisorPrompt(delegations, rounds, supervisorName, supervisorGuide);
        if (!supervisorPrompt.trim()) {
          break;
        }

        result = await runAgentTurnWithTools(orchestrator, activeAgentId, supervisorPrompt, sendOptions, {
          maxToolRounds,
          toolContext,
          toolHooks,
        });
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
