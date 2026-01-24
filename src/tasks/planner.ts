import type { AgentIdentifier } from "../agents/types.js";
import type { HybridOrchestrator } from "../agents/orchestrator.js";
import type { AsyncLock } from "../utils/asyncLock.js";

import type { PlanStepInput, Task } from "./types.js";

export interface TaskPlanner {
  generatePlan(task: Task, options?: { signal?: AbortSignal }): Promise<PlanStepInput[]>;
}

function extractJsonPayload(text: string): string | null {
  const raw = String(text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return null;
}

function tryParsePlan(text: string): PlanStepInput[] | null {
  const candidates = [extractJsonPayload(text), text].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const jsonText = (() => {
      if (trimmed.startsWith("[")) {
        return trimmed;
      }
      const start = trimmed.indexOf("[");
      const end = trimmed.lastIndexOf("]");
      if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1);
      }
      return null;
    })();
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText) as Array<Record<string, unknown>>;
      if (!Array.isArray(parsed)) continue;
      const steps: PlanStepInput[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const stepRaw = entry.step ?? entry.stepNumber ?? entry["step_number"];
        const stepNumber = typeof stepRaw === "number" ? stepRaw : Number(stepRaw);
        const titleRaw = entry.title;
        const title = (typeof titleRaw === "string" ? titleRaw : String(titleRaw ?? "")).trim();
        const descriptionRaw = entry.description;
        const description = descriptionRaw == null ? null : String(descriptionRaw);
        if (!Number.isFinite(stepNumber) || stepNumber <= 0 || !title) {
          continue;
        }
        steps.push({ stepNumber: Math.floor(stepNumber), title, description });
      }
      if (steps.length) {
        steps.sort((a, b) => a.stepNumber - b.stepNumber);
        return steps;
      }
    } catch {
      // keep trying
    }
  }
  return null;
}

function selectAgentForModel(model: string): AgentIdentifier {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (normalized.startsWith("gemini")) {
    return "gemini";
  }
  return "codex";
}

export class SimpleTaskPlanner implements TaskPlanner {
  async generatePlan(task: Task): Promise<PlanStepInput[]> {
    void task;
    return [
      { stepNumber: 1, title: "明确目标", description: "确认要做什么与约束" },
      { stepNumber: 2, title: "执行", description: "完成主要工作并输出关键结果" },
      { stepNumber: 3, title: "收尾", description: "验证/总结并给出下一步" },
    ];
  }
}

export class OrchestratorTaskPlanner implements TaskPlanner {
  private readonly getOrchestrator: (task: Task) => HybridOrchestrator;
  private readonly planModel: string;
  private readonly lock?: AsyncLock;

  constructor(options: { getOrchestrator: (task: Task) => HybridOrchestrator; planModel: string; lock?: AsyncLock }) {
    this.getOrchestrator = options.getOrchestrator;
    this.planModel = String(options.planModel ?? "").trim() || "gpt-5";
    this.lock = options.lock;
  }

  private normalizePlan(raw: PlanStepInput[]): PlanStepInput[] {
    const normalized = raw
      .map((s, idx) => ({
        stepNumber: Number.isFinite(s.stepNumber) ? Math.max(1, Math.floor(s.stepNumber)) : idx + 1,
        title: String(s.title ?? "").trim(),
        description: s.description == null ? null : String(s.description),
      }))
      .filter((s) => s.title);

    if (normalized.length <= 3) {
      return normalized
        .slice(0, 3)
        .map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    }

    const first = normalized[0];
    const second = normalized[1];
    const rest = normalized.slice(2);
    const mergedTitle = "执行与收尾";
    const mergedDescription = rest.map((s, idx) => `- ${idx + 3}. ${s.title}${s.description ? `：${s.description}` : ""}`).join("\n");
    return [
      { stepNumber: 1, title: first?.title ?? "明确目标", description: first?.description ?? null },
      { stepNumber: 2, title: second?.title ?? "执行", description: second?.description ?? null },
      { stepNumber: 3, title: mergedTitle, description: mergedDescription || null },
    ];
  }

  async generatePlan(task: Task, options?: { signal?: AbortSignal }): Promise<PlanStepInput[]> {
    const orchestrator = this.getOrchestrator(task);
    const agentId = selectAgentForModel(this.planModel);
    orchestrator.setModel(this.planModel);

    const prompt = [
      "分析以下任务，生成执行计划。",
      "",
      `任务: ${task.title}`,
      `描述: ${task.prompt}`,
      "",
      "返回 JSON 格式的步骤列表:",
      "[",
      '  {"step": 1, "title": "步骤标题", "description": "详细描述"},',
      "  ...",
      "]",
      "",
      "要求:",
      "- 每个步骤应该是可独立验证的",
      "- 步骤数量控制在 2-3 步（越少越好）",
      "- 只输出 JSON（可放在 ```json 代码块）",
    ].join("\n");

    const invoke = () => orchestrator.invokeAgent(agentId, prompt, { signal: options?.signal, streaming: false });
    const result = await (this.lock ? this.lock.runExclusive(invoke) : invoke());
    const parsed = tryParsePlan(result.response);
    if (parsed && parsed.length) {
      return this.normalizePlan(parsed);
    }
    return this.normalizePlan(await new SimpleTaskPlanner().generatePlan(task));
  }
}
