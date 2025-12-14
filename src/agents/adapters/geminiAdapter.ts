import type { Input, Usage } from "@openai/codex-sdk";
import { GoogleGenAI, type GenerateContentResponseUsageMetadata } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
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
    if (this.config.vertexai) {
      if (!this.config.project || !this.config.location) {
        throw new Error("GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are required for Vertex AI Gemini");
      }
      if (!this.config.accessToken && !this.config.googleAuthKeyFile) {
        // Allow ADC (gcloud auth application-default login) without explicit key file.
        return;
      }
      return;
    }
    if (!this.config.apiKey && !this.config.accessToken && !this.config.googleAuthKeyFile) {
      throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required to use Gemini agent");
    }
  }

  private getClient(): GoogleGenAI {
    if (!this.ai) {
      const httpOptions: Record<string, unknown> = {};
      if (this.config.baseUrl) {
        httpOptions.baseUrl = this.config.baseUrl;
      }

      const options: Record<string, unknown> = {};
      if (this.config.vertexai) {
        options.vertexai = true;
        options.project = this.config.project;
        options.location = this.config.location;
      } else if (this.config.apiKey) {
        options.apiKey = this.config.apiKey;
      }

      if (this.config.apiVersion) {
        options.apiVersion = this.config.apiVersion;
      }

      if (this.config.accessToken) {
        const authClient = new OAuth2Client();
        authClient.setCredentials({ access_token: this.config.accessToken });
        options.googleAuthOptions = { authClient };
      } else if (this.config.googleAuthKeyFile) {
        options.googleAuthOptions = { keyFile: this.config.googleAuthKeyFile };
      }

      if (Object.keys(httpOptions).length > 0) {
        options.httpOptions = httpOptions;
      }

      this.ai = new GoogleGenAI(options as unknown as ConstructorParameters<typeof GoogleGenAI>[0]);
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
    if (this.config.vertexai) {
      if (!this.config.project || !this.config.location) {
        return {
          ready: false,
          streaming: false,
          error: "Vertex AI 模式缺少 GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION",
        };
      }
      return { ready: true, streaming: false };
    }
    if (!this.config.apiKey && !this.config.accessToken && !this.config.googleAuthKeyFile) {
      return { ready: false, streaming: false, error: "缺少 GEMINI_API_KEY / GOOGLE_API_KEY" };
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
