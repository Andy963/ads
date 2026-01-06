import crypto from "node:crypto";

import type { AgentIdentifier, AgentRunResult } from "../types.js";
import type { HybridOrchestrator } from "../orchestrator.js";

import { createLogger, type Logger } from "../../utils/logger.js";

import { TaskSpecSchema, TaskResultSchema, SupervisorVerdictSchema, extractJsonPayload, type TaskResult, type TaskSpec } from "./schemas.js";
import { TaskStore, type TaskStatus } from "./taskStore.js";
import { runVerification } from "./verificationRunner.js";

const logger = createLogger("TaskCoordinator");

interface DelegationDirective {
  agentId: AgentIdentifier;
  prompt: string;
}

export interface DelegationSummaryLike {
  agentId: AgentIdentifier;
  agentName: string;
  prompt: string;
  response: string;
}

export interface CollaborationHooksLike {
  onDelegationStart?: (summary: { agentId: AgentIdentifier; agentName: string; prompt: string }) => void | Promise<void>;
  onDelegationResult?: (summary: DelegationSummaryLike) => void | Promise<void>;
  onSupervisorRound?: (round: number, directives: number) => void | Promise<void>;
}

export interface TaskCoordinatorOptions {
  workspaceRoot: string;
  namespace: string;
  sessionId: string;
  stateDbPath?: string;
  invokeAgent?: (agentId: AgentIdentifier, input: string, options?: { signal?: AbortSignal }) => Promise<AgentRunResult>;
  supervisorAgentId: AgentIdentifier;
  supervisorName: string;
  maxSupervisorRounds: number;
  maxDelegations: number;
  maxParallelDelegations: number;
  taskTimeoutMs: number;
  maxTaskAttempts: number;
  retryBackoffMs: number;
  verificationCwd: string;
  signal?: AbortSignal;
  hooks?: CollaborationHooksLike;
  logger?: Logger;
}

const DELEGATION_REGEX = /<<<agent\.([a-z0-9_-]+)[\t ]*\r?\n([\s\S]*?)>>>/gi;

function createTaskId(): string {
  return `t_${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeAgentKey(agentId: AgentIdentifier): string {
  return String(agentId ?? "").trim().toLowerCase();
}

function truncate(text: string, limit = 1400): string {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function parseBoolean(value: string | undefined): boolean | undefined {
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

export function isCoordinatorEnabled(): boolean {
  const enabled = parseBoolean(process.env.ADS_COORDINATOR_ENABLED);
  return enabled !== false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
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

function extractDelegationDirectives(text: string, excludeAgentId?: AgentIdentifier): DelegationDirective[] {
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

function buildLegacyTaskSpec(directive: DelegationDirective): TaskSpec {
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

function tryParseTaskSpecFromPrompt(directive: DelegationDirective): TaskSpec | null {
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

function buildDelegatePrompt(spec: TaskSpec, revisionNote?: string | null): string {
  const note = String(revisionNote ?? "").trim();
  const noteSection = note ? `\n\nRevisionRequest:\n${note}` : "";

  return [
    "你是协作代理。请严格按要求输出结果：",
    "- 你可以使用 <<<tool.*>>> 指令块来读写文件/执行命令（系统会执行并把结果回灌给你）。",
    "- 不要输出 <<<agent.*>>> 指令块（禁止再委派给其它 agent）。",
    "- 当你认为任务已完成时，你的最后一条回复必须包含且只包含一个 TaskResult JSON（放在 ```json 代码块中）。",
    "- 如果信息不足，请返回 status=\"needs_clarification\" 并在 questions 中列出需要澄清的问题。",
    "",
    "TaskResult JSON schema (example):",
    "```json",
    JSON.stringify(
      {
        taskId: spec.taskId,
        revision: spec.revision,
        status: "submitted",
        summary: "…",
        changedFiles: [],
        howToVerify: [],
        knownRisks: [],
        questions: [],
      },
      null,
      2,
    ),
    "```",
    "",
    "TaskSpec:",
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    noteSection,
  ]
    .filter(Boolean)
    .join("\n");
}

function safeAgentName(orchestrator: HybridOrchestrator, agentId: AgentIdentifier): string {
  const descriptor = orchestrator.listAgents().find((entry) => entry.metadata.id === agentId);
  return descriptor?.metadata.name ?? agentId;
}

function formatVerification(report: Awaited<ReturnType<typeof runVerification>>): string {
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

function buildVerdictPrompt(options: { supervisorName: string; round: number; summaries: Array<{ spec: TaskSpec; result: TaskResult | null; verificationText: string }>; }): string {
  const header = [
    "系统已执行协作任务并自动运行了可用的验证命令，下面是每个任务的结果。",
    `你仍然是主管（${options.supervisorName}）：请基于结果进行验收（accept/reject）。`,
    "要求：",
    "- 你必须输出可机器解析的 SupervisorVerdict JSON（可放在 ```json 代码块中）。",
    "- 每个 taskId 必须给出 accept=true/false 与 note。",
    "- reject 时，note 必须包含：不符合点 + 期望如何改 + 如何验证。",
    "",
    `（协作轮次：${options.round}）`,
  ].join("\n");

  const body = options.summaries
    .map((entry, idx) => {
      const resultJson = entry.result ? JSON.stringify(entry.result, null, 2) : "(no TaskResult parsed)";
      return [
        "---",
        `【任务 ${idx + 1}】taskId=${entry.spec.taskId} agent=${entry.spec.agentId} revision=${entry.spec.revision}`,
        `goal: ${truncate(entry.spec.goal, 240)}`,
        "",
        "TaskResult:",
        "```json",
        truncate(resultJson, 2200),
        "```",
        "",
        "Auto verification:",
        "```",
        truncate(entry.verificationText, 1400),
        "```",
      ].join("\n");
    })
    .join("\n\n");

  const tail = [
    "",
    "请输出 SupervisorVerdict JSON，例如：",
    "```json",
    JSON.stringify(
      {
        verdicts: options.summaries.map((entry) => ({ taskId: entry.spec.taskId, accept: true, note: "ok" })),
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  return [header, body, tail].filter(Boolean).join("\n\n").trim();
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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

export class TaskCoordinator {
  private readonly store: TaskStore;
  private readonly orchestrator: HybridOrchestrator;
  private readonly options: TaskCoordinatorOptions;
  private readonly logger: Logger;
  private readonly perAgentQueue = new Map<string, Promise<void>>();

  constructor(orchestrator: HybridOrchestrator, options: TaskCoordinatorOptions) {
    this.orchestrator = orchestrator;
    this.options = options;
    this.logger = options.logger ?? logger;
    this.store = new TaskStore({
      workspaceRoot: options.workspaceRoot,
      namespace: options.namespace,
      sessionId: options.sessionId,
      dbPath: options.stateDbPath,
    });
  }

  async run(params: { initialSupervisorResult: AgentRunResult; runSupervisor: (input: string) => Promise<AgentRunResult> }): Promise<{ finalResult: AgentRunResult; delegations: DelegationSummaryLike[]; rounds: number }> {
    let result = params.initialSupervisorResult;
    let rounds = 0;
    const allDelegations: DelegationSummaryLike[] = [];
    const reworkQueue: Array<{ spec: TaskSpec; note: string | null }> = [];

    while (rounds < this.options.maxSupervisorRounds) {
      if (this.options.signal?.aborted) {
        const abortError = new Error("用户中断了请求");
        abortError.name = "AbortError";
        throw abortError;
      }

      const directives = extractDelegationDirectives(result.response, this.options.supervisorAgentId);
      const toRun: Array<{ spec: TaskSpec; note: string | null; originalPrompt: string }> = [];
      for (const directive of directives) {
        if (toRun.length >= this.options.maxDelegations) {
          break;
        }
        const parsed = tryParseTaskSpecFromPrompt(directive);
        const spec = parsed ?? buildLegacyTaskSpec(directive);
        toRun.push({ spec, note: null, originalPrompt: directive.prompt });
      }

      while (reworkQueue.length > 0 && toRun.length < this.options.maxDelegations) {
        const next = reworkQueue.shift();
        if (!next) {
          break;
        }
        toRun.push({ spec: next.spec, note: next.note, originalPrompt: next.spec.goal });
      }

      if (toRun.length === 0) {
        break;
      }

      rounds += 1;
      await this.options.hooks?.onSupervisorRound?.(rounds, toRun.length);

      const executed = await runWithConcurrency(toRun, this.options.maxParallelDelegations, async (entry) => {
        const spec = entry.spec;
        const agentId = spec.agentId as AgentIdentifier;
        const agentName = safeAgentName(this.orchestrator, agentId);
        const invokeAgent =
          this.options.invokeAgent ??
          (async (id: AgentIdentifier, inputText: string, opts?: { signal?: AbortSignal }) =>
            await this.orchestrator.invokeAgent(id, inputText, { streaming: false, signal: opts?.signal }));

        if (!this.orchestrator.hasAgent(agentId)) {
          const message = "⚠️ 协作代理未启用或未注册，已跳过。";
          this.store.upsertTask(spec, "FAILED", Date.now(), { lastError: message });
          this.store.appendMessage(spec.taskId, { role: "system", kind: "dispatch", payload: { ok: false, error: message } });
          const summary: DelegationSummaryLike = { agentId, agentName, prompt: entry.originalPrompt, response: message };
          allDelegations.push(summary);
          await this.options.hooks?.onDelegationResult?.(summary);
          return { spec, agentName, result: null as TaskResult | null, verificationText: "(skipped)" };
        }

        return await this.runSerializedForAgent(agentId, async () => {
          await this.options.hooks?.onDelegationStart?.({ agentId, agentName, prompt: entry.originalPrompt });

          const now = Date.now();
          this.store.upsertTask(spec, "ASSIGNED", now, { lastError: null });
          this.store.appendMessage(spec.taskId, { role: "system", kind: "task.created", payload: { agentId, revision: spec.revision } }, now);

          let lastError: string | null = null;
          let parsedResult: TaskResult | null = null;
          let rawResponse = "";

          for (let attempt = 1; attempt <= Math.max(1, this.options.maxTaskAttempts); attempt += 1) {
            this.store.incrementAttempts(spec.taskId);
            this.store.updateStatus(spec.taskId, "IN_PROGRESS", Date.now());
            const { signal, cleanup } = withTimeout(this.options.signal, this.options.taskTimeoutMs);
            try {
              const delegatePrompt = buildDelegatePrompt(spec, entry.note);
              rawResponse = (await invokeAgent(agentId, delegatePrompt, { signal })).response;
              const payload = extractJsonPayload(rawResponse);
              if (!payload) {
                lastError = "missing TaskResult JSON payload";
                this.store.appendMessage(spec.taskId, { role: "agent", kind: "raw", payload: truncate(rawResponse, 4000) });
              } else {
                const json = JSON.parse(payload);
                const validated = TaskResultSchema.safeParse(json);
                if (validated.success) {
                  parsedResult = validated.data;
                  lastError = null;
                  break;
                }
                lastError = "invalid TaskResult schema";
                this.store.appendMessage(spec.taskId, { role: "agent", kind: "raw", payload: truncate(rawResponse, 4000) });
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              lastError = message;
              this.store.appendMessage(spec.taskId, { role: "system", kind: "error", payload: message });
            } finally {
              cleanup();
            }

            if (lastError && attempt < this.options.maxTaskAttempts) {
              await delay(this.options.retryBackoffMs * attempt, this.options.signal);
            }
          }

          if (parsedResult) {
            const status: TaskStatus =
              parsedResult.status === "needs_clarification"
                ? "NEEDS_CLARIFICATION"
                : parsedResult.status === "failed"
                  ? "FAILED"
                  : "SUBMITTED";
            this.store.setResult(spec.taskId, parsedResult, status, Date.now());
          } else {
            const status: TaskStatus = "FAILED";
            this.store.updateStatus(spec.taskId, status, Date.now(), lastError);
          }

          const summary: DelegationSummaryLike = {
            agentId,
            agentName,
            prompt: entry.originalPrompt,
            response: parsedResult ? JSON.stringify(parsedResult, null, 2) : `⚠️ 协作代理调用失败：${lastError ?? "unknown error"}`,
          };
          allDelegations.push(summary);
          await this.options.hooks?.onDelegationResult?.(summary);

          const verificationReport = await runVerification(spec.verification.commands ?? [], {
            cwd: this.options.verificationCwd,
            signal: this.options.signal,
          });
          this.store.setVerification(spec.taskId, verificationReport, Date.now());
          this.store.appendMessage(spec.taskId, { role: "system", kind: "verification", payload: verificationReport });
          const verificationText = formatVerification(verificationReport);

          return { spec, agentName, result: parsedResult, verificationText };
        });
      });

      const verdictPrompt = buildVerdictPrompt({
        supervisorName: this.options.supervisorName,
        round: rounds,
        summaries: executed.map((entry) => ({
          spec: entry.spec,
          result: entry.result,
          verificationText: entry.verificationText,
        })),
      });

      result = await params.runSupervisor(verdictPrompt);

      const verdictPayload = extractJsonPayload(result.response);
      let verdict = verdictPayload ? (() => {
        try {
          return JSON.parse(verdictPayload);
        } catch {
          return null;
        }
      })() : null;

      let parsedVerdict = verdict ? SupervisorVerdictSchema.safeParse(verdict) : null;
      if (!parsedVerdict || !parsedVerdict.success) {
        // One retry: ask supervisor for machine-readable verdict only.
        const retryPrompt = [
          "⚠️ 你的上一条回复未包含可解析的 SupervisorVerdict JSON。",
          "请只输出一个 SupervisorVerdict JSON 对象（可放在 ```json 代码块中），不要输出其它内容。",
          "",
          "再次提醒格式：",
          "```json",
          JSON.stringify(
            {
              verdicts: executed.map((entry) => ({ taskId: entry.spec.taskId, accept: true, note: "ok" })),
            },
            null,
            2,
          ),
          "```",
        ].join("\n");
        result = await params.runSupervisor(retryPrompt);
        const retryPayload = extractJsonPayload(result.response);
        verdict = retryPayload
          ? (() => {
            try {
              return JSON.parse(retryPayload);
            } catch {
              return null;
            }
          })()
          : null;
        parsedVerdict = verdict ? SupervisorVerdictSchema.safeParse(verdict) : null;
      }

      if (!parsedVerdict || !parsedVerdict.success) {
        this.logger.warn("[TaskCoordinator] Supervisor verdict missing/invalid; stopping coordination loop.");
        break;
      }

      for (const item of parsedVerdict.data.verdicts) {
        const taskId = item.taskId;
        const accept = Boolean(item.accept);
        const note = String(item.note ?? "").trim();
        const task = this.store.getTask(taskId);
        if (!task) {
          continue;
        }

        if (accept) {
          this.store.updateStatus(taskId, "ACCEPTED", Date.now(), null);
          this.store.appendMessage(taskId, { role: "supervisor", kind: "verdict", payload: { accept: true, note } });
          this.store.updateStatus(taskId, "DONE", Date.now(), null);
          continue;
        }

        // Reject -> create revision++ and re-dispatch.
        this.store.updateStatus(taskId, "REJECTED", Date.now(), note || null);
        this.store.appendMessage(taskId, { role: "supervisor", kind: "verdict", payload: { accept: false, note } });

        const nextRevision = Math.max(1, task.spec.revision + 1);
        const nextSpec = TaskSpecSchema.parse({
          ...task.spec,
          revision: nextRevision,
        });
        this.store.clearOutputs(taskId);
        this.store.upsertTask(nextSpec, "REWORK", Date.now(), { lastError: note || null });
        reworkQueue.push({ spec: nextSpec, note: note || null });
      }
    }

    return { finalResult: result, delegations: allDelegations, rounds };
  }

  private async runSerializedForAgent<T>(agentId: AgentIdentifier, fn: () => Promise<T>): Promise<T> {
    const key = normalizeAgentKey(agentId);
    const previous = this.perAgentQueue.get(key) ?? Promise.resolve();
    let resolveCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.perAgentQueue.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      resolveCurrent?.();
      if (this.perAgentQueue.get(key) === current) {
        this.perAgentQueue.delete(key);
      }
    }
  }
}
