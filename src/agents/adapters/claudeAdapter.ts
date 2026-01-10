import type { Input, Usage } from "@openai/codex-sdk";
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  OutputFormat,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";
import type { ClaudeAgentConfig } from "../config.js";
import type { AgentEvent } from "../../codex/events.js";

type CodexInputPart = Exclude<Input, string>[number];

const DEFAULT_METADATA: AgentMetadata = {
  id: "claude",
  name: "Claude",
  vendor: "Anthropic",
  capabilities: ["text"],
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Claude assisting the ADS automation platform as a supporting agent.",
  "Always respond with actionable plans, diffs, or insights.",
  "",
  "Tooling:",
  "- You can invoke host tools via ADS tool blocks (the system will execute them and return results):",
  "  <<<tool.read / tool.write / tool.apply_patch / tool.exec / tool.grep / tool.find / tool.search / tool.vsearch>>>",
  "- Prefer ADS tool blocks over Claude Code built-in tools.",
].join("\n");

const DEFAULT_STREAM_THROTTLE_MS = 200;
const STREAM_STATUS_TITLE = "生成回复";

type AssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type AssistantTextBlock = Extract<AssistantContentBlock, { type: "text" }>;

function parseStreamingEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function parseThrottleMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function mapUsage(result: SDKResultMessage): Usage | null {
  if (!result.usage) {
    return null;
  }
  return {
    input_tokens: result.usage.input_tokens ?? 0,
    cached_input_tokens: result.usage.cache_read_input_tokens ?? 0,
    output_tokens: result.usage.output_tokens ?? 0,
  };
}

function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === "assistant";
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
}

function isSystemInitMessage(message: SDKMessage): message is SDKSystemMessage {
  return message.type === "system" && message.subtype === "init";
}

function extractTextDelta(message: SDKMessage): string | null {
  if (message.type !== "stream_event") {
    return null;
  }
  const raw = message.event as { type?: string; delta?: { type?: string; text?: string } };
  if (raw.type === "content_block_delta" && raw.delta?.type === "text_delta") {
    const text = raw.delta.text;
    return typeof text === "string" && text.length > 0 ? text : null;
  }
  return null;
}

function normalizeInput(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  return (input as CodexInputPart[])
    .map((part) => {
      const current = part as { type?: string; text?: string; path?: string };
      if (current.type === "text" && typeof current.text === "string") {
        return current.text;
      }
      if (current.type === "local_image") {
        return `[image:${current.path ?? "blob"}]`;
      }
      if (current.type === "local_file") {
        return `[file:${current.path ?? "blob"}]`;
      }
      return current.type ? `[${current.type}]` : "[content]";
    })
    .join("\n\n");
}

export interface ClaudeAgentAdapterOptions {
  config: ClaudeAgentConfig;
  systemPrompt?: string;
  resumeSessionId?: string;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly config: ClaudeAgentConfig;
  private readonly systemPrompt: string;
  private workingDirectory?: string;
  private model?: string;
  private readonly streamingEnabled: boolean;
  private readonly streamThrottleMs: number;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private sessionId?: string;
  private resumeSessionId?: string;

  constructor(options: ClaudeAgentAdapterOptions) {
    this.config = options.config;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.metadata = { ...DEFAULT_METADATA, defaultModel: this.config.model };
    this.id = this.metadata.id;
    this.streamingEnabled = parseStreamingEnabled(process.env.ADS_CLAUDE_STREAMING);
    this.streamThrottleMs = parseThrottleMs(
      process.env.ADS_CLAUDE_STREAM_THROTTLE_MS,
      DEFAULT_STREAM_THROTTLE_MS,
    );
    this.resumeSessionId = options.resumeSessionId;
  }

  private requireReady(): void {
    if (!this.config.enabled) {
      throw new Error("Claude agent is disabled");
    }
    if (!this.config.apiKey) {
      throw new Error("Claude credentials are required (CLAUDE_API_KEY/ANTHROPIC_API_KEY env or ~/.claude/* config)");
    }
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: this.streamingEnabled, throttleMs: this.streamThrottleMs };
  }

  status() {
    if (!this.config.enabled) {
      return { ready: false, streaming: this.streamingEnabled, error: "Claude agent disabled" };
    }
    if (!this.config.apiKey) {
      return { ready: false, streaming: this.streamingEnabled, error: "缺少 Claude 凭证（CLAUDE_API_KEY/ANTHROPIC_API_KEY 或 ~/.claude/*）" };
    }
    return { ready: true, streaming: this.streamingEnabled };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  reset(): void {
    this.sessionId = undefined;
    this.resumeSessionId = undefined;
  }

  setWorkingDirectory(workingDirectory?: string): void {
    this.workingDirectory = workingDirectory;
  }

  setModel(model?: string): void {
    this.model = model;
  }

  getThreadId(): string | null {
    return this.sessionId ?? null;
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch {
        // ignore handler errors
      }
    }
  }

  private emitPhase(
    phase: AgentEvent["phase"],
    title: string,
    detail?: string,
    rawType: "turn.started" | "turn.completed" | "turn.failed" | "error" | "item.updated" = "turn.started",
  ): void {
    const raw = { type: rawType } as AgentEvent["raw"];
    this.emitEvent({ phase, title, detail, timestamp: Date.now(), raw });
  }

  private emitDelta(delta: string, messageId: string): void {
    const raw = {
      type: "item.updated",
      item: { id: messageId, type: "agent_message", text: delta },
    } as AgentEvent["raw"];
    this.emitEvent({
      phase: "responding",
      title: STREAM_STATUS_TITLE,
      delta,
      timestamp: Date.now(),
      raw,
    });
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    this.requireReady();
    const prompt = normalizeInput(input);
    const useStreaming = options?.streaming ?? this.streamingEnabled;
    const abortController = new AbortController();

    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        const abortListener = () => abortController.abort(options.signal?.reason);
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    const outputSchema = options?.outputSchema;
    const outputFormat: OutputFormat | undefined = outputSchema
      ? { type: "json_schema", schema: outputSchema as Record<string, unknown> }
      : undefined;
    const stream = query({
      prompt,
      options: {
        abortController,
        cwd: this.workingDirectory || this.config.workdir,
        model: this.model || this.config.model,
        // ADS executes host actions via <<<tool.*>>> blocks; keep Claude Code tools disabled to avoid permission prompts and out-of-band changes.
        tools: [],
        systemPrompt: this.systemPrompt,
        includePartialMessages: useStreaming,
        outputFormat,
        resume: this.sessionId ?? this.resumeSessionId,
        persistSession: true,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.apiKey,
          ANTHROPIC_AUTH_TOKEN: this.config.apiKey,
          ...(this.config.baseUrl ? { ANTHROPIC_BASE_URL: this.config.baseUrl } : {}),
        },
      },
    });

    let lastAssistantResponse = "";
    let finalResult = "";
    let structuredOutput: unknown = null;
    let usage: Usage | null = null;
    let streamedText = "";
    let pendingDelta = "";
    let lastDeltaAt = 0;
    const messageId = `claude-${Date.now()}`;
    const flushDelta = (force = false) => {
      if (!useStreaming || !pendingDelta) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastDeltaAt < this.streamThrottleMs) {
        return;
      }
      this.emitDelta(pendingDelta, messageId);
      pendingDelta = "";
      lastDeltaAt = now;
    };

    this.emitPhase("analysis", "开始处理请求", undefined, "turn.started");
    try {
      for await (const message of stream) {
        if (isSystemInitMessage(message)) {
          this.sessionId = message.session_id;
          this.resumeSessionId = this.sessionId;
        }
        const delta = extractTextDelta(message);
        if (delta) {
          streamedText += delta;
          pendingDelta += delta;
          flushDelta();
          continue;
        }
        if (isAssistantMessage(message)) {
          const textBlocks = message.message.content
            .filter((block): block is AssistantTextBlock => block.type === "text")
            .map((block) => block.text)
            .filter(Boolean);
          if (textBlocks.length > 0) {
            lastAssistantResponse = textBlocks.join("\n\n");
          }
        } else if (isResultMessage(message)) {
          usage = mapUsage(message);
          if (message.subtype === "success") {
            finalResult = typeof message.result === "string" ? message.result : "";
            structuredOutput = message.structured_output ?? null;
          } else {
            structuredOutput = null;
            finalResult = "";
          }
          if (message.is_error) {
            const errorText =
              message.subtype === "success"
                ? finalResult
                : message.errors?.join("\n");
            throw new Error(errorText || "Claude agent run failed");
          }
        }
      }
      flushDelta(true);
    } catch (error) {
      if (error instanceof AbortError) {
        this.emitPhase("error", "执行失败", "Claude agent request aborted", "turn.failed");
        throw new Error("Claude agent request aborted");
      }
      this.emitPhase(
        "error",
        "执行失败",
        error instanceof Error ? error.message : String(error),
        "turn.failed",
      );
      throw error;
    }

    this.emitPhase("completed", "处理完成", undefined, "turn.completed");

    const structuredText =
      structuredOutput !== null
        ? typeof structuredOutput === "string"
          ? structuredOutput
          : JSON.stringify(structuredOutput, null, 2)
        : "";
    const response =
      structuredText ||
      lastAssistantResponse ||
      finalResult ||
      streamedText ||
      "(Claude 无响应)";

    return {
      response,
      usage,
      agentId: this.id,
    };
  }
}
