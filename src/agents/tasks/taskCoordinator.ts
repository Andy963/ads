import type { AgentIdentifier, AgentRunResult } from "../types.js";
import type { HybridOrchestrator } from "../orchestrator.js";

import { createLogger, type Logger } from "../../utils/logger.js";

import { TaskSpecSchema, TaskResultSchema, SupervisorVerdictSchema, extractJsonPayload, type TaskResult, type TaskSpec } from "./schemas.js";
import { TaskStore, type TaskStatus } from "./taskStore.js";
import { runVerification } from "./verificationRunner.js";

const logger = createLogger("TaskCoordinator");

import {
  buildLegacyTaskSpec,
  delay,
  extractDelegationDirectives,
  formatVerification,
  normalizeAgentKey,
  parseBoolean,
  runWithConcurrency,
  safeAgentName,
  truncate,
  tryParseTaskSpecFromPrompt,
  withTimeout,
} from "./taskCoordinator/helpers.js";
import { buildDelegatePrompt, buildVerdictPrompt } from "./taskCoordinator/prompts.js";

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

export function isCoordinatorEnabled(): boolean {
  const enabled = parseBoolean(process.env.ADS_COORDINATOR_ENABLED);
  return enabled !== false;
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

          const verificationReport = await runVerification(spec.verification, {
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
