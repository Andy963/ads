import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import { runBootstrapLoop } from "../bootstrap/bootstrapLoop.js";
import { CodexBootstrapAgentRunner } from "../bootstrap/agentRunner.js";
import { NoopSandbox } from "../bootstrap/sandbox.js";
import type { BootstrapProjectRef } from "../bootstrap/types.js";

import type { TaskStore } from "./store.js";
import type { Task, TaskContext } from "./types.js";
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

function safeJsonParse<T>(raw: string): T | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

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
  const parsed = safeJsonParse<TaskWorkspacePatchArtifact>(context.content);
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

type BootstrapModelParams = {
  bootstrap?: {
    enabled?: boolean;
    projectRef?: string;
    maxIterations?: number;
    softSandbox?: boolean;
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
  private readonly defaultModel: string;
  private readonly lock?: AsyncLock;

  constructor(options: {
    getOrchestrator: (task: Task) => HybridOrchestrator;
    getAgentEnv?: (task: Task, agentId: AgentIdentifier) => Record<string, string> | undefined;
    store: TaskStore;
    defaultModel: string;
    lock?: AsyncLock;
  }) {
    this.getOrchestrator = options.getOrchestrator;
    this.getAgentEnv = options.getAgentEnv;
    this.store = options.store;
    this.defaultModel = String(options.defaultModel ?? "").trim() || "gpt-5.2";
    this.lock = options.lock;
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

    const desiredModel = String(task.model ?? "").trim() || "auto";
    const modelToUse = desiredModel === "auto" ? this.defaultModel : desiredModel;
    const sandbox = new NoopSandbox();
    const agentRunner = new CodexBootstrapAgentRunner({ sandbox, model: modelToUse });

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
          onIteration(progress) {
            const line = `bootstrap iter=${progress.iteration} ok=${progress.ok} lint=${progress.lint.ok ? "ok" : "fail"} test=${progress.test.ok ? "ok" : "fail"} strategy=${progress.strategy}`;
            options?.hooks?.onMessage?.({ role: "assistant", content: line, modelUsed: modelToUse });
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
        modelUsed: modelToUse,
        tokenCount: null,
        createdAt: Date.now(),
      });
    } catch {
      // ignore
    }

    options?.hooks?.onMessage?.({ role: "assistant", content: summary, modelUsed: modelToUse });
    return { resultSummary: summary };
  }

  async execute(
    task: Task,
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const run = async (): Promise<{ resultSummary?: string }> => {
      const bootstrapConfig = extractBootstrapConfig(task);
      if (bootstrapConfig) {
        return this.executeBootstrap(task, bootstrapConfig, options);
      }

      const orchestrator = this.getOrchestrator(task);
      const desiredModel = String(task.model ?? "").trim() || "auto";
      const modelToUse = desiredModel === "auto" ? this.defaultModel : desiredModel;
      const agentId = selectAgentForTask({ agentId: task.agentId, modelToUse });
      orchestrator.setModel(modelToUse);

      const conversationId = String(task.threadId ?? "").trim() || `conv-${task.id}`;
      this.store.upsertConversation({ id: conversationId, taskId: task.id, title: task.title, lastModel: modelToUse }, Date.now());

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
          modelId: modelToUse,
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

        let lastRespondingText = "";
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
              const next = event.delta;
              let delta = next;
              if (lastRespondingText && next.startsWith(lastRespondingText)) {
                delta = next.slice(lastRespondingText.length);
              }
              if (next.length >= lastRespondingText.length) {
                lastRespondingText = next;
              }
              if (delta) {
                options?.hooks?.onMessageDelta?.({ role: "assistant", delta, modelUsed: modelToUse });
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
              modelUsed: modelToUse,
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
          modelId: modelToUse,
          tokenCount: null,
          metadata: null,
          createdAt: Date.now(),
        });
        options?.hooks?.onMessage?.({ role: "assistant", content: lastOutput, modelUsed: modelToUse });
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

    return this.lock ? this.lock.runExclusive(run) : run();
  }
}
