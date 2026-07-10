import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import { isAbortError } from "../utils/abort.js";
import { mergeStreamingText } from "../utils/streamingText.js";

import type { TaskStore } from "./store.js";
import type { Task, TaskGoalStatus } from "./types.js";
import { selectAgentForTask } from "./agentSelection.js";
import {
  truncate,
  getLatestContextOfType,
  formatWorkspacePatchArtifactForPrompt,
} from "./executorHelpers.js";

export interface TaskExecutorHooks {
  onMessage?: (message: { role: string; content: string; modelUsed?: string | null }) => void;
  onMessageDelta?: (message: { role: string; delta: string; modelUsed?: string | null }) => void;
  onCommand?: (payload: { command: string }) => void;
  onGoalUpdate?: (goal: {
    status: TaskGoalStatus;
    objective: string;
    tokensUsed: number;
    timeUsedSeconds: number;
    tokenBudget: number | null;
  }) => void;
  onGoalCleared?: () => void;
}

export interface TaskExecutor {
  execute(task: Task, options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks }): Promise<{ resultSummary?: string }>;
}

export class OrchestratorTaskExecutor implements TaskExecutor {
  private readonly getOrchestrator: (task: Task) => HybridOrchestrator;
  private readonly getAgentEnv?: (task: Task, agentId: AgentIdentifier) => Record<string, string> | undefined;
  private readonly store: TaskStore;
  private readonly workspaceRoot: string;
  private readonly autoModelOverride?: string;
  private readonly lock?: AsyncLock;
  private readonly getLock?: () => AsyncLock;

  constructor(options: {
    getOrchestrator: (task: Task) => HybridOrchestrator;
    getAgentEnv?: (task: Task, agentId: AgentIdentifier) => Record<string, string> | undefined;
    store: TaskStore;
    workspaceRoot: string;
    autoModelOverride?: string;
    lock?: AsyncLock;
    getLock?: () => AsyncLock;
  }) {
    this.getOrchestrator = options.getOrchestrator;
    this.getAgentEnv = options.getAgentEnv;
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    this.autoModelOverride = String(options.autoModelOverride ?? "").trim() || undefined;
    this.lock = options.lock;
    this.getLock = options.getLock;
  }

  private resolveModelOverride(task: Task): { modelOverride?: string; modelForSelection: string; modelForStorage: string | null } {
    const desiredRaw = String(task.model ?? "").trim();
    const desired = desiredRaw && desiredRaw.toLowerCase() !== "auto" ? desiredRaw : "";
    const modelOverride = desired ? desired : this.autoModelOverride;
    return {
      modelOverride,
      modelForSelection: modelOverride ?? "default",
      modelForStorage: modelOverride ?? null,
    };
  }

  async execute(
    task: Task,
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const run = async (): Promise<{ resultSummary?: string }> => {
      const startedAt = Date.now();
      let taskRun = this.store.createTaskRun(
        {
          taskId: task.id,
          executionIsolation: "default",
          workspaceRoot: this.workspaceRoot,
          status: "running",
          captureStatus: "skipped",
          applyStatus: "skipped",
        },
        startedAt,
      );

      const orchestrator = this.getOrchestrator(task);
      const { modelOverride, modelForSelection, modelForStorage } = this.resolveModelOverride(task);
      const agentId = selectAgentForTask({ agentId: task.agentId, modelToUse: modelForSelection });
      orchestrator.setModel(modelOverride);

      orchestrator.setWorkingDirectory(this.workspaceRoot);

      const conversationId = String(task.threadId ?? "").trim() || `conv-${task.id}`;
      this.store.upsertConversation({ id: conversationId, taskId: task.id, title: task.title, lastModel: modelForStorage }, Date.now());

      let lastOutput = "";
      const changedPaths = new Set<string>();
      const contexts = (() => {
        try {
          return this.store.getContext(task.id);
        } catch {
          return [];
        }
      })();
      const latestPatchContext =
        getLatestContextOfType(contexts, "artifact:previous_workspace_patch") ?? getLatestContextOfType(contexts, "artifact:workspace_patch");
      const patchHint = formatWorkspacePatchArtifactForPrompt(latestPatchContext);

      try {
        const history = this.store
          .getConversationMessages(conversationId, { limit: 16 })
          .filter((msg) => msg.role === "user" || msg.role === "assistant");
        const historySnippet =
          history.length > 0
            ? ["历史记录（最近）：", ...history.map((msg) => `- ${msg.role}: ${truncate(msg.content, 800)}`), ""].join("\n")
            : "";

        const storedPrompt = [`任务标题: ${task.title}`, `任务描述: ${task.prompt}`].join("\n");
        try {
          const rawPrompt = String(task.prompt ?? "").trim();
          if (rawPrompt) {
            this.store.addMessage({
              taskId: task.id,
              planStepId: null,
              role: "user",
              content: rawPrompt,
              messageType: "task",
              modelUsed: null,
              tokenCount: null,
              createdAt: Date.now(),
            });
          }
        } catch {
          // ignore
        }
        this.store.addConversationMessage({
          conversationId,
          taskId: task.id,
          role: "user",
          content: storedPrompt,
          modelId: modelForStorage,
          tokenCount: null,
          metadata: null,
          createdAt: Date.now(),
        });

        const prompt = [
          "你正在执行一个任务队列中的任务。请完成任务并输出结果。",
          "",
          patchHint ? patchHint : "",
          patchHint ? "" : "",
          historySnippet ? "（上下文）\n" + historySnippet : "",
          `任务标题: ${task.title}`,
          `任务描述: ${task.prompt}`,
          "",
          "要求：",
          "- 直接完成任务，不要输出多余的流程性内容",
          "- 如果需要更多信息，说明缺失点并提出具体问题",
        ]
          .filter(Boolean)
          .join("\n");

        let respondingText = "";
        const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
          try {
            const raw = event.raw as unknown as { type?: unknown; item?: unknown };
            const rawItem = raw && typeof raw === "object" ? (raw as { item?: unknown }).item : null;
            const rawItemType =
              rawItem && typeof rawItem === "object" ? String((rawItem as { type?: unknown }).type ?? "").trim() : "";
            if (raw && typeof raw === "object" && String((raw as { type?: unknown }).type ?? "") === "item.completed" && rawItemType === "file_change") {
              const item = rawItem as { changes?: unknown };
              const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: unknown }>) : [];
              for (const change of changes) {
                const p = String(change?.path ?? "").trim();
                if (p) changedPaths.add(p);
              }
            }

            if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
              const merged = mergeStreamingText(respondingText, event.delta);
              respondingText = merged.full;
              if (merged.delta) {
                options?.hooks?.onMessageDelta?.({ role: "assistant", delta: merged.delta, modelUsed: modelForStorage });
              }
              return;
            }
            if (event.phase === "command" && event.title === "执行命令" && event.detail) {
              const command = String(event.detail).split(" | ")[0]?.trim();
              if (command) {
                try {
                  this.store.addMessage({
                    taskId: task.id,
                    planStepId: null,
                    role: "system",
                    content: `$ ${command}`,
                    messageType: "command",
                    modelUsed: null,
                    tokenCount: null,
                    createdAt: Date.now(),
                  });
                } catch {
                  // ignore
                }
                options?.hooks?.onCommand?.({ command });
              }
            }
          } catch {
            // ignore
          }
        });

        let result;
        const goalUnsubs: Array<() => void> = [];
        try {
          // Subscribe to goal updates upfront (no-op for non-app-server adapters)
          // so the first goal notification is captured.
          if (task.goalMode) {
            const adapter = orchestrator.getAdapter(agentId);
            if (adapter && typeof (adapter as { onGoalUpdate?: unknown }).onGoalUpdate === "function") {
              const goalAdapter = adapter as unknown as {
                onGoalUpdate: (cb: (goal: {
                  status: TaskGoalStatus;
                  objective: string;
                  tokensUsed: number;
                  timeUsedSeconds: number;
                  tokenBudget: number | null;
                }) => void) => () => void;
                onGoalCleared: (cb: () => void) => () => void;
              };
              goalUnsubs.push(
                goalAdapter.onGoalUpdate((goal) => {
                  try {
                    this.store.updateTask(task.id, {
                      goalStatus: goal.status,
                      goalObjective: goal.objective,
                      goalTokensUsed: goal.tokensUsed,
                      goalTimeUsedSeconds: goal.timeUsedSeconds,
                      goalTokenBudget: goal.tokenBudget ?? null,
                    });
                  } catch {
                    // ignore: best-effort persistence
                  }
                  options?.hooks?.onGoalUpdate?.({
                    status: goal.status,
                    objective: goal.objective,
                    tokensUsed: goal.tokensUsed,
                    timeUsedSeconds: goal.timeUsedSeconds,
                    tokenBudget: goal.tokenBudget ?? null,
                  });
                }),
              );
              goalUnsubs.push(
                goalAdapter.onGoalCleared(() => {
                  try {
                    this.store.updateTask(task.id, {
                      goalStatus: null,
                      goalTokensUsed: null,
                      goalTimeUsedSeconds: null,
                    });
                  } catch {
                    // ignore
                  }
                  options?.hooks?.onGoalCleared?.();
                }),
              );
            }
          }

          const env = this.getAgentEnv?.(task, agentId);
          result = await orchestrator.invokeAgent(agentId, prompt, {
            signal: options?.signal,
            streaming: true,
            env,
          });

          // Set the goal AFTER the first turn so threadId is available. For
          // single-turn tasks this still records the goal for later reads.
          if (task.goalMode) {
            const adapter = orchestrator.getAdapter(agentId);
            if (adapter && typeof (adapter as { setGoal?: unknown }).setGoal === "function") {
              const goalAdapter = adapter as unknown as {
                setGoal: (opts: { objective?: string; tokenBudget?: number | null }) => Promise<unknown>;
              };
              const objective = String(task.goalObjective ?? "").trim() || String(task.prompt ?? "").trim();
              try {
                await goalAdapter.setGoal({
                  objective,
                  tokenBudget: task.goalTokenBudget ?? null,
                });
              } catch (err) {
                // Non-fatal: log via console for diagnostic only.
                console.warn(`[executor] setGoal failed for task ${task.id}: ${err instanceof Error ? err.message : err}`);
              }
            }
          }
        } finally {
          try {
            unsubscribe();
          } catch {
            // ignore
          }
          for (const fn of goalUnsubs) {
            try { fn(); } catch { /* ignore */ }
          }
        }

        lastOutput =
          typeof (result as { response?: unknown } | null)?.response === "string"
            ? (result as { response: string }).response
            : String((result as { response?: unknown } | null)?.response ?? "");

        try {
          const trimmed = lastOutput.trim();
          if (trimmed) {
            this.store.addMessage({
              taskId: task.id,
              planStepId: null,
              role: "assistant",
              content: lastOutput,
              messageType: "text",
              modelUsed: modelForStorage,
              tokenCount: null,
              createdAt: Date.now(),
            });
          }
        } catch {
          // ignore
        }
        this.store.addConversationMessage({
          conversationId,
          taskId: task.id,
          role: "assistant",
          content: lastOutput,
          modelId: modelForStorage,
          tokenCount: null,
          metadata: null,
          createdAt: Date.now(),
        });
        options?.hooks?.onMessage?.({ role: "assistant", content: lastOutput, modelUsed: modelForStorage });

        taskRun = this.store.updateTaskRun(
          taskRun.id,
          {
            status: "completed",
            captureStatus: "skipped",
            applyStatus: "skipped",
            error: null,
          },
          Date.now(),
        );
      } catch (error) {
        const terminalStatus = isAbortError(error) ? "cancelled" : "failed";
        const message = isAbortError(error) ? "cancelled" : (error instanceof Error ? error.message : String(error));
        try {
          this.store.updateTaskRun(
            taskRun.id,
            {
              status: terminalStatus,
              captureStatus: "skipped",
              applyStatus: "skipped",
              error: message,
            },
            Date.now(),
          );
        } catch {
          // ignore
        }
        throw error;
      } finally {
        try {
          const payload = { paths: Array.from(changedPaths.values()) };
          this.store.saveContext(task.id, { contextType: "artifact:changed_paths", content: JSON.stringify(payload) }, Date.now());
        } catch {
          // ignore
        }
      }

      return { resultSummary: truncate(lastOutput, 1600) };
    };

    const lock = this.lock ?? this.getLock?.();
    return lock ? lock.runExclusive(run) : run();
  }
}
