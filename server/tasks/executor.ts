import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import { formatStepTraceLine, isStepTracePhase, type AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import { isAbortError } from "../utils/abort.js";
import { mergeStreamingText } from "../utils/streamingText.js";

import type { TaskStore } from "./store.js";
import type { Task, TaskExecutionIsolation, TaskGoalStatus, TaskRun } from "./types.js";
import { selectAgentForTask } from "./agentSelection.js";
import {
  truncate,
  getLatestContextOfType,
  formatWorkspacePatchArtifactForPrompt,
} from "./executorHelpers.js";
import { recordConversationMessage } from "../utils/conversationMessageRecorder.js";
import { createMiddlewarePipeline, type MiddlewarePipeline } from "../middleware/index.js";
import { buildWorkspacePatch } from "../web/gitPatch.js";
import { extractPullRequestReference } from "./reviewWorkflow.js";
import { TaskWorktreeManager, type TaskWorktree } from "./worktreeManager.js";

export interface TaskExecutorHooks {
  onMessage?: (message: { role: string; content: string; modelUsed?: string | null }) => void;
  onMessageDelta?: (message: {
    role: string;
    delta: string;
    modelUsed?: string | null;
    source?: "step" | "chat";
  }) => void;
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
  private readonly middleware?: MiddlewarePipeline;
  private readonly worktreeManager: TaskWorktreeManager;

  constructor(options: {
    getOrchestrator: (task: Task) => HybridOrchestrator;
    getAgentEnv?: (task: Task, agentId: AgentIdentifier) => Record<string, string> | undefined;
    store: TaskStore;
    workspaceRoot: string;
    autoModelOverride?: string;
    lock?: AsyncLock;
    getLock?: () => AsyncLock;
    middleware?: MiddlewarePipeline;
    worktreeManager?: TaskWorktreeManager;
  }) {
    this.getOrchestrator = options.getOrchestrator;
    this.getAgentEnv = options.getAgentEnv;
    this.store = options.store;
    this.workspaceRoot = options.workspaceRoot;
    this.autoModelOverride = String(options.autoModelOverride ?? "").trim() || undefined;
    this.lock = options.lock;
    this.getLock = options.getLock;
    this.middleware = options.middleware;
    this.worktreeManager = options.worktreeManager ?? new TaskWorktreeManager({ workspaceRoot: this.workspaceRoot });
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

  private persistTaskRunArtifacts(args: {
    task: Task;
    taskRun: TaskRun;
    worktree: TaskWorktree | null;
    changedPaths: Set<string>;
    result: string;
  }): TaskRun {
    const { task, worktree, changedPaths } = args;
    let taskRun = args.taskRun;
    if (worktree) {
      try {
        for (const changedPath of this.worktreeManager.collectChangedPaths(worktree)) {
          changedPaths.add(changedPath);
        }
      } catch {
        // Best-effort collection; the run record still retains the worktree identity.
      }
      const endHead = this.worktreeManager.readHead(worktree);
      try {
        taskRun = this.store.updateTaskRun(
          taskRun.id,
          {
            endHead,
            captureStatus: endHead ? "ok" : "failed",
          },
          Date.now(),
        );
      } catch {
        // The terminal task status remains authoritative when metadata persistence is unavailable.
      }
    }

    const paths = Array.from(changedPaths.values());
    const now = Date.now();
    try {
      this.store.saveContext(task.id, {
        contextType: "artifact:changed_paths",
        content: JSON.stringify({ paths }),
        createdAt: now,
      }, now);
    } catch {
      // ignore
    }

    if (worktree) {
      let patch = null;
      try {
        patch = buildWorkspacePatch(worktree.worktreeDir, paths, {
          baseRef: taskRun.baseHead ?? worktree.baseHead,
        });
      } catch {
        patch = null;
      }
      try {
        this.store.saveContext(task.id, {
          contextType: "artifact:workspace_patch",
          content: JSON.stringify({
            paths,
            patch,
            reason: patch ? undefined : "patch_not_available",
            createdAt: now,
          }),
          createdAt: now,
        }, now);
      } catch {
        // ignore
      }

      const pullRequest = extractPullRequestReference(args.result);
      try {
        this.store.saveContext(task.id, {
          contextType: "artifact:worker_handoff",
          content: JSON.stringify({
            taskRunId: taskRun.id,
            executionIsolation: taskRun.executionIsolation,
            workspaceRoot: taskRun.workspaceRoot,
            worktreeDir: taskRun.worktreeDir,
            branchName: taskRun.branchName,
            baseHead: taskRun.baseHead,
            endHead: taskRun.endHead,
            pullRequest,
            cleanupStatus: taskRun.cleanupStatus,
            createdAt: now,
          }),
          createdAt: now,
        }, now);
      } catch {
        // ignore
      }
    }
    return taskRun;
  }

  private cleanupTaskWorktree(taskRun: TaskRun, worktree: TaskWorktree | null): TaskRun {
    if (!worktree) {
      try {
        return this.store.updateTaskRun(taskRun.id, {
          cleanupStatus: taskRun.executionIsolation === "required" ? "cleaned" : "not_required",
          cleanupError: null,
          cleanupAt: Date.now(),
        }, Date.now());
      } catch {
        return taskRun;
      }
    }

    const cleanup = this.worktreeManager.cleanup(worktree);
    try {
      return this.store.updateTaskRun(taskRun.id, {
        cleanupStatus: cleanup.status,
        cleanupError: cleanup.error,
        cleanupAt: cleanup.cleanedAt,
      }, cleanup.cleanedAt);
    } catch {
      return taskRun;
    }
  }

  async execute(
    task: Task,
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const run = async (): Promise<{ resultSummary?: string }> => {
      const startedAt = Date.now();
      const executionIsolation: TaskExecutionIsolation = task.executionIsolation === "required" ? "required" : "default";
      let taskRun = this.store.createTaskRun(
        {
          taskId: task.id,
          executionIsolation,
          workspaceRoot: this.workspaceRoot,
          status: "preparing",
          captureStatus: executionIsolation === "required" ? "pending" : "skipped",
          applyStatus: "skipped",
          cleanupStatus: executionIsolation === "required" ? "pending" : "not_required",
        },
        startedAt,
      );
      let taskWorktree: TaskWorktree | null = null;
      let executionWorkspaceRoot = this.workspaceRoot;
      const changedPaths = new Set<string>();
      let lastOutput = "";

      try {
        if (executionIsolation === "required") {
          taskWorktree = this.worktreeManager.prepare(task.id, taskRun.id);
          executionWorkspaceRoot = taskWorktree.worktreeDir;
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              status: "running",
              worktreeDir: taskWorktree.worktreeDir,
              branchName: taskWorktree.branchName,
              baseHead: taskWorktree.baseHead,
              cleanupStatus: "pending",
            },
            Date.now(),
          );
        } else {
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            { status: "running", captureStatus: "skipped", cleanupStatus: "not_required" },
            Date.now(),
          );
        }

        const orchestrator = this.getOrchestrator(task);
        const { modelOverride, modelForSelection, modelForStorage } = this.resolveModelOverride(task);
        const agentId = selectAgentForTask({ agentId: task.agentId, modelToUse: modelForSelection });
        orchestrator.setModel(modelOverride);
        orchestrator.setWorkingDirectory(executionWorkspaceRoot);

        const conversationId = String(task.threadId ?? "").trim() || `conv-${task.id}`;
        this.store.upsertConversation({ id: conversationId, taskId: task.id, title: task.title, lastModel: modelForStorage }, Date.now());

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
        const persistedUser = this.store.addConversationMessage({
          conversationId,
          taskId: task.id,
          role: "user",
          content: storedPrompt,
          modelId: modelForStorage,
          tokenCount: null,
          metadata: null,
          createdAt: Date.now(),
        });
        recordConversationMessage({
          eventId: `${task.id}:user`,
          workspaceRoot: this.workspaceRoot,
          sessionId: conversationId,
          source: "task",
          role: "user",
          text: persistedUser.content,
          agentId,
        });

        const prompt = [
          "You are the Worker executing an approved task from the task queue.",
          "Execute the approved work item; do not invent a second plan or split one spec into extra tasks.",
          "If the task description contains a Work item handoff, read the pinned Advisor issue record and delivery spec before editing.",
          "The delivery spec is authoritative. Complete every acceptance criterion and report verification commands and results.",
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
                options?.hooks?.onMessageDelta?.({
                  role: "assistant",
                  delta: merged.delta,
                  modelUsed: modelForStorage,
                  source: "chat",
                });
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
              return;
            }

            if (isStepTracePhase(event.phase)) {
              const line = formatStepTraceLine(event);
              if (line) {
                options?.hooks?.onMessageDelta?.({
                  role: "assistant",
                  delta: line,
                  modelUsed: modelForStorage,
                  source: "step",
                });
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
          const middleware = this.middleware ?? createMiddlewarePipeline();
          const middlewareContext = {
            turnId: `task:${task.id}`,
            sessionId: conversationId,
            workspaceRoot: executionWorkspaceRoot,
            channel: "task_queue" as const,
          };
          const effectivePrompt = await middleware.executeBeforeInput({ ...middlewareContext, prompt });
          await middleware.executeTurnStart({ ...middlewareContext, prompt: effectivePrompt });
          try {
            result = await orchestrator.invokeAgent(agentId, effectivePrompt, {
              signal: options?.signal,
              streaming: true,
              env,
            });
            await middleware.executeAfterOutput(
              { ...middlewareContext, prompt: effectivePrompt },
              typeof result.response === "string" ? result.response : String(result.response ?? ""),
            );
          } catch (error) {
            await middleware.executeTurnError(
              { ...middlewareContext, prompt: effectivePrompt },
              error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
          }

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
        const persistedAssistant = this.store.addConversationMessage({
          conversationId,
          taskId: task.id,
          role: "assistant",
          content: lastOutput,
          modelId: modelForStorage,
          tokenCount: null,
          metadata: null,
          createdAt: Date.now(),
        });
        recordConversationMessage({
          eventId: `${task.id}:assistant`,
          workspaceRoot: this.workspaceRoot,
          sessionId: conversationId,
          source: "task",
          role: "assistant",
          text: persistedAssistant.content,
          agentId,
        });
        options?.hooks?.onMessage?.({ role: "assistant", content: lastOutput, modelUsed: modelForStorage });

        taskRun = this.store.updateTaskRun(
          taskRun.id,
          {
            status: "completed",
            captureStatus: executionIsolation === "required" ? "pending" : "skipped",
            applyStatus: "skipped",
            error: null,
          },
          Date.now(),
        );
      } catch (error) {
        const terminalStatus = isAbortError(error) ? "cancelled" : "failed";
        const message = isAbortError(error) ? "cancelled" : (error instanceof Error ? error.message : String(error));
        try {
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              status: terminalStatus,
              captureStatus: executionIsolation === "required" ? "pending" : "skipped",
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
        taskRun = this.persistTaskRunArtifacts({
          task,
          taskRun,
          worktree: taskWorktree,
          changedPaths,
          result: lastOutput,
        });
        taskRun = this.cleanupTaskWorktree(taskRun, taskWorktree);
      }

      const resultSummary = truncate(lastOutput, 1400);
      if (taskRun.executionIsolation === "required" && taskRun.branchName) {
        const pullRequest = extractPullRequestReference(lastOutput);
        const handoff = [
          "Worker handoff:",
          `task run ${taskRun.id}`,
          `branch ${taskRun.branchName}`,
          pullRequest ? `PR #${pullRequest.number}${pullRequest.url ? ` (${pullRequest.url})` : ""}` : "PR reference unavailable",
        ].join(" | ");
        return { resultSummary: `${resultSummary}\n\n${handoff}`.trim() };
      }
      return { resultSummary };
    };

    const lock = this.lock ?? this.getLock?.();
    return lock ? lock.runExclusive(run) : run();
  }
}
