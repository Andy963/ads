import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AgentEvent } from "../codex/events.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import type { TaskStore } from "./store.js";
import type { PlanStepInput, Task } from "./types.js";

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

        const prompt = [
          "你正在执行一个任务队列中的步骤。请按当前步骤完成工作，并输出结果。",
          "",
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

      return { resultSummary: truncate(lastOutput, 1600) };
    };

    return this.lock ? this.lock.runExclusive(run) : run();
  }
}
