import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import { isAbortError } from "../utils/abort.js";
import { prepareTaskExecutionWorktree, readGitHead } from "../bootstrap/worktree.js";
import type { BootstrapProjectRef } from "../bootstrap/types.js";
import { safeParseJson } from "../utils/json.js";
import { mergeStreamingText } from "../utils/streamingText.js";

import type { TaskStore } from "./store.js";
import type { Task, TaskContext } from "./types.js";
import { applyTaskRunChanges, collectWorktreeChangedPaths } from "./applyBack.js";
import { selectAgentForTask } from "./agentSelection.js";

export interface TaskExecutorHooks {
  onMessage?: (message: { role: string; content: string; modelUsed?: string | null }) => void;
  onMessageDelta?: (message: { role: string; delta: string; modelUsed?: string | null }) => void;
  onCommand?: (payload: { command: string }) => void;
}

export interface TaskExecutor {
  execute(task: Task, options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks }): Promise<{ resultSummary?: string }>;
}

function truncate(text: string, limit = 4000): string {
  const normalized = String(text ?? "");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

type WorkspacePatchFileStat = { path: string; added: number | null; removed: number | null };
type WorkspacePatchPayload = { files: WorkspacePatchFileStat[]; diff: string; truncated: boolean };
type TaskWorkspacePatchArtifact = { paths: string[]; patch: WorkspacePatchPayload | null; reason?: string; createdAt: number };
type TaskWorktreeReferenceContext = { worktreeDir: string; source?: string; createdAt: number };
type ReviewArtifactReferenceContext = {
  reviewArtifactId?: string;
  snapshotId?: string;
  taskId?: string;
  verdict?: string | null;
  scope?: string | null;
  summaryText?: string;
  responseText?: string;
  createdAt?: number;
};

function getLatestContextOfType(contexts: TaskContext[], contextType: string): TaskContext | null {
  const type = String(contextType ?? "").trim();
  if (!type) return null;
  for (let i = contexts.length - 1; i >= 0; i--) {
    const c = contexts[i];
    if (c && c.contextType === type) return c;
  }
  return null;
}

function formatWorkspacePatchArtifactForPrompt(context: TaskContext | null): string {
  if (!context) return "";
  const parsed = safeParseJson<TaskWorkspacePatchArtifact>(context.content);
  if (!parsed) return "";
  const paths = Array.isArray(parsed.paths) ? parsed.paths.map((p) => String(p ?? "").trim()).filter(Boolean) : [];
  const patch = parsed.patch ?? null;
  const reason = parsed.reason ? String(parsed.reason) : "";

  const lines: string[] = [];
  lines.push("Previous attempt workspace changes:");
  if (paths.length > 0) {
    lines.push(`- Changed files (${paths.length}): ${paths.slice(0, 20).join(", ")}${paths.length > 20 ? " ..." : ""}`);
  } else {
    lines.push("- Changed files: (unknown)");
  }
  if (!patch || !patch.diff.trim()) {
    lines.push(`- Patch: (unavailable)${reason ? ` reason=${reason}` : ""}`);
    return lines.join("\n");
  }
  lines.push(`- Patch truncated: ${patch.truncated ? "yes" : "no"}`);
  lines.push("");
  lines.push("```diff");
  lines.push(patch.diff.trimEnd());
  lines.push("```");
  return lines.join("\n");
}

function formatReviewArtifactReferenceForPrompt(context: TaskContext | null): string {
  if (!context) return "";
  const parsed = safeParseJson<ReviewArtifactReferenceContext>(context.content);
  if (!parsed) return "";
  const reviewArtifactId = String(parsed.reviewArtifactId ?? "").trim();
  const snapshotId = String(parsed.snapshotId ?? "").trim();
  const taskId = String(parsed.taskId ?? "").trim();
  if (!reviewArtifactId || !snapshotId) return "";

  const lines: string[] = [];
  lines.push("Explicit reviewer guidance artifact:");
  lines.push(`- reviewArtifactId: ${reviewArtifactId}`);
  lines.push(`- snapshotId: ${snapshotId}`);
  if (taskId) {
    lines.push(`- sourceTaskId: ${taskId}`);
  }
  const verdict = String(parsed.verdict ?? "").trim();
  if (verdict) {
    lines.push(`- verdict: ${verdict}`);
  }
  const scope = String(parsed.scope ?? "").trim();
  if (scope) {
    lines.push(`- scope: ${scope}`);
  }
  const summaryText = String(parsed.summaryText ?? "").trim();
  if (summaryText) {
    lines.push("- summary:");
    lines.push(summaryText);
  }
  const responseText = String(parsed.responseText ?? "").trim();
  if (responseText) {
    lines.push("");
    lines.push("Reviewer response:");
    lines.push(responseText);
  }
  return lines.join("\n");
}

export function persistTaskWorktreeReference(
  store: Pick<TaskStore, "saveContext">,
  taskId: string,
  input: { worktreeDir?: string | null; source?: string | null },
  now = Date.now(),
): void {
  const id = String(taskId ?? "").trim();
  const worktreeDir = String(input.worktreeDir ?? "").trim();
  if (!id || !worktreeDir) {
    return;
  }
  const payload: TaskWorktreeReferenceContext = {
    worktreeDir,
    source: String(input.source ?? "").trim() || undefined,
    createdAt: now,
  };
  store.saveContext(
    id,
    { contextType: "artifact:worktree_reference", content: JSON.stringify(payload), createdAt: now },
    now,
  );
}

type BootstrapModelParams = {
  bootstrap?: {
    enabled?: boolean;
    projectRef?: string;
    maxIterations?: number;
  };
};

function extractBootstrapConfig(task: Task): BootstrapModelParams["bootstrap"] | null {
  const params = task.modelParams as BootstrapModelParams | null | undefined;
  if (!params?.bootstrap?.enabled) return null;
  const ref = String(params.bootstrap.projectRef ?? "").trim();
  if (!ref) return null;
  return params.bootstrap;
}

function looksLikeGitUrl(value: string): boolean {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  if (trimmed.startsWith("git@") || trimmed.startsWith("ssh://")) return true;
  return false;
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

  private async executeBootstrap(
    task: Task,
    config: NonNullable<BootstrapModelParams["bootstrap"]>,
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const ref = String(config.projectRef ?? "").trim();
    const project: BootstrapProjectRef = looksLikeGitUrl(ref)
      ? { kind: "git_url", value: ref }
      : { kind: "local_path", value: ref };

    const { modelOverride, modelForStorage } = this.resolveModelOverride(task);

    const [{ runBootstrapLoop }, { CodexBootstrapAgentRunner }, { NoopSandbox }] = await Promise.all([
      import("../bootstrap/bootstrapLoop.js"),
      import("../bootstrap/agentRunner.js"),
      import("../bootstrap/sandbox.js"),
    ]);

    const sandbox = new NoopSandbox();
    const agentRunner = new CodexBootstrapAgentRunner({ sandbox, model: modelOverride });

    const maxIterations = typeof config.maxIterations === "number" && Number.isFinite(config.maxIterations)
      ? Math.max(1, Math.min(10, config.maxIterations))
      : 10;

    const result = await runBootstrapLoop(
      {
        project,
        goal: task.prompt,
        maxIterations,
        allowNetwork: true,
        allowInstallDeps: true,
        requireHardSandbox: false,
        sandbox: { backend: "none" },
      },
      {
        agentRunner,
        signal: options?.signal,
        hooks: {
          onStarted: (ctx) => {
            try {
              persistTaskWorktreeReference(this.store, task.id, { worktreeDir: ctx.worktreeDir, source: "bootstrap" });
            } catch {
              // ignore
            }
          },
          onIteration(progress) {
            const line = `bootstrap iter=${progress.iteration} ok=${progress.ok} lint=${progress.lint.ok ? "ok" : "fail"} test=${progress.test.ok ? "ok" : "fail"} strategy=${progress.strategy}`;
            options?.hooks?.onMessage?.({ role: "assistant", content: line, modelUsed: modelForStorage });
          },
        },
      },
    );

    const lines: string[] = [];
    lines.push(`bootstrap ${result.ok ? "成功" : "失败"} iterations=${result.iterations} strategyChanges=${result.strategyChanges}`);
    if (result.finalBranch) lines.push(`branch: ${result.finalBranch}`);
    if (result.finalCommit) lines.push(`commit: ${result.finalCommit}`);
    if (result.error) lines.push(`error: ${result.error}`);
    const summary = lines.join("\n");

    try {
      this.store.addMessage({
        taskId: task.id,
        planStepId: null,
        role: "assistant",
        content: summary,
        messageType: "text",
        modelUsed: modelForStorage,
        tokenCount: null,
        createdAt: Date.now(),
      });
    } catch {
      // ignore
    }

    options?.hooks?.onMessage?.({ role: "assistant", content: summary, modelUsed: modelForStorage });
    return { resultSummary: summary };
  }

  async execute(
    task: Task,
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const run = async (): Promise<{ resultSummary?: string }> => {
      const executionIsolation = task.executionIsolation ?? "default";
      const bootstrapConfig = extractBootstrapConfig(task);
      if (bootstrapConfig) {
        return this.executeBootstrap(task, bootstrapConfig, options);
      }

      const startedAt = Date.now();
      const initialRun = this.store.createTaskRun(
        {
          taskId: task.id,
          executionIsolation,
          workspaceRoot: this.workspaceRoot,
          status: "preparing",
          captureStatus: task.reviewRequired && executionIsolation === "required" ? "pending" : "skipped",
          applyStatus: executionIsolation === "required" ? "pending" : "skipped",
        },
        startedAt,
      );
      let taskRun = initialRun;
      let executionCwd = this.workspaceRoot;

      const orchestrator = this.getOrchestrator(task);
      const { modelOverride, modelForSelection, modelForStorage } = this.resolveModelOverride(task);
      const agentId = selectAgentForTask({ agentId: task.agentId, modelToUse: modelForSelection });
      orchestrator.setModel(modelOverride);

      if (executionIsolation === "required") {
        try {
          const worktree = await prepareTaskExecutionWorktree({
            workspaceRoot: this.workspaceRoot,
            runId: taskRun.id,
            branchPrefix: "task-run",
            signal: options?.signal,
          });
          executionCwd = worktree.worktreeDir;
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              workspaceRoot: worktree.workspaceRoot,
              worktreeDir: worktree.worktreeDir,
              branchName: worktree.branchName,
              baseHead: worktree.baseHead,
              status: "running",
              startedAt,
            },
            startedAt,
          );
        } catch (error) {
          const terminalStatus = isAbortError(error) ? "cancelled" : "failed";
          const message = isAbortError(error) ? "cancelled" : (error instanceof Error ? error.message : String(error));
          try {
            const captureStatus =
              taskRun.captureStatus === "pending" ? (terminalStatus === "cancelled" ? "skipped" : "failed") : taskRun.captureStatus;
            const applyStatus =
              taskRun.applyStatus === "pending" ? (terminalStatus === "cancelled" ? "skipped" : "failed") : taskRun.applyStatus;
            taskRun = this.store.updateTaskRun(
              taskRun.id,
              {
                status: terminalStatus,
                captureStatus,
                applyStatus,
                error: message,
              },
              Date.now(),
            );
          } catch {
            // ignore
          }
          throw error;
        }
      } else {
        taskRun = this.store.updateTaskRun(
          taskRun.id,
          {
            status: "running",
            startedAt,
            applyStatus: "skipped",
            captureStatus: task.reviewRequired ? "pending" : "skipped",
          },
          startedAt,
        );
      }

      orchestrator.setWorkingDirectory(executionCwd);

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
      const reviewArtifactHint = formatReviewArtifactReferenceForPrompt(
        getLatestContextOfType(contexts, "artifact:review_artifact_reference"),
      );

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
          reviewArtifactHint ? reviewArtifactHint : "",
          reviewArtifactHint ? "" : "",
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
        try {
          const env = this.getAgentEnv?.(task, agentId);
          result = await orchestrator.invokeAgent(agentId, prompt, {
            signal: options?.signal,
            streaming: true,
            env,
          });
        } finally {
          try {
            unsubscribe();
          } catch {
            // ignore
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

        const endHead = taskRun.worktreeDir ? await readGitHead(taskRun.worktreeDir, options?.signal) : taskRun.endHead;
        if (executionIsolation === "required" && taskRun.worktreeDir && taskRun.baseHead && !task.reviewRequired) {
          const applyResult = await applyTaskRunChanges({
            workspaceRoot: taskRun.workspaceRoot,
            worktreeDir: taskRun.worktreeDir,
            baseHead: taskRun.baseHead,
            signal: options?.signal,
          });
          if (applyResult.status === "blocked" || applyResult.status === "failed") {
            this.store.updateTaskRun(
              taskRun.id,
              {
                endHead,
                status: "failed",
                applyStatus: applyResult.status,
                captureStatus: "skipped",
                error: applyResult.message ?? "apply-back failed",
              },
              Date.now(),
            );
            throw new Error(applyResult.message ?? "apply-back failed");
          }
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              endHead,
              status: "completed",
              applyStatus: applyResult.status === "applied" ? "applied" : "skipped",
              captureStatus: "skipped",
              error: null,
            },
            Date.now(),
          );
        } else {
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              endHead,
              status: "completed",
              captureStatus: executionIsolation === "required" && task.reviewRequired ? "pending" : "skipped",
              applyStatus: executionIsolation === "required" ? "pending" : "skipped",
              error: null,
            },
            Date.now(),
          );
        }
      } catch (error) {
        const terminalStatus = isAbortError(error) ? "cancelled" : "failed";
        const message = isAbortError(error) ? "cancelled" : (error instanceof Error ? error.message : String(error));
        try {
          const endHead = taskRun.worktreeDir ? await readGitHead(taskRun.worktreeDir, options?.signal).catch(() => taskRun.endHead) : taskRun.endHead;
          const captureStatus =
            taskRun.captureStatus === "pending" ? (terminalStatus === "cancelled" ? "skipped" : "failed") : taskRun.captureStatus;
          const applyStatus =
            taskRun.applyStatus === "pending" ? (terminalStatus === "cancelled" ? "skipped" : "failed") : taskRun.applyStatus;
          taskRun = this.store.updateTaskRun(
            taskRun.id,
            {
              endHead,
              status: terminalStatus,
              captureStatus,
              applyStatus,
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
          const isolatedPaths =
            taskRun.worktreeDir && executionIsolation === "required"
              ? await collectWorktreeChangedPaths(taskRun.worktreeDir, {
                  baseRef: taskRun.baseHead ?? undefined,
                  signal: options?.signal,
                }).catch(() => [])
              : [];
          const payload = { paths: isolatedPaths.length > 0 ? isolatedPaths : Array.from(changedPaths.values()) };
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
