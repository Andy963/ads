import crypto from "node:crypto";

import type { AgentIdentifier } from "../../types.js";
import type { HybridOrchestrator } from "../../orchestrator.js";

import { TaskSpecSchema, type TaskSpec, extractJsonPayload } from "../schemas.js";
import { runVerification } from "../verificationRunner.js";

interface DelegationDirective {
  agentId: AgentIdentifier;
  prompt: string;
}

const DELEGATION_REGEX = /<<<agent\.([a-z0-9_-]+)[\t ]*\r?\n([\s\S]*?)>>>/gi;

export function createTaskId(): string {
  return `t_${crypto.randomBytes(6).toString("hex")}`;
}

export function normalizeAgentKey(agentId: AgentIdentifier): string {
  return String(agentId ?? "").trim().toLowerCase();
}

export function truncate(text: string, limit = 1400): string {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) {
    return false;
  }
  if (["1", "true", "on", "yes"].includes(normalized)) {
    return true;
  }
  return undefined;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const duration = Math.max(0, Math.floor(ms));
  if (duration === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortError = new Error("用户中断了请求");
      abortError.name = "AbortError";
      reject(abortError);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          // ignore
        }
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const abortError = new Error("用户中断了请求");
      abortError.name = "AbortError";
      reject(abortError);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, duration);
  });
}

export function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (parent) {
      try {
        parent.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
    }
  };

  return { signal: controller.signal, cleanup };
}

export function extractDelegationDirectives(text: string, excludeAgentId?: AgentIdentifier): DelegationDirective[] {
  const directives: DelegationDirective[] = [];
  const regex = new RegExp(DELEGATION_REGEX.source, DELEGATION_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const agentId = (match[1] ?? "").trim().toLowerCase();
    const prompt = (match[2] ?? "").trim();
    if (!agentId || !prompt) {
      continue;
    }
    if (excludeAgentId && agentId === excludeAgentId) {
      continue;
    }
    directives.push({ agentId, prompt });
  }
  return directives;
}

export function buildLegacyTaskSpec(directive: DelegationDirective): TaskSpec {
  return TaskSpecSchema.parse({
    taskId: createTaskId(),
    agentId: directive.agentId,
    revision: 1,
    goal: directive.prompt,
    constraints: [],
    deliverables: [],
    acceptanceCriteria: [],
    verification: { commands: [] },
  });
}

export function tryParseTaskSpecFromPrompt(directive: DelegationDirective): TaskSpec | null {
  const payload = extractJsonPayload(directive.prompt) ?? directive.prompt;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const merged: Record<string, unknown> = { ...parsed };
    if (!merged.agentId && !merged.agent_id && !merged.agent) {
      merged.agentId = directive.agentId;
    }
    if (!merged.taskId && !merged.task_id && !merged.id) {
      merged.taskId = createTaskId();
    } else if (!merged.taskId) {
      merged.taskId = (merged.task_id ?? merged.id) as unknown;
    }
    if (!merged.revision) {
      merged.revision = 1;
    }
    if (!merged.goal && typeof merged.prompt === "string") {
      merged.goal = merged.prompt;
    }

    const normalized: Record<string, unknown> = {
      taskId: merged.taskId,
      parentTaskId: merged.parentTaskId ?? merged.parent_task_id ?? merged.parent,
      agentId: merged.agentId ?? merged.agent_id ?? merged.agent,
      revision: merged.revision,
      goal: merged.goal,
      constraints: merged.constraints ?? [],
      deliverables: merged.deliverables ?? [],
      acceptanceCriteria: merged.acceptanceCriteria ?? merged.acceptance_criteria ?? merged.acceptance ?? [],
      verification: merged.verification ?? { commands: [] },
    };

    const validated = TaskSpecSchema.safeParse(normalized);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

export function safeAgentName(orchestrator: HybridOrchestrator, agentId: AgentIdentifier): string {
  const descriptor = orchestrator.listAgents().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

export function formatVerification(report: Awaited<ReturnType<typeof runVerification>>): string {
  if (!report.enabled) {
    return "（自动验收：已禁用）";
  }
  if (!report.results.length) {
    return "（自动验收：无命令）";
  }
  const lines: string[] = [];
  for (const result of report.results) {
    const cmd = [result.cmd, ...(result.args ?? [])].join(" ").trim();
    const marker = result.ok ? "✅" : "❌";
    const exitPart = `exit=${result.exitCode ?? "null"} expect=${result.expectedExitCode}`;
    const timing = `elapsed=${result.elapsedMs}ms${result.timedOut ? " timeout" : ""}`;
    lines.push(`${marker} ${cmd} (${exitPart}; ${timing})`);
    if (result.notes?.length) {
      lines.push(`  notes: ${result.notes.join("; ")}`);
    }
  }
  return lines.join("\n");
}

export async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    (async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          break;
        }
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}
