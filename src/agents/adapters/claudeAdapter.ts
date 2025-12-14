import type { Input, Usage } from "@openai/codex-sdk";
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk/sdk.mjs";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk/sdk";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";
import type { ClaudeAgentConfig } from "../config.js";

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
  "If you need to execute a command, emit a tool block (requires ENABLE_AGENT_EXEC_TOOL=1):",
  "<<<tool.exec",
  "npm test",
  ">>>",
  "Tool output will be injected back into the conversation by ADS.",
].join("\n");

function mapUsage(result: SDKResultMessage): Usage | null {
  if (!result.usage) {
    return null;
  }
  return {
    input_tokens: result.usage.inputTokens ?? 0,
    cached_input_tokens: result.usage.cacheReadInputTokens ?? 0,
    output_tokens: result.usage.outputTokens ?? 0,
  };
}

function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === "assistant";
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === "result";
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
      return current.type ? `[${current.type}]` : "[content]";
    })
    .join("\n\n");
}

export interface ClaudeAgentAdapterOptions {
  config: ClaudeAgentConfig;
  systemPrompt?: string;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly config: ClaudeAgentConfig;
  private readonly systemPrompt: string;
  private workingDirectory?: string;
  private model?: string;

  constructor(options: ClaudeAgentAdapterOptions) {
    this.config = options.config;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.metadata = { ...DEFAULT_METADATA, defaultModel: this.config.model };
    this.id = this.metadata.id;
  }

  private requireReady(): void {
    if (!this.config.enabled) {
      throw new Error("Claude agent is disabled");
    }
    if (!this.config.apiKey) {
      throw new Error("CLAUDE_API_KEY is required to use Claude agent");
    }
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: false, throttleMs: 0 };
  }

  status() {
    if (!this.config.enabled) {
      return { ready: false, streaming: false, error: "Claude agent disabled" };
    }
    if (!this.config.apiKey) {
      return { ready: false, streaming: false, error: "缺少 CLAUDE_API_KEY" };
    }
    return { ready: true, streaming: false };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    void handler;
    // Streaming events are not yet supported for Claude
    return () => undefined;
  }

  reset(): void {
    // Stateless adapter
  }

  setWorkingDirectory(workingDirectory?: string): void {
    this.workingDirectory = workingDirectory;
  }

  setModel(model?: string): void {
    this.model = model;
  }

  getThreadId(): string | null {
    return null;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    this.requireReady();
    const prompt = normalizeInput(input);
    const abortController = new AbortController();

    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort(options.signal.reason);
      } else {
        const abortListener = () => abortController.abort(options.signal?.reason);
        options.signal.addEventListener("abort", abortListener, { once: true });
      }
    }

    const stream = query({
      prompt,
      options: {
        abortController,
        cwd: this.workingDirectory || this.config.workdir,
        model: this.model || this.config.model,
        allowedTools: this.config.toolAllowlist,
        systemPrompt: this.systemPrompt,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.apiKey,
          ANTHROPIC_AUTH_TOKEN: this.config.apiKey,
          ...(this.config.baseUrl ? { ANTHROPIC_BASE_URL: this.config.baseUrl } : {}),
        },
        outputSchema: options?.outputSchema as Record<string, unknown> | undefined,
      },
    });

    let lastAssistantResponse = "";
    let finalResult = "";
    let usage: Usage | null = null;

    try {
      for await (const message of stream) {
        if (isAssistantMessage(message)) {
          const textBlocks = message.message.content
            .filter(
              (block): block is { type?: string; text?: string } =>
                (block as { type?: string }).type === "text",
            )
            .map((block) => block.text ?? "")
            .filter(Boolean);
          if (textBlocks.length > 0) {
            lastAssistantResponse = textBlocks.join("\n\n");
          }
        } else if (isResultMessage(message)) {
          usage = mapUsage(message);
          finalResult = typeof message.result === "string" ? message.result : "";
          if (message.is_error) {
            const errorText = finalResult || "Claude agent run failed";
            throw new Error(errorText);
          }
        }
      }
    } catch (error) {
      if (error instanceof AbortError) {
        throw new Error("Claude agent request aborted");
      }
      throw error;
    }

    const response = lastAssistantResponse || finalResult || "(Claude 无响应)";

    return {
      response,
      usage,
      agentId: this.id,
    };
  }
}
