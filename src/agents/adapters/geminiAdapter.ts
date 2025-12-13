import type { Input, Usage } from "@openai/codex-sdk";
import { GoogleGenAI, type GenerateContentResponseUsageMetadata } from "@google/genai";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";
import type { GeminiAgentConfig } from "../config.js";

type CodexInputPart = Exclude<Input, string>[number];

const DEFAULT_METADATA: AgentMetadata = {
  id: "gemini",
  name: "Gemini",
  vendor: "Google",
  capabilities: ["text"],
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Gemini assisting the ADS automation platform as a supporting agent.",
  "Always respond with actionable plans, diffs, or insights. You cannot run shell commands or apply patches yourself.",
  "If file edits or commands are required, describe the exact steps so Codex can execute them safely.",
].join("\n");

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

function mapUsage(usage?: GenerateContentResponseUsageMetadata): Usage | null {
  if (!usage) {
    return null;
  }
  const inputTokens = usage.promptTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const outputTokens = usage.candidatesTokenCount ?? 0;
  if (inputTokens === 0 && cachedTokens === 0 && outputTokens === 0) {
    return null;
  }
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
  };
}

export interface GeminiAgentAdapterOptions {
  config: GeminiAgentConfig;
  systemPrompt?: string;
}

export class GeminiAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly config: GeminiAgentConfig;
  private readonly systemPrompt: string;
  private workingDirectory?: string;
  private model?: string;
  private ai: GoogleGenAI | null = null;

  constructor(options: GeminiAgentAdapterOptions) {
    this.config = options.config;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.metadata = { ...DEFAULT_METADATA, defaultModel: this.config.model };
    this.id = this.metadata.id;
  }

  private requireReady(): void {
    if (!this.config.enabled) {
      throw new Error("Gemini agent is disabled");
    }
    if (!this.config.apiKey) {
      throw new Error("GEMINI_API_KEY is required to use Gemini agent");
    }
  }

  private getClient(): GoogleGenAI {
    if (!this.ai) {
      this.ai = new GoogleGenAI({ apiKey: this.config.apiKey });
    }
    return this.ai;
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: false, throttleMs: 0 };
  }

  status() {
    if (!this.config.enabled) {
      return { ready: false, streaming: false, error: "Gemini agent disabled" };
    }
    if (!this.config.apiKey) {
      return { ready: false, streaming: false, error: "缺少 GEMINI_API_KEY" };
    }
    return { ready: true, streaming: false };
  }

  onEvent(handler: Parameters<AgentAdapter["onEvent"]>[0]): () => void {
    void handler;
    // Streaming events are not yet supported for Gemini
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
    const model = this.model || this.config.model;
    const systemInstruction = this.workingDirectory
      ? `${this.systemPrompt}\n\nWorking directory: ${this.workingDirectory}`
      : this.systemPrompt;
    const response = await this.getClient().models.generateContent({
      model,
      contents: prompt,
      config: {
        abortSignal: options?.signal,
        systemInstruction,
      },
    });

    return {
      response: response.text || "(Gemini 无响应)",
      usage: mapUsage(response.usageMetadata),
      agentId: this.id,
    };
  }
}
