import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import type { TaskStore } from "./store.js";
import type { PlanStepInput, Task, TaskContext } from "./types.js";

export interface TaskExecutorHooks {
  onStepStart?: (step: PlanStepInput) => void;
  onStepComplete?: (step: PlanStepInput, output: string) => void;
  onMessage?: (message: { role: string; content: string; modelUsed?: string | null }) => void;
  onMessageDelta?: (message: { role: string; delta: string; modelUsed?: string | null }) => void;
  onCommand?: (payload: { command: string }) => void;
}

export interface TaskExecutor {
  execute(task: Task, plan: PlanStepInput[], options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks }): Promise<{ resultSummary?: string }>;
}

function selectAgentForModel(model: string): AgentIdentifier {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (normalized.startsWith("gemini")) {
    return "gemini";
  }
  return "codex";
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

export class OrchestratorTaskExecutor implements TaskExecutor {
  private readonly getOrchestrator: (task: Task) => HybridOrchestrator;
  private readonly store: TaskStore;
  private readonly defaultModel: string;
  private readonly lock?: AsyncLock;

  constructor(options: { getOrchestrator: (task: Task) => HybridOrchestrator; store: TaskStore; defaultModel: string; lock?: AsyncLock }) {
    this.getOrchestrator = options.getOrchestrator;
    this.store = options.store;
    this.defaultModel = String(options.defaultModel ?? "").trim() || "gpt-5.2";
    this.lock = options.lock;
  }

  async execute(
    task: Task,
    plan: PlanStepInput[],
    options?: { signal?: AbortSignal; hooks?: TaskExecutorHooks },
  ): Promise<{ resultSummary?: string }> {
    const run = async (): Promise<{ resultSummary?: string }> => {
      const orchestrator = this.getOrchestrator(task);
      const desiredModel = String(task.model ?? "").trim() || "auto";
      const modelToUse = desiredModel === "auto" ? this.defaultModel : desiredModel;
      const agentId = selectAgentForModel(modelToUse);
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
        for (const step of plan) {
          options?.hooks?.onStepStart?.(step);

          const history = this.store
            .getConversationMessages(conversationId, { limit: 16 })
            .filter((msg) => msg.role === "user" || msg.role === "assistant");
          const historySnippet =
            history.length > 0
              ? ["历史记录（最近）：", ...history.map((msg) => `- ${msg.role}: ${truncate(msg.content, 800)}`), ""].join("\n")
              : "";

          this.store.updatePlanStep(task.id, step.stepNumber, "running", Date.now());
          const planStepId = this.store.getPlanStepId(task.id, step.stepNumber);

          const stepHeader = `步骤 ${step.stepNumber}: ${step.title}`;
          this.store.addMessage({
            taskId: task.id,
            planStepId,
            role: "system",
            content: `开始执行：${stepHeader}`,
            messageType: "step",
            modelUsed: null,
            tokenCount: null,
            createdAt: Date.now(),
          });
          this.store.addConversationMessage({
            conversationId,
            taskId: task.id,
            role: "system",
            content: `开始执行：${stepHeader}`,
            modelId: null,
            tokenCount: null,
            metadata: { planStepNumber: step.stepNumber },
            createdAt: Date.now(),
          });

          const includePatchHint = step.stepNumber === 1 && Boolean(patchHint);
          const prompt = [
            "你正在执行一个任务队列中的步骤。请按当前步骤完成工作，并输出结果。",
            "",
            includePatchHint ? patchHint : "",
            includePatchHint ? "" : "",
            historySnippet ? "（上下文）\n" + historySnippet : "",
            `任务标题: ${task.title}`,
            `任务描述: ${task.prompt}`,
            "",
            `当前步骤: ${step.stepNumber}. ${step.title}`,
            step.description ? `步骤说明: ${step.description}` : "",
            "",
            "要求：",
            "- 直接完成该步骤，不要输出多余的流程性内容",
            "- 如果需要更多信息，说明缺失点并提出具体问题",
          ]
            .filter(Boolean)
            .join("\n");

          const storedPrompt = [
            `任务标题: ${task.title}`,
            `任务描述: ${task.prompt}`,
            `步骤: ${step.stepNumber}. ${step.title}`,
            step.description ? `步骤说明: ${step.description}` : "",
          ]
            .filter(Boolean)
            .join("\n");

          this.store.addConversationMessage({
            conversationId,
            taskId: task.id,
            role: "user",
            content: storedPrompt,
            modelId: modelToUse,
            tokenCount: null,
            metadata: { planStepNumber: step.stepNumber },
            createdAt: Date.now(),
          });

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
                      planStepId,
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
            result = await orchestrator.invokeAgent(agentId, prompt, {
              signal: options?.signal,
              streaming: true,
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

          this.store.addMessage({
            taskId: task.id,
            planStepId,
            role: "assistant",
            content: lastOutput,
            messageType: "text",
            modelUsed: modelToUse,
            tokenCount: null,
            createdAt: Date.now(),
          });
          this.store.addConversationMessage({
            conversationId,
            taskId: task.id,
            role: "assistant",
            content: lastOutput,
            modelId: modelToUse,
            tokenCount: null,
            metadata: { planStepNumber: step.stepNumber },
            createdAt: Date.now(),
          });

          this.store.updatePlanStep(task.id, step.stepNumber, "completed", Date.now());
          options?.hooks?.onStepComplete?.(step, lastOutput);
        }
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
