import { randomUUID } from "node:crypto";

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
  completeNativeChat,
  type NativeChatMessage,
  type NativeChatToolCall,
  type NativeCompletionResult,
} from "../../runtime/openAiCompatibleClient.js";
import { createNativeModelResolver, type NativeModelResolver } from "../../runtime/modelResolver.js";
import { getStateDatabase } from "../../state/database.js";
import {
  NativeTranscriptStore,
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
const MAX_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOOL_ROUNDS = 0;
const TOOL_ROUND_LIMIT_MESSAGE =
  "Native runtime reached the configured tool-round limit. The completed tool results are available above; continue with the next prompt if you want to proceed.";

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
  maxToolRounds?: number;
  transcriptId?: string;
  transcriptStore?: NativeTranscriptStore;
  transcriptMode?: "restore" | "replace" | "disabled";
}

const SECRET_ENV_NAME = /(?:API[_-]?KEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|PEPPER|PRIVATE[_-]?KEY|SECRET|SIGNING[_-]?KEY|TOKEN)/i;

function collectSecretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_NAME.test(key) && typeof value === "string")
    .map(([, value]) => String(value).trim())
    .filter((value) => value.length > 0);
}

function textFromInput(input: Input): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");
  const localImage = input.find((part) => part.type === "local_image");
  if (localImage) throw new Error("Native runtime does not support local image input yet");
  return input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function readNonNegativeInteger(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

function createCombinedSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
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
  private readonly workspaceRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolver: NativeModelResolver;
  private readonly fetchImpl?: typeof fetch;
  private readonly sendLock = new AsyncLock();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly maxToolRounds: number;
  private readonly turnTimeoutMs: number;
  private readonly secretValues: string[];
  private conversation: NativeChatMessage[] = [];
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
  private resetGeneration = 0;
  private readonly transcriptWriterId = randomUUID();

  constructor(options: NativeAgentAdapterOptions) {
    this.credentialOwner = String(options.credentialOwner ?? "").trim();
    if (!this.credentialOwner) throw new Error("NativeAgentAdapter requires a credential owner");
    if (options.resumeThreadId?.trim()) {
      throw new Error("NativeAgentAdapter does not accept provider thread resume ids");
    }
    this.workspaceRoot = options.workspaceRoot;
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
    // Native conversation state is intentionally process-local in phase one.
    // Never treat a persisted Codex/app-server id as a native resumable thread.
    this.threadId = `native-${randomUUID()}`;
    this.turnTimeoutMs = readNonNegativeInteger(
      options.turnTimeoutMs ?? this.env.ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS,
      DEFAULT_TURN_TIMEOUT_MS,
      MAX_TURN_TIMEOUT_MS,
    );
    this.maxToolRounds = readNonNegativeInteger(
      options.maxToolRounds
        ?? this.env.ADS_AGENT_MAX_TOOL_ROUNDS
        ?? this.env.ADS_NATIVE_RUNTIME_MAX_TOOL_ROUNDS,
      DEFAULT_MAX_TOOL_ROUNDS,
    );
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
    if (this.transcriptId && this.transcriptStore) {
      this.transcriptStore.claimTranscript(this.transcriptId, this.transcriptWriterId);
      this.transcriptStore.addRedactions(this.secretValues);
      if (transcriptMode === "replace") {
        this.transcriptStore.clear(this.transcriptId);
      } else {
        this.appendConversation(this.transcriptStore.loadCompletedMessages(this.transcriptId));
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
      this.resolver.resolve(this.model, this.modelConfig);
      return { ready: true, streaming: true };
    } catch (error) {
      return {
        ready: false,
        streaming: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  reset(options?: { clearPersistedState?: boolean }): void {
    if (options?.clearPersistedState) {
      this.resetGeneration += 1;
      this.activeTranscriptTurns.clear();
    }
    if (options?.clearPersistedState && this.transcriptId && this.transcriptStore) {
      this.transcriptStore.clear(this.transcriptId);
    }
    this.conversation = [];
    this.threadId = `native-${randomUUID()}`;
    this.threadStartedEmitted = false;
  }

  retargetTranscript(transcriptId: string): void {
    const nextTranscriptId = String(transcriptId ?? "").trim();
    if (!nextTranscriptId || nextTranscriptId === this.transcriptId) {
      return;
    }
    this.transcriptId = nextTranscriptId;
    this.activeTranscriptTurns.clear();
    this.conversation = [];
    this.threadId = `native-${randomUUID()}`;
    this.threadStartedEmitted = false;
    this.transcriptStore?.clear(nextTranscriptId);
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

  async send(input: Input, options: AgentSendOptions = {}): Promise<AgentRunResult> {
    return await this.sendLock.runExclusive(() => this.runTurn(input, options), options.signal);
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

  private emitResponseSnapshot(itemId: string, text: string): void {
    this.emitRaw({
      type: "item.updated",
      item: { type: "agent_message", id: itemId, text },
    });
  }

  private emitToolEvent(type: "item.started" | "item.completed", item: ThreadItem): void {
    this.emitRaw({ type, item });
  }

  private buildMessages(userText: string): NativeChatMessage[] {
    const messages: NativeChatMessage[] = [];
    if (this.developerInstructions) {
      messages.push({ role: "system", content: this.developerInstructions });
    }
    messages.push(...this.conversation, { role: "user", content: userText });
    return messages;
  }

  private appendConversation(messages: NativeChatMessage[]): void {
    this.conversation.push(...messages);
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
    if (!this.transcriptId || !this.transcriptStore) return;
    if (input.status === "running" && !this.activeTranscriptTurns.has(input.turnId)) {
      this.transcriptStore.beginTurn({
        transcriptId: this.transcriptId,
        turnId: input.turnId,
        messages: input.messages,
        entries: input.entries,
        provider: input.provider,
        writerId: this.transcriptWriterId,
      });
      this.activeTranscriptTurns.add(input.turnId);
      return;
    }
    this.transcriptStore.updateTurn({
      transcriptId: this.transcriptId,
      turnId: input.turnId,
      status: input.status,
      messages: input.messages,
      entries: input.entries,
      usage: input.usage,
      errorMessage: input.errorMessage,
      writerId: this.transcriptWriterId,
    });
    if (input.status !== "running") {
      this.activeTranscriptTurns.delete(input.turnId);
    }
  }

  private assertResetGeneration(expected: number): void {
    if (expected !== this.resetGeneration) {
      throw new NativeTurnResetError();
    }
  }

  private async runTurn(input: Input, options: AgentSendOptions): Promise<AgentRunResult> {
    const userText = textFromInput(input);
    const model = this.resolver.resolve(this.model, this.modelConfig);
    this.transcriptStore?.addRedactions([model.apiKey]);
    const requestOptions = {
      ...model.options,
      supportsReasoningEffort: model.supportsReasoningEffort === true,
      reasoningEffort: model.supportsReasoningEffort === true
        ? this.modelReasoningEffort ?? model.options?.reasoningEffort
        : undefined,
    };
    const combined = createCombinedSignal(options.signal, this.turnTimeoutMs);
    const resetGeneration = this.resetGeneration;
    const turnId = `native-turn-${randomUUID()}`;
    const userMessage: NativeChatMessage = { role: "user", content: userText };
    const workingDirectory = this.workingDirectory ?? this.workspaceRoot;
    const toolExecutor = new NativeToolExecutor({
      workspaceRoot: this.workspaceRoot,
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
      signal: combined.signal,
    });

    if (!this.threadStartedEmitted) {
      this.threadStartedEmitted = true;
      this.emitRaw({ type: "thread.started", thread_id: this.threadId });
    }
    this.emitRaw({ type: "turn.started" });

    let currentMessages = this.buildMessages(userText);
    const turnMessages: NativeChatMessage[] = [userMessage];
    const turnEntries: NativeTranscriptEntry[] = [{ kind: "message", message: userMessage }];
    const providerMetadata: NativeTranscriptProviderMetadata = {
      provider: model.provider,
      model: model.model,
      ...(requestOptions.reasoningEffort ? { reasoningEffort: requestOptions.reasoningEffort } : {}),
    };

    let responseText = "";
    let usage: Usage | null = null;

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
      for (let round = 0; this.maxToolRounds === 0 || round < this.maxToolRounds; round += 1) {
        const itemId = `${turnId}-message-${round}`;
        let roundText = "";
        const completion = await completeNativeChat({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          messages: currentMessages,
          tools: NATIVE_TOOL_DEFINITIONS,
          options: requestOptions,
          signal: combined.signal,
          fetchImpl: this.fetchImpl,
          onTextDelta: (snapshot) => {
            roundText = snapshot;
            this.emitResponseSnapshot(itemId, roundText);
          },
        });
        usage = addUsage(usage, completion.usage);
        responseText += completion.text;
        const assistantMessage: NativeChatMessage = {
          role: "assistant",
          content: completion.text || null,
          ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
        };
        if (completion.toolCalls.length === 0) {
          this.emitRaw({ type: "item.completed", item: { type: "agent_message", id: itemId, text: completion.text } });
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
          this.appendConversation(turnMessages);
          this.emitRaw({ type: "turn.completed", usage: usage ?? undefined });
          return { response: responseText.trim(), usage, agentId: this.id };
        }

        this.emitRaw({ type: "item.completed", item: { type: "agent_message", id: itemId, text: completion.text } });
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
        for (const call of completion.toolCalls) {
          const result = await this.executeTool(call, toolExecutor, model.apiKey);
          const toolMessage: NativeChatMessage = { role: "tool", content: result.output, tool_call_id: call.id };
          currentMessages.push(toolMessage);
          turnMessages.push(toolMessage);
          if (result.command) {
            turnEntries.push({
              kind: "command",
              toolCallId: call.id,
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
        }

        if (this.maxToolRounds > 0 && round + 1 >= this.maxToolRounds) {
          const limitItemId = `${turnId}-tool-limit`;
          const limitText = responseText.trim()
            ? `${responseText.trim()}\n\n${TOOL_ROUND_LIMIT_MESSAGE}`
            : TOOL_ROUND_LIMIT_MESSAGE;
          this.emitRaw({
            type: "item.completed",
            item: { type: "agent_message", id: limitItemId, text: TOOL_ROUND_LIMIT_MESSAGE },
          });
          this.checkpointTurn({
            turnId,
            resetGeneration,
            status: "completed",
            messages: turnMessages,
            entries: turnEntries,
            usage,
            provider: providerMetadata,
          });
          this.appendConversation([...turnMessages]);
          this.emitRaw({ type: "turn.completed", usage: usage ?? undefined });
          return { response: limitText, usage, agentId: this.id };
        }
      }
    } catch (error) {
      if (error instanceof NativeTurnResetError) {
        this.emitRaw({ type: "turn.failed", error: { message: error.message } });
        throw error;
      }
      const normalized = isAbortError(error) || combined.signal.aborted
        ? createAbortError("Native runtime request aborted")
        : error instanceof Error
          ? error
          : new Error(String(error));
      const status = options.signal?.aborted
        ? "cancelled"
        : isAbortError(normalized)
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
      const safeMessage = [model.apiKey, ...this.secretValues]
        .filter((value) => value.length > 0)
        .reduce((message, secret) => message.replaceAll(secret, "[redacted]"), formatToolError(normalized, model.apiKey));
      this.emitRaw({ type: "turn.failed", error: { message: safeMessage } });
      if (persistenceError) {
        throw new AggregateError(
          [normalized, persistenceError],
          "Native turn failed and its transcript could not be persisted",
        );
      }
      throw normalized;
    } finally {
      combined.cleanup();
    }
    throw new Error("Native runtime turn ended without a result");
  }

  private async executeTool(
    call: NativeChatToolCall,
    executor: NativeToolExecutor,
    apiKey: string,
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
        this.emitToolEvent("item.started", {
          type: "command_execution",
          id: call.id,
          command: command.command,
          status: "in_progress",
        });
      } catch {
        command = undefined;
      }
    }

    let result: NativeToolExecutionResult;
    try {
      result = await executor.execute(call);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = formatToolError(error, apiKey);
      result = {
        output: JSON.stringify({ error: message }),
        failed: true,
        command: command
          ? { ...command, status: "failed", aggregated_output: message }
          : undefined,
      };
    }

    if (result.command) {
      this.emitToolEvent("item.completed", {
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
      this.emitToolEvent("item.completed", {
        type: "file_change",
        id: call.id,
        changes: result.changedFiles,
      });
    }
    return result;
  }
}
