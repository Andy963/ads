import type { Input, ThreadEvent, ThreadItem, Usage } from "../protocol/types.js";
import type {
  AgentAdapter,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "../types.js";
import type { AgentEvent } from "../../codex/events.js";
import { mapThreadEventToAgentEvent, parseReconnectingMessage } from "../../codex/events.js";
import type { SandboxMode } from "../../telegram/config.js";
import { createLogger } from "../../utils/logger.js";
import { createAbortError } from "../../utils/abort.js";
import {
  CodexAppServerDaemonRegistry,
  getSharedDaemonRegistry,
  type DaemonOptions,
} from "../../codex/appServer/daemonRegistry.js";
import type { CodexAppServerClient } from "../../codex/appServer/rpcClient.js";
import { AsyncLock } from "../../utils/asyncLock.js";
import type { ThreadGoal } from "../../codex/appServer/protocol/v2/ThreadGoal.js";
import type { ThreadGoalStatus } from "../../codex/appServer/protocol/v2/ThreadGoalStatus.js";
import type { ThreadGoalSetParams } from "../../codex/appServer/protocol/v2/ThreadGoalSetParams.js";
import type { ThreadGoalSetResponse } from "../../codex/appServer/protocol/v2/ThreadGoalSetResponse.js";
import type { ThreadGoalGetResponse } from "../../codex/appServer/protocol/v2/ThreadGoalGetResponse.js";
import type { ThreadGoalClearResponse } from "../../codex/appServer/protocol/v2/ThreadGoalClearResponse.js";
import type { ThreadGoalUpdatedNotification } from "../../codex/appServer/protocol/v2/ThreadGoalUpdatedNotification.js";
import {
  createTransientModelRetryEvent,
  runWithTransientModelRetry,
  TransientModelRetryAttemptError,
  type RetryAttemptState,
} from "./transientModelRetry.js";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  readAutoCompactConfig,
  resolveAutoCompactThresholdPercent,
} from "./autoCompactConfig.js";
import {
  createProviderSessionFallbackEvent,
  isMissingProviderSessionError,
} from "./missingProviderSession.js";

const logger = createLogger("CodexAppServerAdapter");

export const CODEX_ADAPTER_ID = "codex";
const DEFAULT_AUTO_COMPACT_TIMEOUT_MS = 120_000;
const COMPACT_INTERRUPT_GRACE_MS = 5_000;

const DEFAULT_METADATA: AgentMetadata = {
  id: CODEX_ADAPTER_ID,
  name: "Codex",
  vendor: "OpenAI",
  description: "Codex daemon over the experimental app-server JSON-RPC protocol",
  capabilities: ["text", "images", "files", "commands"],
};

export interface CodexAppServerAdapterOptions {
  /** Project identifier used by the daemon registry to keep one daemon per project. */
  projectId: string;
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
  resumeThreadId?: string;
  env?: NodeJS.ProcessEnv;
  developerInstructions?: string;
  /** Inject a custom registry (mainly for tests). */
  registry?: CodexAppServerDaemonRegistry;
  metadata?: Partial<AgentMetadata>;
  /** Override the per-turn timeout (ms). 0 disables. */
  turnTimeoutMs?: number;
}

interface UserInputPart {
  type: "text" | "localImage";
  text?: string;
  text_elements?: unknown[];
  path?: string;
}

function inputToUserInput(input: Input): UserInputPart[] {
  const parts: UserInputPart[] = [];
  if (typeof input === "string") {
    if (input.length > 0) {
      parts.push({ type: "text", text: input, text_elements: [] });
    }
    return parts;
  }
  if (!Array.isArray(input)) {
    const str = String(input ?? "");
    if (str) {
      parts.push({ type: "text", text: str, text_elements: [] });
    }
    return parts;
  }
  for (const piece of input) {
    const current = piece as { type?: string; text?: string; path?: string };
    if (current.type === "text" && typeof current.text === "string") {
      parts.push({ type: "text", text: current.text, text_elements: [] });
    } else if (current.type === "local_image" && typeof current.path === "string") {
      parts.push({ type: "localImage", path: current.path });
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "", text_elements: [] });
  }
  return parts;
}

function extractText(part: { text?: string }): string {
  return typeof part.text === "string" ? part.text : "";
}

/**
 * Translate an app-server `ThreadItem` (camelCase) into the snake_case shape
 * expected by `mapThreadEventToAgentEvent` and downstream consumers.
 *
 * Returns `null` for item types we do not yet bridge.
 */
function translateItem(appItem: unknown): ThreadItem | null {
  if (!appItem || typeof appItem !== "object") return null;
  const obj = appItem as Record<string, unknown>;
  const type = obj.type;
  const id = typeof obj.id === "string" ? obj.id : undefined;

  switch (type) {
    case "agentMessage":
      return {
        type: "agent_message",
        id,
        text: typeof obj.text === "string" ? obj.text : "",
      } as ThreadItem;
    case "reasoning": {
      const content = Array.isArray(obj.content) ? obj.content : [];
      const text = content.filter((part): part is string => typeof part === "string").join("\n");
      return { type: "reasoning", id, text } as ThreadItem;
    }
    case "commandExecution":
      return {
        type: "command_execution",
        id,
        command: typeof obj.command === "string" ? obj.command : "",
        status: typeof obj.status === "string" ? obj.status : undefined,
        exit_code: typeof obj.exitCode === "number" ? obj.exitCode : undefined,
        aggregated_output:
          typeof obj.aggregatedOutput === "string" ? obj.aggregatedOutput : undefined,
      } as ThreadItem;
    case "fileChange": {
      const rawChanges = Array.isArray(obj.changes) ? obj.changes : [];
      const changes = rawChanges
        .map((change) => {
          if (!change || typeof change !== "object") return null;
          const c = change as Record<string, unknown>;
          const kind = typeof c.kind === "string" ? c.kind : "modify";
          const pathValue = typeof c.path === "string" ? c.path : "";
          return { kind, path: pathValue };
        })
        .filter((entry): entry is { kind: string; path: string } => entry !== null);
      return { type: "file_change", id, changes } as ThreadItem;
    }
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        type: "tool_call",
        id,
        status: typeof obj.status === "string" ? obj.status : undefined,
        server: typeof obj.server === "string" ? obj.server : undefined,
        tool: typeof obj.tool === "string" ? obj.tool : undefined,
      } as ThreadItem;
    case "webSearch":
      return {
        type: "web_search",
        id,
        status: undefined,
        query: typeof obj.query === "string" ? obj.query : "",
      } as ThreadItem;
    case "plan":
      // No exact equivalent — surface as agent_message so the UI gets the text.
      return {
        type: "agent_message",
        id,
        text: typeof obj.text === "string" ? obj.text : "",
      } as ThreadItem;
    default:
      return null;
  }
}

/**
 * Native provider collaboration can still be enabled by the provider's own
 * configuration. ADS deliberately does not bridge that item, but it must still
 * count as a side effect so a transient error cannot replay a spawned agent.
 */
function markNativeCollaborationAsSideEffect(
  appItem: unknown,
  retryState: RetryAttemptState,
): void {
  if (!appItem || typeof appItem !== "object") return;
  const obj = appItem as Record<string, unknown>;
  if (obj.type !== "collabAgentToolCall") {
    return;
  }
  retryState.markSideEffect({
    type: "tool_call",
    id: typeof obj.id === "string" ? obj.id : undefined,
    tool: "provider-collaboration",
  });
}

interface TurnState {
  responseText: string;
  agentMessageBuffers: Map<string, string>;
  usage: Usage | null;
  threadIdFromStarted: string | null;
  turnId: string | null;
  failed: boolean;
  failureMessage: string | null;
}

interface ContextUsage {
  threadId: string;
  totalTokens: number;
  modelContextWindow: number;
}

/**
 * Adapter that drives the unified persistent `codex app-server` daemon via
 * JSON-RPC.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly preservesThreadOnModelChange = true;
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly projectId: string;
  private readonly registry: CodexAppServerDaemonRegistry;
  private readonly binary?: string;
  private readonly sandboxMode: SandboxMode;
  private workingDirectory?: string;
  private model?: string;
  private modelReasoningEffort?: string;
  private threadId: string | null;
  private developerInstructions?: string;
  private spawnEnv?: NodeJS.ProcessEnv;
  private readonly turnTimeoutMs: number;
  private autoCompactEnabled = true;
  private autoCompactThresholdPercent = DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  private autoCompactTimeoutMs = DEFAULT_AUTO_COMPACT_TIMEOUT_MS;
  private latestContextUsage: ContextUsage | null = null;
  private readonly sendLock = new AsyncLock();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly goalUpdateHandlers = new Set<(goal: ThreadGoal) => void>();
  private readonly goalClearedHandlers = new Set<() => void>();
  private goalSubscriptionsAttached = false;
  private goalSubscriptionCleanup: Array<() => void> = [];

  constructor(options: CodexAppServerAdapterOptions) {
    if (!options.projectId || typeof options.projectId !== "string") {
      throw new Error("CodexAppServerAdapter requires a non-empty projectId");
    }
    this.projectId = options.projectId;
    this.registry = options.registry ?? getSharedDaemonRegistry();
    this.binary = options.binary;
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model;
    this.modelReasoningEffort = options.modelReasoningEffort;
    this.threadId = options.resumeThreadId?.trim() || null;
    this.developerInstructions = options.developerInstructions;
    this.spawnEnv = options.env;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 0;
    this.metadata = {
      ...DEFAULT_METADATA,
      ...options.metadata,
      id: options.metadata?.id ?? DEFAULT_METADATA.id,
      name: options.metadata?.name ?? DEFAULT_METADATA.name,
      vendor: options.metadata?.vendor ?? DEFAULT_METADATA.vendor,
      capabilities: options.metadata?.capabilities ?? DEFAULT_METADATA.capabilities,
    };
    this.id = this.metadata.id;
  }

  status(): AgentStatus {
    return { ready: true, streaming: true };
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  reset(): void {
    this.threadId = null;
    this.latestContextUsage = null;
    this.detachGoalSubscriptions();
  }

  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    if (!options?.preserveSession) {
      this.reset();
    }
    this.detachGoalSubscriptions();
    // Daemon cwd change: drop the existing process so the next send respawns.
    void this.registry.stop(this.projectId).catch((err) => {
      logger.debug(`registry.stop failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  setModel(model?: string): void {
    const normalized = String(model ?? "").trim();
    if (!normalized) {
      if (!this.model) return;
      this.model = undefined;
      return;
    }
    const lower = normalized.toLowerCase();
    if (
      lower.startsWith("claude") ||
      lower === "sonnet" ||
      lower === "opus" ||
      lower === "haiku"
    ) {
      return;
    }
    if (this.model === normalized) return;
    this.model = normalized;
  }

  setModelReasoningEffort(effort?: string): void {
    const normalized = String(effort ?? "").trim();
    const next = normalized || undefined;
    if (this.modelReasoningEffort === next) return;
    this.modelReasoningEffort = next;
  }

  setModelConfig(config?: Record<string, unknown> | null): void {
    const autoCompact = readAutoCompactConfig(config);

    this.autoCompactEnabled = autoCompact.enabled !== false;
    this.autoCompactThresholdPercent = resolveAutoCompactThresholdPercent(
      autoCompact.thresholdPercent,
    );

    const timeoutMs = Number(autoCompact.timeoutMs);
    this.autoCompactTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_AUTO_COMPACT_TIMEOUT_MS;
  }

  setDeveloperInstructions(instructions: string): void {
    this.developerInstructions = instructions || undefined;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  /**
   * Ensure the underlying daemon is running and goal notification handlers are
   * subscribed. Safe to call multiple times.
   */
  private async ensureGoalSubscriptions(): Promise<CodexAppServerClient> {
    const daemonOptions: DaemonOptions = {
      binary: this.binary,
      workingDirectory: this.workingDirectory,
      env: this.spawnEnv,
    };
    const client = await this.registry.getOrStart(this.projectId, daemonOptions);
    if (this.goalSubscriptionsAttached) {
      return client;
    }
    this.goalSubscriptionsAttached = true;

    const off1 = client.onNotification("thread/goal/updated", (params) => {
      const p = params as ThreadGoalUpdatedNotification | undefined;
      const goal = p?.goal;
      if (!goal) return;
      if (this.threadId && goal.threadId && goal.threadId !== this.threadId) return;
      for (const handler of this.goalUpdateHandlers) {
        try {
          handler(goal);
        } catch (err) {
          logger.warn(`goal update handler threw: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    const off2 = client.onNotification("thread/goal/cleared", (params) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (this.threadId && threadId && threadId !== this.threadId) return;
      for (const handler of this.goalClearedHandlers) {
        try {
          handler();
        } catch (err) {
          logger.warn(`goal cleared handler threw: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    const off3 = client.onClose(() => {
      // If the daemon goes away, drop our subscription flag so a future call
      // re-attaches against the fresh client.
      this.goalSubscriptionsAttached = false;
      this.goalSubscriptionCleanup = [];
    });
    this.goalSubscriptionCleanup = [off1, off2, off3];
    return client;
  }

  private detachGoalSubscriptions(): void {
    for (const fn of this.goalSubscriptionCleanup) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.goalSubscriptionCleanup = [];
    this.goalSubscriptionsAttached = false;
  }

  /**
   * Issue `thread/goal/set` against the active thread. Requires a thread to be
   * started — callers should typically run an initial `send()` first.
   */
  async setGoal(opts: {
    objective?: string;
    status?: ThreadGoalStatus;
    tokenBudget?: number | null;
  }): Promise<ThreadGoal> {
    if (!this.threadId) {
      throw new Error("setGoal requires an active thread (call send() first)");
    }
    const client = await this.ensureGoalSubscriptions();
    const params: ThreadGoalSetParams = {
      threadId: this.threadId,
      objective: opts.objective ?? null,
      status: opts.status ?? null,
      tokenBudget: opts.tokenBudget ?? null,
    };
    const response = await client.request<ThreadGoalSetParams, ThreadGoalSetResponse>(
      "thread/goal/set",
      params,
    );
    return response.goal;
  }

  /** Fetch the current goal for the active thread, or null if none is set. */
  async getGoal(): Promise<ThreadGoal | null> {
    if (!this.threadId) {
      throw new Error("getGoal requires an active thread");
    }
    const client = await this.ensureGoalSubscriptions();
    const response = await client.request<{ threadId: string }, ThreadGoalGetResponse>(
      "thread/goal/get",
      { threadId: this.threadId },
    );
    return response.goal ?? null;
  }

  /** Clear the goal on the active thread. No-op if not set; resolves either way. */
  async clearGoal(): Promise<void> {
    if (!this.threadId) {
      throw new Error("clearGoal requires an active thread");
    }
    const client = await this.ensureGoalSubscriptions();
    await client.request<{ threadId: string }, ThreadGoalClearResponse>(
      "thread/goal/clear",
      { threadId: this.threadId },
    );
  }

  onGoalUpdate(handler: (goal: ThreadGoal) => void): () => void {
    this.goalUpdateHandlers.add(handler);
    // Best-effort: attach the live subscription so handlers actually fire.
    void this.ensureGoalSubscriptions().catch((err) => {
      logger.debug(
        `ensureGoalSubscriptions failed in onGoalUpdate: ${err instanceof Error ? err.message : err}`,
      );
    });
    return () => {
      this.goalUpdateHandlers.delete(handler);
    };
  }

  onGoalCleared(handler: () => void): () => void {
    this.goalClearedHandlers.add(handler);
    void this.ensureGoalSubscriptions().catch((err) => {
      logger.debug(
        `ensureGoalSubscriptions failed in onGoalCleared: ${err instanceof Error ? err.message : err}`,
      );
    });
    return () => {
      this.goalClearedHandlers.delete(handler);
    };
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    return await this.sendLock.runExclusive(async () => {
      if (options?.signal?.aborted) {
        throw createAbortError("用户中断了请求");
      }
      return await runWithTransientModelRetry(
        {
          agentName: "Codex app-server",
          signal: options?.signal,
          log: (message) => logger.warn(message),
          onRetry: (notice) => this.emitEvent(createTransientModelRetryEvent(notice)),
        },
        (retryState) => this.sendOnce(input, options, retryState),
      );
    }, options?.signal);
  }

  private async sendOnce(
    input: Input,
    options: AgentSendOptions | undefined,
    retryState: RetryAttemptState,
  ): Promise<AgentRunResult> {
    const userInput = inputToUserInput(input);
    const promptCharCount = userInput
      .filter((p) => p.type === "text")
      .reduce((acc, part) => acc + extractText(part).length, 0);
    if (promptCharCount === 0 && !userInput.some((p) => p.type === "localImage")) {
      throw new Error("Prompt 不能为空");
    }

    const daemonOptions: DaemonOptions = {
      binary: this.binary,
      workingDirectory: this.workingDirectory,
      env: options?.env
        ? { ...this.spawnEnv, ...options.env }
        : this.spawnEnv,
    };
    const client = await this.registry.getOrStart(this.projectId, daemonOptions);
    const savedThreadId = this.threadId;
    let missingThreadRecovered = false;

    const recoverMissingThread = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !savedThreadId ||
        missingThreadRecovered ||
        this.threadId !== savedThreadId ||
        !isMissingProviderSessionError(message)
      ) {
        return false;
      }

      logger.warn(
        `[CodexAppServerAdapter] Thread ${savedThreadId} is missing; auto-starting a new thread. cause=${message}`,
      );
      this.threadId = null;
      this.latestContextUsage = null;
      missingThreadRecovered = true;
      this.emitEvent(
        createProviderSessionFallbackEvent({
          agentName: "Codex app-server",
          previousSessionId: savedThreadId,
          message,
        }),
      );
      return true;
    };

    if (this.threadId) {
      try {
        await this.maybeCompactThread(client, this.threadId, options?.signal);
      } catch (error) {
        if (!recoverMissingThread(error)) {
          throw error;
        }
      }
    }

    const state: TurnState = {
      responseText: "",
      agentMessageBuffers: new Map(),
      usage: null,
      threadIdFromStarted: null,
      turnId: null,
      failed: false,
      failureMessage: null,
    };

    const cleanupFns: Array<() => void> = [];
    const emit = (event: ThreadEvent) => {
      const mapped = mapThreadEventToAgentEvent(event, Date.now());
      if (mapped) {
        this.emitEvent(mapped);
      }
    };

    let turnDone: (value: void) => void;
    let turnFail: (reason: Error) => void;
    const turnPromise = new Promise<void>((resolve, reject) => {
      turnDone = resolve;
      turnFail = reject;
    });

    // The daemon connection is shared by every session of the project, so
    // notifications from other sessions' turns arrive on this client too. A
    // notification belongs to this turn unless both sides know a threadId and
    // they disagree; notifications without one stay visible (daemon-level
    // errors, older daemons that omit the field).
    const belongsToThisTurn = (params: unknown): boolean => {
      const notificationThreadId = extractThreadId(params);
      if (!notificationThreadId) return true;
      const expected = state.threadIdFromStarted ?? this.threadId;
      if (!expected) return true;
      return notificationThreadId === expected;
    };

    cleanupFns.push(
      client.onNotification("thread/started", (params) => {
        const threadId = extractThreadId(params);
        if (!threadId) return;
        // Another session starting a fresh thread must not hijack ours.
        if (this.threadId && threadId !== this.threadId) return;
        state.threadIdFromStarted = threadId;
        emit({ type: "thread.started", thread_id: threadId });
      }),
    );
    cleanupFns.push(
      client.onNotification("turn/started", (params) => {
        if (!belongsToThisTurn(params)) return;
        const turnId = extractTurnId(params);
        if (turnId) {
          state.turnId = turnId;
        }
        emit({ type: "turn.started" });
      }),
    );
    cleanupFns.push(
      client.onNotification("turn/completed", (params) => {
        if (!belongsToThisTurn(params)) return;
        const usage = extractUsageFromTurnPayload(params);
        if (usage) {
          state.usage = usage;
        }
        emit({ type: "turn.completed", usage: usage ?? undefined });
        turnDone();
      }),
    );
    cleanupFns.push(
      client.onNotification("turn/plan/updated", (params) => {
        if (!belongsToThisTurn(params)) return;
        const payload = params as { plan?: unknown };
        const steps = Array.isArray(payload.plan) ? payload.plan : [];
        const items = steps
          .map((step) => {
            if (!step || typeof step !== "object") return null;
            const rec = step as Record<string, unknown>;
            const text = String(rec.step ?? "").trim();
            if (!text) return null;
            const status = String(rec.status ?? "pending").trim().toLowerCase();
            return {
              text,
              status: status === "completed" ? "completed" : status === "inprogress" ? "in_progress" : "pending",
            };
          })
          .filter((item): item is { text: string; status: "pending" | "in_progress" | "completed" } => item !== null);
        if (items.length === 0) return;
        const completed = items.every((item) => item.status === "completed");
        emit({
          type: "item.updated",
          item: { type: "todo_list", id: "codex-turn-plan", status: completed ? "completed" : "in_progress", items },
        });
      }),
    );
    cleanupFns.push(
      client.onNotification("thread/tokenUsage/updated", (params) => {
        if (!belongsToThisTurn(params)) return;
        const usage = extractUsageFromTokenUsage(params);
        if (usage) {
          state.usage = usage;
        }
        const contextUsage = extractContextUsage(params);
        if (contextUsage) {
          this.latestContextUsage = contextUsage;
        }
      }),
    );
    cleanupFns.push(
      client.onNotification("item/started", (params) => {
        if (!belongsToThisTurn(params)) return;
        const item = (params as { item?: unknown }).item;
        const translated = translateItem(item);
        if (translated) {
          retryState.markSideEffect(translated);
          emit({ type: "item.started", item: translated });
        } else {
          markNativeCollaborationAsSideEffect(item, retryState);
        }
      }),
    );
    cleanupFns.push(
      client.onNotification("item/completed", (params) => {
        if (!belongsToThisTurn(params)) return;
        const item = (params as { item?: unknown }).item;
        const translated = translateItem(item);
        if (!translated) {
          markNativeCollaborationAsSideEffect(item, retryState);
          return;
        }
        retryState.markSideEffect(translated);
        if (translated.type === "agent_message" && typeof translated.text === "string") {
          // The completed agent_message carries the canonical final text.
          state.responseText = translated.text;
          if (translated.id) {
            state.agentMessageBuffers.set(translated.id, translated.text);
          }
        }
        emit({ type: "item.completed", item: translated });
      }),
    );
    cleanupFns.push(
      client.onNotification("item/agentMessage/delta", (params) => {
        if (!belongsToThisTurn(params)) return;
        const payload = params as { itemId?: string; delta?: string };
        const itemId = typeof payload.itemId === "string" ? payload.itemId : "__current__";
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const next = (state.agentMessageBuffers.get(itemId) ?? "") + delta;
        state.agentMessageBuffers.set(itemId, next);
        state.responseText = next;
        emit({
          type: "item.updated",
          item: { type: "agent_message", id: itemId, text: next } as ThreadItem,
        });
      }),
    );
    cleanupFns.push(
      client.onNotification("error", (params) => {
        if (!belongsToThisTurn(params)) return;
        const message = extractErrorMessage(params);
        const willRetry = (params as { willRetry?: unknown }).willRetry === true;
        if (willRetry) {
          if (parseReconnectingMessage(message)) {
            emit({ type: "error", message });
          } else {
            this.emitEvent({
              phase: "connection",
              title: "尝试重连",
              detail: message,
              timestamp: Date.now(),
              raw: { type: "error", message },
            });
          }
          return;
        }
        state.failed = true;
        state.failureMessage = message;
        emit({ type: "turn.failed", error: { message } });
        turnFail(new Error(message));
      }),
    );

    const closeUnsub = client.onClose((code) => {
      const message = `codex app-server closed unexpectedly (exit=${code ?? "null"})`;
      state.failed = true;
      state.failureMessage = message;
      turnFail(new Error(message));
    });
    cleanupFns.push(closeUnsub);

    const abortSignal = options?.signal;
    let abortListener: (() => void) | null = null;
    let aborted = false;
    if (abortSignal) {
      abortListener = () => {
        aborted = true;
        const turnId = state.turnId;
        const threadId = state.threadIdFromStarted ?? this.threadId;
        if (turnId && threadId) {
          client
            .request("turn/interrupt", { threadId, turnId })
            .catch((err) =>
              logger.debug(
                `turn/interrupt failed: ${err instanceof Error ? err.message : err}`,
              ),
            );
        }
        turnFail(createAbortError("用户中断了请求"));
      };
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    const startThread = async (): Promise<string> => {
      const startResult = await client.request<Record<string, unknown>, { thread?: { id?: string } }>(
        "thread/start",
        this.buildThreadStartParams(),
        { timeoutMs: this.turnTimeoutMs > 0 ? this.turnTimeoutMs : undefined },
      );
      const newId = startResult?.thread?.id;
      if (typeof newId === "string" && newId.length > 0) {
        this.threadId = newId;
        return newId;
      }
      if (state.threadIdFromStarted) {
        this.threadId = state.threadIdFromStarted;
        return state.threadIdFromStarted;
      }
      throw new Error("codex app-server did not return a thread id");
    };

    const startTurn = async (threadId: string): Promise<void> => {
      await client.request(
        "turn/start",
        this.buildTurnStartParams(threadId, userInput),
        { timeoutMs: this.turnTimeoutMs > 0 ? this.turnTimeoutMs : undefined },
      );
    };

    try {
      let threadId = this.threadId;
      if (!threadId) {
        threadId = await startThread();
      }

      try {
        await startTurn(threadId);
      } catch (error) {
        if (!recoverMissingThread(error)) {
          throw error;
        }

        state.threadIdFromStarted = null;
        state.turnId = null;
        state.failed = false;
        state.failureMessage = null;

        threadId = await startThread();
        await startTurn(threadId);
      }

      await turnPromise;

      if (aborted) {
        throw createAbortError("用户中断了请求");
      }
      if (state.failed) {
        throw new Error(state.failureMessage ?? "codex app-server reported failure");
      }

      return {
        response: state.responseText.trim(),
        usage: state.usage,
        agentId: this.id,
      };
    } finally {
      for (const fn of cleanupFns) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
      }
    }
  }

  private async maybeCompactThread(
    client: CodexAppServerClient,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const usage = this.latestContextUsage;
    if (
      !this.autoCompactEnabled ||
      !usage ||
      usage.threadId !== threadId ||
      usage.modelContextWindow <= 0 ||
      usage.totalTokens / usage.modelContextWindow < this.autoCompactThresholdPercent / 100
    ) {
      return;
    }

    const percent = Math.round((usage.totalTokens / usage.modelContextWindow) * 100);
    this.emitEvent({
      phase: "analysis",
      title: "自动压缩上下文",
      detail: `上下文已使用 ${percent}%，正在压缩后继续`,
      timestamp: Date.now(),
      raw: { type: "turn.started" } as ThreadEvent,
    });

    try {
      await this.compactThread(client, threadId, signal);
      this.latestContextUsage = null;
      this.emitEvent({
        phase: "analysis",
        title: "上下文压缩完成",
        detail: "将继续处理当前请求",
        timestamp: Date.now(),
        raw: { type: "turn.completed" } as ThreadEvent,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientModelRetryAttemptError(
        `automatic context compaction failed: ${message}`,
        { retryable: false, sideEffectObserved: true, cause: error },
      );
    }
  }

  private async compactThread(
    client: CodexAppServerClient,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw createAbortError("用户中断了请求");
    }

    let compactTurnId: string | null = null;
    let settled = false;
    let stopError: Error | null = null;
    let interruptRequested = false;
    let forceStopTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveCompletion: () => void = () => {};
    let rejectCompletion: (error: Error) => void = () => {};
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Prevent unhandled rejection if finish() fires before we await completion.
    completion.catch(() => {});
    const cleanupFns: Array<() => void> = [];

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        rejectCompletion(error);
      } else {
        resolveCompletion();
      }
    };

    const issueInterrupt = () => {
      if (!stopError || !compactTurnId || interruptRequested || settled) return;
      interruptRequested = true;
      client
        .request(
          "turn/interrupt",
          { threadId, turnId: compactTurnId },
          { timeoutMs: COMPACT_INTERRUPT_GRACE_MS },
        )
        .catch((error) =>
          logger.debug(
            `compact turn/interrupt failed: ${error instanceof Error ? error.message : error}`,
          ),
        );
    };

    const requestStop = (error: Error) => {
      if (settled) return;
      stopError ??= error;
      issueInterrupt();
      if (forceStopTimer) return;
      forceStopTimer = setTimeout(() => {
        if (settled) return;
        this.threadId = null;
        this.latestContextUsage = null;
        void this.registry
          .stop(this.projectId)
          .catch((stopFailure) =>
            logger.debug(
              `failed to stop daemon after compact interruption: ${stopFailure instanceof Error ? stopFailure.message : stopFailure}`,
            ),
          )
          .finally(() => finish(stopError ?? error));
      }, COMPACT_INTERRUPT_GRACE_MS);
    };

    cleanupFns.push(
      client.onNotification("turn/started", (params) => {
        if (extractThreadId(params) !== threadId) return;
        compactTurnId = extractTurnId(params);
        issueInterrupt();
      }),
    );
    cleanupFns.push(
      client.onNotification("item/started", (params) => {
        if (extractThreadId(params) !== threadId) return;
        const item = (params as { item?: { type?: unknown } }).item;
        if (item?.type !== "contextCompaction") return;
        const turnId = extractTurnId(params);
        if (turnId) compactTurnId = turnId;
        issueInterrupt();
      }),
    );
    cleanupFns.push(
      client.onNotification("turn/completed", (params) => {
        if (extractThreadId(params) !== threadId) return;
        const turnId = extractTurnId(params);
        if (!compactTurnId || turnId !== compactTurnId) return;
        const status = (params as { turn?: { status?: unknown } }).turn?.status;
        if (stopError) {
          finish(stopError);
        } else if (status === "completed" || status === undefined) {
          finish();
        } else {
          finish(new Error(`compact turn ended with status ${String(status)}`));
        }
      }),
    );
    cleanupFns.push(
      client.onNotification("error", (params) => {
        if (extractThreadId(params) !== threadId) return;
        if ((params as { willRetry?: unknown }).willRetry === true) return;
        finish(stopError ?? new Error(extractErrorMessage(params)));
      }),
    );
    cleanupFns.push(
      client.onClose((code) => {
        finish(
          stopError ??
            new Error(`codex app-server closed during compact (exit=${code ?? "null"})`),
        );
      }),
    );

    const timeout = setTimeout(() => {
      requestStop(new Error(`compact turn timed out after ${this.autoCompactTimeoutMs}ms`));
    }, this.autoCompactTimeoutMs);

    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        requestStop(createAbortError("用户中断了请求"));
      };
      if (!signal.aborted) {
        signal.addEventListener("abort", abortListener, { once: true });
      } else {
        abortListener();
      }
    }

    try {
      if (stopError) {
        await completion;
      }
      const requestOutcome = client
        .request(
          "thread/compact/start",
          { threadId },
          { timeoutMs: this.autoCompactTimeoutMs },
        )
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        );
      const completionOutcome = completion.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      const firstError = await Promise.race([requestOutcome, completionOutcome]);
      if (firstError && !settled) {
        if (isMissingProviderSessionError(firstError.message)) {
          // A missing thread cannot have started a compaction turn, so it is
          // safe to fail immediately and let sendOnce create a fresh thread.
          finish(firstError);
        } else {
          requestStop(firstError);
        }
      }
      await completion;
    } finally {
      clearTimeout(timeout);
      if (forceStopTimer) clearTimeout(forceStopTimer);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      for (const cleanup of cleanupFns) cleanup();
    }
  }

  private buildThreadStartParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    if (this.workingDirectory) params.cwd = this.workingDirectory;
    if (this.model) params.model = this.model;
    if (this.developerInstructions) params.developerInstructions = this.developerInstructions;
    if (this.sandboxMode === "read-only") {
      params.sandbox = "read-only";
    } else if (this.sandboxMode === "danger-full-access") {
      params.sandbox = "danger-full-access";
    } else {
      params.sandbox = "workspace-write";
    }
    return params;
  }

  private buildTurnStartParams(threadId: string, input: UserInputPart[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId,
      input,
    };
    if (this.model) params.model = this.model;
    if (this.modelReasoningEffort) params.effort = this.modelReasoningEffort;
    if (this.workingDirectory) params.cwd = this.workingDirectory;
    return params;
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        logger.warn(`event handler failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

function extractThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const thread = obj.thread;
  if (thread && typeof thread === "object") {
    const id = (thread as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  const direct = obj.threadId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

function extractTurnId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const turn = obj.turn;
  if (turn && typeof turn === "object") {
    const id = (turn as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  const direct = obj.turnId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

function extractUsageFromTurnPayload(params: unknown): Usage | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const usage = obj.usage;
  if (usage && typeof usage === "object") {
    return usage as Usage;
  }
  return null;
}

function extractUsageFromTokenUsage(params: unknown): Usage | null {
  if (!params || typeof params !== "object") return null;
  const obj = params as Record<string, unknown>;
  const tokenUsage = obj.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const last = (tokenUsage as Record<string, unknown>).last;
  if (!last || typeof last !== "object") return null;
  const breakdown = last as Record<string, unknown>;
  const usage: Usage = {};
  let any = false;
  for (const [src, dst] of [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalTokens", "total_tokens"],
  ] as const) {
    const value = breakdown[src];
    if (typeof value === "number") {
      usage[dst] = value;
      any = true;
    }
  }
  return any ? usage : null;
}

function extractContextUsage(params: unknown): ContextUsage | null {
  const threadId = extractThreadId(params);
  if (!threadId || !params || typeof params !== "object") return null;
  const tokenUsage = (params as Record<string, unknown>).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const usage = tokenUsage as Record<string, unknown>;
  const last = usage.last;
  if (!last || typeof last !== "object") return null;
  const totalTokens = (last as Record<string, unknown>).totalTokens;
  const modelContextWindow = usage.modelContextWindow;
  if (
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0 ||
    typeof modelContextWindow !== "number" ||
    !Number.isFinite(modelContextWindow) ||
    modelContextWindow <= 0
  ) {
    return null;
  }
  return { threadId, totalTokens, modelContextWindow };
}

function extractErrorMessage(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "codex app-server reported an error";
  }
  const obj = params as Record<string, unknown>;
  const err = obj.error;
  if (err && typeof err === "object") {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
  return "codex app-server reported an error";
}

export type { CodexAppServerClient };
