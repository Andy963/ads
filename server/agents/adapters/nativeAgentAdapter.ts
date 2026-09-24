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
const MAX_CONVERSATION_MESSAGES = 200;
const TOOL_ROUND_LIMIT_MESSAGE =
  "Native runtime reached the configured tool-round limit. The completed tool results are available above; continue with the next prompt if you want to proceed.";

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
  private conversation: NativeChatMessage[] = [];
  private workingDirectory?: string;
  private model?: string;
  private modelReasoningEffort?: string;
  private modelConfig?: Record<string, unknown> | null;
  private developerInstructions?: string;
  private threadId: string;
  private threadStartedEmitted = false;

  constructor(options: NativeAgentAdapterOptions) {
    this.credentialOwner = String(options.credentialOwner ?? "").trim();
    if (!this.credentialOwner) throw new Error("NativeAgentAdapter requires a credential owner");
    this.workspaceRoot = options.workspaceRoot;
    this.env = { ...process.env, ...(options.env ?? {}) };
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

  reset(): void {
    this.conversation = [];
    this.threadId = `native-${randomUUID()}`;
    this.threadStartedEmitted = false;
  }

  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    if (!options?.preserveSession) this.reset();
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
    if (this.conversation.length > MAX_CONVERSATION_MESSAGES) {
      this.conversation = this.conversation.slice(-MAX_CONVERSATION_MESSAGES);
    }
  }

  private async runTurn(input: Input, options: AgentSendOptions): Promise<AgentRunResult> {
    const userText = textFromInput(input);
    const model = this.resolver.resolve(this.model, this.modelConfig);
    const requestOptions = {
      ...model.options,
      supportsReasoningEffort: model.supportsReasoningEffort === true,
      reasoningEffort: model.supportsReasoningEffort === true
        ? this.modelReasoningEffort ?? model.options?.reasoningEffort
        : undefined,
    };
    const combined = createCombinedSignal(options.signal, this.turnTimeoutMs);
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
      redactions: [model.apiKey],
      signal: combined.signal,
    });

    if (!this.threadStartedEmitted) {
      this.threadStartedEmitted = true;
      this.emitRaw({ type: "thread.started", thread_id: this.threadId });
    }
    this.emitRaw({ type: "turn.started" });

    let currentMessages = this.buildMessages(userText);
    const turnMessages: NativeChatMessage[] = [userMessage];
    let responseText = "";
    let usage: Usage | null = null;

    try {
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
          this.appendConversation([...turnMessages, assistantMessage]);
          this.emitRaw({ type: "turn.completed", usage: usage ?? undefined });
          return { response: responseText.trim(), usage, agentId: this.id };
        }

        this.emitRaw({ type: "item.completed", item: { type: "agent_message", id: itemId, text: completion.text } });
        currentMessages = [...currentMessages, assistantMessage];
        turnMessages.push(assistantMessage);
        for (const call of completion.toolCalls) {
          const result = await this.executeTool(call, toolExecutor, model.apiKey);
          currentMessages.push({ role: "tool", content: result.output, tool_call_id: call.id });
          turnMessages.push({ role: "tool", content: result.output, tool_call_id: call.id });
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
          this.appendConversation([...turnMessages]);
          this.emitRaw({ type: "turn.completed", usage: usage ?? undefined });
          return { response: limitText, usage, agentId: this.id };
        }
      }
    } catch (error) {
      const normalized = isAbortError(error) || combined.signal.aborted
        ? createAbortError("Native runtime request aborted")
        : error instanceof Error
          ? error
          : new Error(String(error));
      this.emitRaw({ type: "turn.failed", error: { message: formatToolError(normalized, model.apiKey) } });
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
