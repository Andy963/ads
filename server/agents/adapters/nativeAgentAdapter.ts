import { randomUUID } from "node:crypto";
import { ToolLoopGuard, ToolLoopPausedError } from "../../runtime/toolLoopGuard.js";
import { compactExecution } from "../../runtime/executionCompaction.js";

import type { Input, ThreadEvent, ThreadItem, Usage } from "../protocol/types.js";
import type {
  AgentAdapter,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "../types.js";
import type { AgentEvent } from "../../codex/events.js";
import { mapThreadEventToAgentEvent } from "../../codex/events.js";
import { AsyncLock } from "../../utils/asyncLock.js";
import { createAbortError, isAbortError } from "../../utils/abort.js";
import { createLogger } from "../../utils/logger.js";
import {
  NativeProviderError,
  type NativeChatMessage,
  type NativeChatToolCall,
  type NativeCompletionResult,
} from "../../runtime/openAiCompatibleClient.js";
import { completeNativeModel } from "../../runtime/nativeCompletion.js";
import { getNativeResponsesScope } from "../../runtime/openAiResponsesClient.js";
import {
  createTransientModelRetryEvent,
  isRetryableNativeProviderError,
  runWithTransientModelRetry,
  type RetryAttemptState,
} from "./transientModelRetry.js";
import { createNativeModelResolver, type NativeModelResolver } from "../../runtime/modelResolver.js";
import { NativeImageStore } from "../../runtime/nativeImages.js";
import { projectNativeContinuationTurn } from "../../runtime/nativeContinuation.js";
import {
  NativeContextLimitError,
  estimateNativeRequestTokens,
  formatNativeContextDiagnostic,
  projectNativeContext,
  resolveNativeContextBudget,
  type NativeTokenCalibration,
} from "../../runtime/nativeContextProjection.js";
import { MIN_MODEL_CONTEXT_WINDOW, normalizeModelTokenLimit } from "../../../shared/modelTokenBudget.js";
import {
  NativeCapabilityError,
  resolveNativeProviderCapabilities,
} from "../../runtime/nativeProviderCapabilities.js";
import { getStateDatabase } from "../../state/database.js";
import { DEFAULT_REASONING_EFFORT } from "../../state/modelConfigTypes.js";
import {
  NativeTranscriptStore,
  redactNativeTranscriptText,
  type NativeTranscriptEntry,
  type NativeTranscriptProviderMetadata,
} from "../../state/nativeTranscriptStore.js";
import {
  NATIVE_TOOL_DEFINITIONS,
  NativeToolExecutor,
  type NativeToolExecutionResult,
} from "../../runtime/tools.js";

const logger = createLogger("NativeAgentAdapter");
const NATIVE_ADAPTER_ID = "codex";
const DEFAULT_TURN_TIMEOUT_MS = 0;
const MAX_TURN_TIMEOUT_MS = 1_800_000;

class NativeTurnResetError extends Error {
  constructor() {
    super("Native turn was superseded by a destructive session reset.");
    this.name = "NativeTurnResetError";
  }
}

const DEFAULT_METADATA: AgentMetadata = {
  id: NATIVE_ADAPTER_ID,
  name: "Native Runtime",
  vendor: "OpenAI-compatible",
  description: "In-process OpenAI-compatible agent runtime",
  capabilities: ["text", "files", "commands"],
};

export interface NativeAgentAdapterOptions {
  credentialOwner: string;
  authUserId?: string;
  stateDbPath?: string;
  workspaceRoot: string;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
  resumeThreadId?: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Partial<AgentMetadata>;
  modelResolver?: NativeModelResolver;
  fetchImpl?: typeof fetch;
  turnTimeoutMs?: number;
  /** @deprecated Tool totals no longer terminate execution. */
  maxToolRounds?: number;
  retryBackoffMs?: readonly number[];
  transcriptId?: string;
  transcriptStore?: NativeTranscriptStore;
  transcriptMode?: "restore" | "replace" | "disabled";
}

const SECRET_ENV_NAME = /(?:^|[_-])(?:API[_-]?KEY|AUTH(?:ORIZATION)?(?:[_-]?TOKEN)?|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PEPPER|PRIVATE[_-]?KEY|SECRET|SIGNING[_-]?KEY|TOKEN)(?:$|[_-])/i;

function collectSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_NAME.test(key) && typeof value === "string")
    .map(([, value]) => String(value).trim())
    .filter((value) => value.length > 0);
}

function textFromInput(input: Input): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  return input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function readNonNegativeInteger(value: unknown, fallback: number, max?: number): number {
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

function createCombinedSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(createAbortError("Native runtime request timed out")), timeoutMs)
    : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    cleanup: () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    },
  };
}

function usageFromCompletion(value: NativeCompletionResult["usage"]): Usage | null {
  if (!value) return null;
  return {
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    total_tokens: value.total_tokens,
  };
}

function addUsage(total: Usage | null, round: NativeCompletionResult["usage"]): Usage | null {
  const current = usageFromCompletion(round);
  if (!current) return total;
  const next: Usage = { ...(total ?? {}) };
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    const value = current[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const previous = next[key];
    next[key] = typeof previous === "number" && Number.isFinite(previous) ? previous + value : value;
  }
  return next;
}

function formatToolError(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(apiKey, "[redacted]").slice(0, 4_000);
}

export class NativeAgentAdapter implements AgentAdapter {
  readonly preservesThreadOnModelChange = true;
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly credentialOwner: string;
  private readonly authUserId?: string;
  private readonly workspaceRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolver: NativeModelResolver;
  private readonly fetchImpl?: typeof fetch;
  private readonly sendLock = new AsyncLock();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private loopGuard = new ToolLoopGuard();
  private readonly checkpointCursors = new Map<string, { messages: number; entries: number }>();
  private readonly retryBackoffMs?: readonly number[];
  private readonly turnTimeoutMs: number;
  private readonly secretValues: string[];
  private readonly images: NativeImageStore;
  private conversation: NativeChatMessage[] = [];
  private pendingContinuationTurns = 0;
  private workingDirectory?: string;
  private model?: string;
  private modelReasoningEffort?: string;
  private modelConfig?: Record<string, unknown> | null;
  private developerInstructions?: string;
  private threadId: string;
  private threadStartedEmitted = false;
  private transcriptId?: string;
  private readonly transcriptStore?: NativeTranscriptStore;
  private readonly activeTranscriptTurns = new Set<string>();
  private activeTurnCheckpoint?: {
    turnId: string;
    resetGeneration: number;
    messages: NativeChatMessage[];
    entries: NativeTranscriptEntry[];
    usage: Usage | null;
    provider: NativeTranscriptProviderMetadata;
  };
  private activeTurnAbort?: (reason?: unknown) => void;
  private resetGeneration = 0;
  private readonly transcriptWriterId = randomUUID();
  private nativeTranscriptRestored = false;
  private pendingRetryCheckpoint?: {
    turnId: string;
    resetGeneration: number;
    messages: NativeChatMessage[];
    entries: NativeTranscriptEntry[];
    usage: Usage | null;
    provider: NativeTranscriptProviderMetadata;
  };

  constructor(options: NativeAgentAdapterOptions) {
    this.credentialOwner = String(options.credentialOwner ?? "").trim();
    if (!this.credentialOwner) throw new Error("NativeAgentAdapter requires a credential owner");
    if (options.resumeThreadId?.trim()) {
      throw new Error("NativeAgentAdapter does not accept provider thread resume ids");
    }
    this.workspaceRoot = options.workspaceRoot;
    this.authUserId = options.authUserId;
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.secretValues = collectSecretValues(this.env);
    this.resolver = options.modelResolver ?? createNativeModelResolver({
      owner: this.credentialOwner,
      stateDbPath: options.stateDbPath,
      env: this.env,
    });
    this.fetchImpl = options.fetchImpl;
    this.workingDirectory = options.workingDirectory;
    this.model = String(options.model ?? "").trim() || undefined;
    this.modelReasoningEffort = String(options.modelReasoningEffort ?? "").trim() || undefined;
    // Native execution identity is process-local, independently of its durable
    // transcript. Never resume it using a Codex/app-server thread id.
    this.threadId = `native-${randomUUID()}`;
    this.turnTimeoutMs = readNonNegativeInteger(
      options.turnTimeoutMs ?? this.env.ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS,
      DEFAULT_TURN_TIMEOUT_MS,
      MAX_TURN_TIMEOUT_MS,
    );
    this.retryBackoffMs = options.retryBackoffMs;
    this.transcriptId = String(options.transcriptId ?? "").trim() || undefined;
    const transcriptMode = options.transcriptMode ?? "restore";
    if (options.transcriptStore && !this.transcriptId) {
      throw new Error("NativeAgentAdapter transcriptStore requires transcriptId");
    }
    this.transcriptStore = this.transcriptId && transcriptMode !== "disabled"
      ? options.transcriptStore ?? new NativeTranscriptStore(getStateDatabase(options.stateDbPath), {
          redactions: this.secretValues,
        })
      : undefined;
    this.images = new NativeImageStore(this.workspaceRoot, Boolean(this.transcriptStore));
    if (this.transcriptId && this.transcriptStore) {
      this.transcriptStore.claimTranscript(this.transcriptId, this.transcriptWriterId);
      this.transcriptStore.addRedactions(this.secretValues);
      if (transcriptMode === "replace") {
        this.transcriptStore.clear(this.transcriptId, this.transcriptWriterId);
      } else {
        const restored = this.transcriptStore.loadContinuation(this.transcriptId, this.transcriptWriterId);
        this.nativeTranscriptRestored = restored.messages.length > 0;
        this.conversation = restored.messages;
        this.pendingContinuationTurns = restored.pendingTurns;
        this.loopGuard = new ToolLoopGuard(this.transcriptStore.loadLoopGuard(this.transcriptId));
      }
    }
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
    try {
      const model = this.resolver.resolve(this.model, this.modelConfig);
      const capabilities = resolveNativeProviderCapabilities(model.capabilities);
      return { ready: true, streaming: capabilities.streaming === "supported" };
    } catch (error) {
      return {
        ready: false,
        streaming: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getCapabilities(): AgentMetadata["capabilities"] {
    const model = this.resolver.resolve(this.model, this.modelConfig);
    const capabilities = resolveNativeProviderCapabilities(model.capabilities);
    const supported: AgentMetadata["capabilities"] = ["text"];
    if (capabilities.toolCalls === "supported") {
      supported.push("files", "commands");
    }
    if (capabilities.imageInput === "supported") {
      supported.push("images");
    }
    return supported;
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  reset(options?: { clearPersistedState?: boolean }): void {
    if (options?.clearPersistedState) {
      this.activeTurnAbort?.(createAbortError("Native runtime session reset"));
      this.resetGeneration += 1;
      this.loopGuard = new ToolLoopGuard();
      this.checkpointCursors.clear();
      this.activeTranscriptTurns.clear();
    }
    if (options?.clearPersistedState && this.transcriptId && this.transcriptStore) {
      this.transcriptStore.clear(this.transcriptId, this.transcriptWriterId);
    }
    this.conversation = [];
    this.pendingContinuationTurns = 0;
    this.images.clearMemory();
    this.threadId = `native-${randomUUID()}`;
    this.threadStartedEmitted = false;
    if (options?.clearPersistedState) this.pendingRetryCheckpoint = undefined;
    if (options?.clearPersistedState) this.activeTurnCheckpoint = undefined;
  }

  retargetTranscript(transcriptId: string): void {
    const nextTranscriptId = String(transcriptId ?? "").trim();
    if (!nextTranscriptId) {
      return;
    }
    if (nextTranscriptId === this.transcriptId) {
      this.reset({ clearPersistedState: true });
      return;
    }
    this.activeTurnAbort?.(createAbortError("Native transcript was retargeted"));
    const resetError = new Error("Native transcript was retargeted during an active turn");
    if (this.pendingRetryCheckpoint) {
      this.finalizePendingRetry("interrupted", resetError);
    } else {
      this.finalizeActiveTurn("interrupted", resetError);
    }
    this.transcriptStore?.claimTranscriptAndClear(nextTranscriptId, this.transcriptWriterId);
    this.resetGeneration += 1;
    this.loopGuard = new ToolLoopGuard();
    this.checkpointCursors.clear();
    this.transcriptId = nextTranscriptId;
    this.activeTranscriptTurns.clear();
    this.conversation = [];
    this.pendingContinuationTurns = 0;
    this.images.clearMemory();
    this.threadId = `native-${randomUUID()}`;
    this.threadStartedEmitted = false;
    this.pendingRetryCheckpoint = undefined;
    this.activeTurnAbort = undefined;
  }

  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    if (!options?.preserveSession) this.reset({ clearPersistedState: true });
  }

  setModel(model?: string): void {
    this.model = String(model ?? "").trim() || undefined;
  }

  setModelConfig(config?: Record<string, unknown> | null): void {
    this.modelConfig = config ?? null;
  }

  setModelReasoningEffort(effort?: string): void {
    this.modelReasoningEffort = String(effort ?? "").trim() || undefined;
  }

  setDeveloperInstructions(instructions: string): void {
    this.developerInstructions = String(instructions ?? "").trim() || undefined;
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  hasRestoredTranscript(): boolean {
    return this.nativeTranscriptRestored;
  }

  async send(input: Input, options: AgentSendOptions = {}): Promise<AgentRunResult> {
    if (options.signal?.aborted) throw createAbortError("Native runtime request aborted");
    const turnId = `native-turn-${randomUUID()}`;
    const resetGeneration = this.resetGeneration;
    const turn = createCombinedSignal(options.signal, this.turnTimeoutMs);
    const abortTurn = turn.abort;
    try {
      return await this.sendLock.runExclusive(
        () => {
          this.activeTurnAbort = abortTurn;
          return runWithTransientModelRetry(
            {
              agentName: "native-runtime",
              ...(this.retryBackoffMs ? { backoffMs: this.retryBackoffMs } : {}),
              signal: turn.signal,
              log: (message) => logger.info(message),
              onRetry: (notice) => {
                this.assertTurnActive(resetGeneration, turn.signal);
                this.emitAgentEvent(createTransientModelRetryEvent(notice));
              },
              onRetryAbort: (error) => this.finalizePendingRetry(
                options.signal?.aborted ? "cancelled" : "interrupted",
                error,
              ),
            },
            (retryState) => this.runTurn(input, options, retryState, turnId, turn.signal, resetGeneration),
          ).finally(() => this.images.retain(this.conversation));
        },
        turn.signal,
      );
    } catch (error) {
      if (this.resetGeneration !== resetGeneration) {
        throw new NativeTurnResetError();
      }
      throw error;
    } finally {
      if (this.activeTurnAbort === abortTurn) this.activeTurnAbort = undefined;
      turn.cleanup();
    }
  }

  private emitAgentEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (error) {
        logger.warn(`event handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private finalizePendingRetry(
    status: "cancelled" | "interrupted",
    error: unknown,
  ): void {
    const pending = this.pendingRetryCheckpoint;
    if (!pending) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.checkpointTurn({
      ...pending,
      status,
      errorMessage: normalized.message,
    });
    this.pendingRetryCheckpoint = undefined;
    this.activeTurnCheckpoint = undefined;
    const safeMessage = redactNativeTranscriptText(normalized.message, this.secretValues);
    this.emitRaw({ type: "turn.failed", error: { message: safeMessage } });
  }

  private finalizeActiveTurn(
    status: "cancelled" | "interrupted",
    error: unknown,
  ): void {
    const active = this.activeTurnCheckpoint;
    if (!active) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.checkpointTurn({
      ...active,
      status,
      errorMessage: normalized.message,
    });
    this.activeTurnCheckpoint = undefined;
    const safeMessage = redactNativeTranscriptText(normalized.message, this.secretValues);
    this.emitRaw({ type: "turn.failed", error: { message: safeMessage } });
  }

  private emitRaw(event: ThreadEvent): void {
    const mapped = mapThreadEventToAgentEvent(event, Date.now());
    if (!mapped) return;
    for (const handler of this.listeners) {
      try {
        handler(mapped);
      } catch (error) {
        logger.warn(`event handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private emitResponseSnapshot(
    assertTurnActive: () => void,
    itemId: string,
    text: string,
  ): void {
    assertTurnActive();
    this.emitRaw({
      type: "item.updated",
      item: { type: "agent_message", id: itemId, text },
    });
  }

  private emitToolEvent(
    assertTurnActive: () => void,
    type: "item.started" | "item.updated" | "item.completed",
    item: ThreadItem,
  ): void {
    assertTurnActive();
    this.emitRaw({ type, item });
  }

  private emitToolCompletionEvents(
    assertTurnActive: () => void,
    callId: string,
    result: NativeToolExecutionResult,
  ): void {
    if (result.command) {
      this.emitToolEvent(assertTurnActive, result.command.status === "in_progress" ? "item.updated" : "item.completed", {
        type: "command_execution",
        id: result.command.id,
        command: result.command.command,
        status: result.command.status,
        ...(result.command.exit_code === null || result.command.exit_code === undefined
          ? {}
          : { exit_code: result.command.exit_code }),
        aggregated_output: result.command.aggregated_output,
      });
    }
    if (result.changedFiles && result.changedFiles.length > 0) {
      this.emitToolEvent(assertTurnActive, "item.completed", {
        type: "file_change",
        id: callId,
        changes: result.changedFiles,
      });
    }
  }

  private buildMessages(userMessage: NativeChatMessage): NativeChatMessage[] {
    const messages: NativeChatMessage[] = [];
    if (this.developerInstructions) {
      messages.push({ role: "system", content: this.developerInstructions });
    }
    messages.push(...this.conversation, userMessage);
    return messages;
  }

  private checkpointTurn(input: {
    turnId: string;
    resetGeneration: number;
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
    messages: NativeChatMessage[];
    entries: NativeTranscriptEntry[];
    usage: Usage | null;
    provider: NativeTranscriptProviderMetadata;
    errorMessage?: string | null;
  }): void {
    this.assertResetGeneration(input.resetGeneration);
    if (input.status === "running") {
      this.activeTurnCheckpoint = {
        turnId: input.turnId,
        resetGeneration: input.resetGeneration,
        messages: [...input.messages],
        entries: [...input.entries],
        usage: input.usage,
        provider: input.provider,
      };
    }
    if (this.transcriptId && this.transcriptStore) {
      this.persistTurnCheckpoint(input);
      this.assertResetGeneration(input.resetGeneration);
    }
    if (input.status !== "running") {
      const messages = projectNativeContinuationTurn(input);
      this.conversation.push(...messages);
      this.pendingContinuationTurns = input.status === "completed" ? 0 : this.pendingContinuationTurns + 1;
      this.activeTranscriptTurns.delete(input.turnId);
      this.checkpointCursors.delete(input.turnId);
      if (this.activeTurnCheckpoint?.turnId === input.turnId) this.activeTurnCheckpoint = undefined;
    }
  }

  private persistTurnCheckpoint(input: Parameters<NativeAgentAdapter["checkpointTurn"]>[0]): void {
    const transcriptId = this.transcriptId!;
    const store = this.transcriptStore!;
    if (input.status === "running" && !this.activeTranscriptTurns.has(input.turnId)) {
      store.beginTurn({
        transcriptId,
        turnId: input.turnId,
        messages: input.messages,
        entries: input.entries,
        provider: input.provider,
        writerId: this.transcriptWriterId,
        incremental: true,
      });
      this.assertResetGeneration(input.resetGeneration);
      this.checkpointCursors.set(input.turnId, { messages: input.messages.length, entries: input.entries.length });
      this.activeTranscriptTurns.add(input.turnId);
      return;
    }
    const cursor = this.checkpointCursors.get(input.turnId) ?? { messages: 0, entries: 0 };
    store.appendTurn({
      transcriptId,
      turnId: input.turnId,
      status: input.status,
      messages: input.messages.slice(cursor.messages),
      entries: input.entries.slice(cursor.entries),
      usage: input.usage,
      errorMessage: input.errorMessage,
      writerId: this.transcriptWriterId,
      loopGuard: this.loopGuard.snapshot(),
    });
    this.assertResetGeneration(input.resetGeneration);
    this.checkpointCursors.set(input.turnId, { messages: input.messages.length, entries: input.entries.length });
  }

  private assertResetGeneration(expected: number): void {
    if (expected !== this.resetGeneration) {
      throw new NativeTurnResetError();
    }
  }

  private assertTurnActive(resetGeneration: number, signal: AbortSignal): void {
    this.assertResetGeneration(resetGeneration);
    if (signal.aborted) {
      throw createAbortError("Native runtime request aborted");
    }
  }

  private async runTurn(
    input: Input,
    options: AgentSendOptions,
    retryState: RetryAttemptState,
    turnId: string,
    signal: AbortSignal,
    resetGeneration: number,
  ): Promise<AgentRunResult> {
    try {
      return await this.runTurnInternal(input, options, retryState, turnId, signal, resetGeneration);
    } catch (error) {
      if (this.pendingRetryCheckpoint
        && !isAbortError(error)
        && !(error instanceof NativeProviderError && error.kind === "transient")) {
        try {
          this.finalizePendingRetry("interrupted", error);
        } catch (persistenceError) {
          throw new AggregateError([error, persistenceError], "Native retry setup failed and its checkpoint could not be persisted");
        }
      }
      throw error;
    }
  }

  private async runTurnInternal(
    input: Input,
    options: AgentSendOptions,
    retryState: RetryAttemptState,
    turnId: string,
    signal: AbortSignal,
    resetGeneration: number,
  ): Promise<AgentRunResult> {
    const assertTurnActive = () => this.assertTurnActive(resetGeneration, signal);
    const emitTurnEvent = (event: ThreadEvent) => {
      assertTurnActive();
      this.emitRaw(event);
    };
    assertTurnActive();
    const userText = textFromInput(input);
    const model = this.resolver.resolve(this.model, this.modelConfig);
    const capabilities = resolveNativeProviderCapabilities(model.capabilities);
    const hasImages = (Array.isArray(input) && input.some(part => part.type === "local_image"))
      || this.conversation.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type !== "text"));
    if (hasImages && capabilities.imageInput !== "supported") {
      throw new NativeCapabilityError("imageInput", "select an image-capable model or remove the images");
    }
    const streaming = options.streaming !== false;
    if (!streaming && capabilities.nonStreaming !== "supported") {
      throw new NativeCapabilityError("nonStreaming");
    }
    if (streaming && capabilities.streaming !== "supported") {
      throw new NativeCapabilityError("streaming");
    }
    if (capabilities.toolCalls !== "supported") {
      throw new NativeCapabilityError("toolCalls");
    }
    if (options.outputSchema !== undefined && options.outputSchema !== null && capabilities.structuredOutput !== "supported") {
      throw new NativeCapabilityError("structuredOutput", "configure the provider capability before requesting structured output");
    }
    // An unset effort always resolves to the default so the provider receives an
    // explicit reasoning_effort instead of silently falling back to its own
    // highest setting.
    const requestedReasoningEffort = this.modelReasoningEffort
      ?? model.options?.reasoningEffort
      ?? DEFAULT_REASONING_EFFORT;
    this.transcriptStore?.addRedactions([model.apiKey]);
    const contextBudget = resolveNativeContextBudget({
      contextWindow: model.contextWindow
        ?? normalizeModelTokenLimit(this.env.ADS_NATIVE_CONTEXT_WINDOW, MIN_MODEL_CONTEXT_WINDOW),
      reservedTokens: model.options?.maxTokens
        ?? normalizeModelTokenLimit(this.env.ADS_NATIVE_CONTEXT_RESERVED_TOKENS),
    });
    const requestOptions = {
      ...model.options,
      maxTokens: contextBudget.reservedTokens,
      reasoningEffort: requestedReasoningEffort,
      parallelToolCalls: capabilities.parallelToolCalls === "unsupported" ? false : undefined,
      includeUsage: capabilities.usage === "supported",
    };
    const workingDirectory = this.workingDirectory ?? this.workspaceRoot;
    const userMessage: NativeChatMessage = {
      role: "user",
      content: await this.images.prepare(input, workingDirectory, signal),
    };
    assertTurnActive();
    const toolExecutor = new NativeToolExecutor({
      workspaceRoot: this.workspaceRoot,
      authUserId: this.authUserId,
      readHistory: this.transcriptStore && this.transcriptId
        ? (after, offset) => this.transcriptStore!.readHistory(this.transcriptId!, after, offset) : undefined,
      workingDirectory,
      env: this.env,
      middleware: options.middleware,
      middlewareContext: options.middlewareContext
        ? {
            ...options.middlewareContext,
            prompt: options.middlewareContext.prompt ?? userText,
            workspaceRoot: options.middlewareContext.workspaceRoot ?? this.workspaceRoot,
          }
        : undefined,
      redactions: [model.apiKey, ...this.secretValues],
      signal,
    });

    if (!this.threadStartedEmitted) {
      this.threadStartedEmitted = true;
      emitTurnEvent({ type: "thread.started", thread_id: this.threadId });
    }
    if (retryState.attempt === 1) emitTurnEvent({ type: "turn.started" });

    const responsesScope = model.wireApi === "responses" ? getNativeResponsesScope(model) : undefined;
    let currentMessages = this.buildMessages(userMessage).map(message => {
      if (!message.nativeResponses || message.nativeResponses.scope === responsesScope) return message;
      const { nativeResponses: _context, ...canonical } = message;
      return canonical;
    });
    const turnMessages: NativeChatMessage[] = [userMessage];
    const turnEntries: NativeTranscriptEntry[] = [{ kind: "message", message: userMessage }];
    const providerMetadata: NativeTranscriptProviderMetadata = {
      provider: model.provider,
      model: model.model,
      ...(requestOptions.reasoningEffort ? { reasoningEffort: requestOptions.reasoningEffort } : {}),
    };

    let responseText = "";
    let usage: Usage | null = null;
    // Request-local evidence must not leak across turns, model switches or retries.
    let tokenCalibration: NativeTokenCalibration | undefined;

    try {
      this.checkpointTurn({
        turnId,
        resetGeneration,
        status: "running",
        messages: turnMessages,
        entries: turnEntries,
        usage: null,
        provider: providerMetadata,
      });
      if (retryState.attempt > 1) this.pendingRetryCheckpoint = undefined;
      for (let round = 0; ; round += 1) {
        assertTurnActive();
        const roundTools = NATIVE_TOOL_DEFINITIONS;
        const roundMessages = currentMessages;
        const itemId = `${turnId}-message-${round}`;
        const contextProjection = projectNativeContext(roundMessages, {
          requiredRecentTurns: this.pendingContinuationTurns + 1,
          ...contextBudget,
          tools: roundTools,
          tokenCalibration,
        });
        currentMessages = contextProjection.messages;
        this.conversation = currentMessages.slice(0, Math.max(0, currentMessages.length - turnMessages.length))
          .filter(message => message.role !== "system");
        if (contextProjection.diagnostic.compacted) {
          emitTurnEvent({
            type: "item.completed",
            item: {
              type: "context",
              id: `${turnId}-context-projection`,
              text: formatNativeContextDiagnostic(contextProjection.diagnostic),
            },
          });
        }
        const completion = await completeNativeModel({
          wireApi: model.wireApi,
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          messages: contextProjection.messages,
          tools: roundTools,
          options: requestOptions,
          signal,
          fetchImpl: this.fetchImpl,
          readImage: image => this.images.read(image, signal),
          ...(streaming
            ? {
                onTextDelta: (snapshot: string) => {
                  // Pending exits may invalidate a streamed claim of success. Publish this
                  // response only after deciding whether another wait is required.
                  if (toolExecutor.pendingCommandIds().length === 0) {
                    this.emitResponseSnapshot(assertTurnActive, itemId, snapshot);
                  }
                },
              }
            : {}),
          streaming,
          outputSchema: options.outputSchema,
        });
        const inputTokens = completion.usage?.input_tokens;
        if (inputTokens !== undefined && Number.isSafeInteger(inputTokens) && inputTokens > 0) {
          tokenCalibration = {
            actualInputTokens: inputTokens,
            estimatedInputTokens: estimateNativeRequestTokens(contextProjection.messages, roundTools),
          };
        }
        assertTurnActive();
        if (capabilities.parallelToolCalls !== "supported" && completion.toolCalls.length > 1) {
          throw new NativeCapabilityError(
            "parallelToolCalls",
            `provider returned ${completion.toolCalls.length} calls`,
          );
        }
        usage = addUsage(usage, completion.usage);
        const pendingCommand = toolExecutor.pendingCommandIds()[0];
        if (completion.toolCalls.length === 0 && pendingCommand) {
          // A final answer is not evidence of process completion. Collect the real exit status,
          // then let the model interpret it. Synthetic calls must not reuse provider opaque items.
          completion.text = "";
          completion.nativeResponses = undefined;
          completion.toolCalls = [{
            id: `wait-${randomUUID()}`, type: "function",
            function: { name: "wait_command", arguments: JSON.stringify({ session_id: pendingCommand }) },
          }];
        }
        responseText = (responseText + completion.text).slice(-128_000);
        const assistantMessage: NativeChatMessage = {
          role: "assistant",
          content: completion.text || null,
          ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
          ...(completion.nativeResponses ? { nativeResponses: completion.nativeResponses } : {}),
        };
        if (completion.toolCalls.length === 0) {
          emitTurnEvent({ type: "item.completed", item: { type: "agent_message", id: itemId, text: completion.text } });
          turnMessages.push(assistantMessage);
          turnEntries.push({ kind: "message", message: assistantMessage });
          this.checkpointTurn({
            turnId,
            resetGeneration,
            status: "completed",
            messages: turnMessages,
            entries: turnEntries,
            usage,
            provider: providerMetadata,
          });
          emitTurnEvent({ type: "turn.completed", usage: usage ?? undefined });
          this.pendingRetryCheckpoint = undefined;
          this.loopGuard = new ToolLoopGuard();
          return { response: responseText.trim(), usage, agentId: this.id };
        }

        emitTurnEvent({ type: "item.completed", item: { type: "agent_message", id: itemId, text: completion.text } });
        currentMessages = [...currentMessages, assistantMessage];
        turnMessages.push(assistantMessage);
        turnEntries.push({ kind: "message", message: assistantMessage });
        this.checkpointTurn({
          turnId,
          resetGeneration,
          status: "running",
          messages: turnMessages,
          entries: turnEntries,
          usage,
          provider: providerMetadata,
        });
        let loopPause: string | undefined;
        const loopWarnings: string[] = [];
        for (const call of completion.toolCalls) {
          assertTurnActive();
          if (!loopPause) retryState.markSideEffect({ type: "tool_call", id: call.id, name: call.function.name });
          const result: NativeToolExecutionResult = loopPause
            ? { output: JSON.stringify({ status: "not_executed", reason: "Execution paused by loop detection before this call started." }), failed: true }
            : await this.executeTool(call, toolExecutor, model.apiKey, assertTurnActive);
          assertTurnActive();
          const decision = loopPause ? { action: "allow" as const, reason: undefined } : this.loopGuard.observe({ name: call.function.name, arguments: call.function.arguments,
            result: result.loopResult ?? result.output, failed: result.failed, stateVersion: result.stateVersion, poll: result.poll });
          if (decision.action === "warn") loopWarnings.push(decision.reason!);
          // A warning generated in this batch must reach the model before it can be penalized for ignoring it.
          if (decision.action === "pause" && loopWarnings.length === 0) loopPause = decision.reason;
          const toolMessage: NativeChatMessage = { role: "tool", content: result.output, tool_call_id: call.id };
          currentMessages.push(toolMessage);
          turnMessages.push(toolMessage);
          if (result.command && result.command.status !== "in_progress") {
            turnEntries.push({
              kind: "command",
              toolCallId: result.command.id,
              command: result.command.command,
              status: result.command.status === "failed" ? "failed" : "completed",
              ...(typeof result.command.exit_code === "number" ? { exitCode: result.command.exit_code } : {}),
              ...(result.command.aggregated_output ? { output: result.command.aggregated_output } : {}),
            });
          }
          if (result.changedFiles && result.changedFiles.length > 0) {
            turnEntries.push({
              kind: "file_change",
              toolCallId: call.id,
              changes: result.changedFiles.map((change) => ({ ...change })),
            });
          }
          turnEntries.push({ kind: "message", message: toolMessage });
          this.checkpointTurn({
            turnId,
            resetGeneration,
            status: "running",
            messages: turnMessages,
            entries: turnEntries,
            usage,
            provider: providerMetadata,
          });
          this.emitToolCompletionEvents(assertTurnActive, call.id, result);
          assertTurnActive();
        }
        if (loopPause) throw new ToolLoopPausedError(loopPause);
        if (loopWarnings.length) {
          const warning: NativeChatMessage = { role: "assistant", content: `[Runtime warning] ${loopWarnings.join(" ")}` };
          currentMessages.push(warning);
          turnMessages.push(warning);
          turnEntries.push({ kind: "message", message: warning });
          emitTurnEvent({ type: "item.completed", item: { type: "context", id: `${turnId}-loop-${round}`, text: warning.content as string } });
        }
        const compacted = await compactExecution({
          messages: turnMessages, budget: { ...contextBudget, tools: roundTools, tokenCalibration },
          historyHint: this.transcriptStore ? "Earlier evidence is available through read_execution_history from after=0, offset=0. Never replay tools to recover history." : "Durable history is unavailable; verify state before repeating an operation.",
          summarize: async messages => {
            const summary = await completeNativeModel({
              wireApi: model.wireApi, baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.model,
              messages, tools: [], options: { ...requestOptions, maxTokens: Math.min(4096, contextBudget.reservedTokens) },
              signal, fetchImpl: this.fetchImpl, streaming: capabilities.nonStreaming !== "supported",
              readImage: image => this.images.read(image, signal),
            });
            usage = addUsage(usage, summary.usage);
            assertTurnActive();
            return summary;
          },
        });
        // Save the last warning before replacing the projection, then release old in-memory evidence.
        this.checkpointTurn({ turnId, resetGeneration, status: "running", messages: turnMessages,
          entries: turnEntries, usage, provider: providerMetadata });
        if (compacted) {
          this.transcriptStore?.saveProjection(this.transcriptId!, turnId, this.transcriptWriterId, compacted);
          const precedingMessages = currentMessages.slice(0, currentMessages.length - turnMessages.length);
          turnMessages.splice(0, turnMessages.length, ...compacted);
          currentMessages = [...precedingMessages, ...compacted];
          turnEntries.length = 0;
          this.checkpointCursors.set(turnId, { messages: turnMessages.length, entries: 0 });
          this.checkpointTurn({ turnId, resetGeneration, status: "running", messages: turnMessages,
            entries: turnEntries, usage, provider: providerMetadata });
          emitTurnEvent({ type: "item.completed", item: { type: "context", id: `${turnId}-compact-${round}`, text: this.transcriptStore ? "Execution context summarized; completed tool evidence was preserved without replay." : "Execution context summarized in memory; this session has no durable history." } });
        }
      }
    } catch (error) {
      if (this.resetGeneration !== resetGeneration) {
        throw new NativeTurnResetError();
      }
      if (error instanceof NativeTurnResetError) {
        throw error;
      }
      const normalized = isAbortError(error) || signal.aborted
        ? createAbortError("Native runtime request aborted")
        : error instanceof Error
          ? error
          : new Error(String(error));
      const retryableProviderFailure = isRetryableNativeProviderError(error)
        && !signal.aborted
        && !isAbortError(error)
        && !retryState.sideEffectObserved
        && !retryState.isFinalAttempt;
      if (retryableProviderFailure) {
        this.pendingRetryCheckpoint = {
          turnId,
          resetGeneration,
          messages: [...turnMessages],
          entries: [...turnEntries],
          usage,
          provider: providerMetadata,
        };
        throw normalized;
      }
      const status = options.signal?.aborted
        ? "cancelled"
        : isAbortError(normalized) || normalized instanceof ToolLoopPausedError || normalized instanceof NativeContextLimitError
          ? "interrupted"
          : "failed";
      let persistenceError: unknown;
      try {
        this.checkpointTurn({
          turnId,
          resetGeneration,
          status,
          messages: turnMessages,
          entries: turnEntries,
          usage,
          provider: providerMetadata,
          errorMessage: normalized.message,
        });
      } catch (error) {
        persistenceError = error;
      }
      const safeMessage = redactNativeTranscriptText(
        formatToolError(normalized, model.apiKey),
        [model.apiKey, ...this.secretValues].filter((value) => value.length > 0),
      );
      this.emitRaw({ type: "turn.failed", error: { message: safeMessage } });
      if (persistenceError) {
        throw new AggregateError(
          [normalized, persistenceError],
          "Native turn failed and its transcript could not be persisted",
        );
      }
      this.pendingRetryCheckpoint = undefined;
      throw normalized;
    } finally {
      // Includes provider failure, cancellation, destructive reset and superseded writers.
      // Restored transcripts contain evidence, never live/replayable process handles.
      await toolExecutor.dispose();
    }
  }

  private async executeTool(
    call: NativeChatToolCall,
    executor: NativeToolExecutor,
    apiKey: string,
    assertTurnActive: () => void,
  ): Promise<NativeToolExecutionResult> {
    // Internal tool invocations never become raw tool_call items: those were
    // intercepted by ActivityTracker and leaked low-level `- **Tool**` bullets
    // into the chat. Structured command and file-change artifacts carry the
    // user-facing execution story.
    let command: NativeToolExecutionResult["command"];
    if (call.function.name === "exec_command") {
      try {
        const parsed = JSON.parse(call.function.arguments) as { cmd?: unknown; args?: unknown };
        const commandName = String(parsed.cmd ?? "").trim();
        const args = Array.isArray(parsed.args) ? parsed.args.map((value) => String(value)) : [];
        command = {
          id: call.id,
          command: [commandName, ...args].join(" ").trim(),
          status: "in_progress",
        };
        this.emitToolEvent(assertTurnActive, "item.started", {
          type: "command_execution",
          id: call.id,
          command: command.command,
          status: "in_progress",
        });
        assertTurnActive();
      } catch {
        command = undefined;
      }
    }

    assertTurnActive();
    let result: NativeToolExecutionResult;
    try {
      result = await executor.execute(call);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = formatToolError(error, apiKey);
      result = {
        output: JSON.stringify({ error: message }),
        failed: true,
        ...(call.function.name === "read_file" ? { stateVersion: "read-unavailable" } : {}),
        command: command
          ? { ...command, status: "failed", aggregated_output: message }
          : undefined,
      };
    }

    return result;
  }
}
