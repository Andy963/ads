import type { Input, Usage } from "@openai/codex-sdk";
import {
  GoogleGenAI,
  ApiError,
  FunctionCallingConfigMode,
  createPartFromFunctionResponse,
  type CallableTool,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";
import type { GeminiAgentConfig } from "../config.js";
import { executeToolInvocation, type ToolExecutionContext, type ToolHooks } from "../tools.js";

type CodexInputPart = Exclude<Input, string>[number];

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1200;

const DEFAULT_METADATA: AgentMetadata = {
  id: "gemini",
  name: "Gemini",
  vendor: "Google",
  capabilities: ["text", "files", "commands"],
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Gemini running inside the ADS automation platform.",
  "Your job: execute the user's request end-to-end (plan, inspect code, make changes, run checks) unless constraints prevent it.",
  "- Plan before acting: outline the steps, then group file reads/writes instead of issuing many tiny calls.",
  "- When reading code, prefer whole files or meaningful blocks, not line-by-line snippets.",
  "- Minimize tool invocations; combine edits into apply_patch where possible to avoid extra API calls.",
  "",
  "Tooling:",
  "- You may have access to function tools (exec/read/write/apply_patch/search) that run on the host.",
  "- Use tools to inspect and modify the codebase; do not ask the user to run commands when you can run them.",
  "- Prefer apply_patch for code changes; only use write for new files or small edits.",
  "",
  "Output rules:",
  "- Do NOT output <<<tool.*>>> blocks; use function tools instead.",
  "- When finished, respond with a concise summary and next verification steps.",
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

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveAllowedDirsFallback(cwd: string): string[] {
  const raw = process.env.ALLOWED_DIRS;
  if (!raw) {
    return [cwd];
  }
  const dirs = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return dirs.length > 0 ? dirs : [cwd];
}

function isExecToolEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, false);
}

function isFileToolsEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_FILE_TOOLS, false);
}

function isApplyPatchEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_APPLY_PATCH, false);
}

function buildAdsFunctionDeclarations(): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];

  declarations.push({
    name: "search",
    description: "Web search via ADS (Tavily). Returns a concise result list.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query." },
        maxResults: { type: "integer", description: "Max results to return." },
        lang: { type: "string", description: "Language hint, e.g. 'en' or 'zh'." },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
  });

  if (isFileToolsEnabled()) {
    declarations.push(
      {
        name: "read",
        description: "Read a local text file (restricted to allowed directories).",
        parametersJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "File path (absolute or relative to current working directory)." },
            startLine: { type: "integer", description: "1-based line number to start reading." },
            endLine: { type: "integer", description: "1-based line number to end reading." },
            maxBytes: { type: "integer", description: "Optional byte limit override." },
          },
          required: ["path"],
        },
      },
      {
        name: "write",
        description: "Write a local file (restricted to allowed directories).",
        parametersJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "File path (absolute or relative to current working directory)." },
            content: { type: "string", description: "Full file content to write." },
            append: { type: "boolean", description: "Append instead of overwrite." },
          },
          required: ["path", "content"],
        },
      },
    );

    if (isApplyPatchEnabled()) {
      declarations.push({
        name: "apply_patch",
        description: "Apply a git-style unified diff patch in the current repository.",
        parametersJsonSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            patch: { type: "string", description: "Unified diff patch text (git apply compatible)." },
          },
          required: ["patch"],
        },
      });
    }
  }

  if (isExecToolEnabled()) {
    declarations.push({
      name: "exec",
      description: "Execute a local command (no shell), with optional args and timeout.",
      parametersJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cmd: { type: "string", description: "Executable to run, e.g. 'npm' or 'git'." },
          args: { type: "array", items: { type: "string" }, description: "Argument list." },
          timeoutMs: { type: "integer", description: "Timeout in milliseconds." },
        },
        required: ["cmd"],
      },
    });
  }

  return declarations;
}

function resolveToolPayload(call: FunctionCall): { tool: string; payload: string } {
  const name = (call.name ?? "").trim();
  const args = call.args ?? {};

  if (name === "apply_patch") {
    const patch = typeof args.patch === "string" ? args.patch : "";
    return { tool: name, payload: patch };
  }

  if (name === "exec") {
    const cmdRaw = args.cmd;
    const cmd = typeof cmdRaw === "string" ? cmdRaw : "";
    const argsRaw = args.args;
    const argv = Array.isArray(argsRaw) ? argsRaw.map((entry) => String(entry)) : [];
    const timeoutRaw = args.timeoutMs;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : undefined;
    const payloadObj = timeoutMs ? { cmd, args: argv, timeoutMs } : { cmd, args: argv };
    return { tool: name, payload: JSON.stringify(payloadObj) };
  }

  return { tool: name, payload: JSON.stringify(args) };
}

function buildCallableAdsTool(context: ToolExecutionContext, hooks?: ToolHooks): CallableTool {
  const declarations = buildAdsFunctionDeclarations();
  return {
    tool: async () => ({ functionDeclarations: declarations }),
    callTool: async (functionCalls: FunctionCall[]): Promise<Part[]> => {
      const parts: Part[] = [];
      for (let idx = 0; idx < functionCalls.length; idx += 1) {
        const call = functionCalls[idx];
        const id = call.id ?? `${call.name ?? "tool"}-${Date.now()}-${idx}`;
        const name = (call.name ?? "").trim();
        if (!name) {
          parts.push(
            createPartFromFunctionResponse(id, "unknown", {
              error: "Missing function name",
              output: "",
            }),
          );
          continue;
        }

        const resolved = resolveToolPayload(call);
        if (!resolved.tool) {
          parts.push(
            createPartFromFunctionResponse(id, name, {
              error: "Invalid tool name",
              output: "",
            }),
          );
          continue;
        }

        const result = await executeToolInvocation(resolved.tool, resolved.payload, context, hooks);
        parts.push(
          createPartFromFunctionResponse(id, name, {
            ...(result.ok ? {} : { error: result.error ?? "Tool failed" }),
            output: result.output,
          }),
        );
      }
      return parts;
    },
  };
}

export class GeminiAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly config: GeminiAgentConfig;
  private readonly systemPrompt: string;
  private workingDirectory?: string;
  private model?: string;
  private ai: GoogleGenAI | null = null;
  private chat: ReturnType<GoogleGenAI["chats"]["create"]> | null = null;
  private readonly minRequestIntervalMs: number;
  private nextAvailableAt = 0;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: GeminiAgentAdapterOptions) {
    this.config = options.config;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.metadata = { ...DEFAULT_METADATA, defaultModel: this.config.model };
    this.id = this.metadata.id;
    const envInterval = parsePositiveInt(process.env.GEMINI_MIN_REQUEST_INTERVAL_MS, DEFAULT_MIN_REQUEST_INTERVAL_MS);
    this.minRequestIntervalMs = Math.min(Math.max(envInterval, 0), 10000);
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
    this.chat = null;
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.workingDirectory !== workingDirectory) {
      this.workingDirectory = workingDirectory;
      this.reset();
    }
  }

  setModel(model?: string): void {
    if (this.model !== model) {
      this.model = model;
      this.reset();
    }
  }

  getThreadId(): string | null {
    return null;
  }

  private getChat(model: string) {
    if (!this.chat) {
      this.chat = this.getClient().chats.create({ model });
    }
    return this.chat;
  }

  private resolveToolContext(options?: AgentSendOptions): ToolExecutionContext {
    if (options?.toolContext) {
      return options.toolContext;
    }
    const cwd = this.workingDirectory || process.cwd();
    return { cwd, allowedDirs: resolveAllowedDirsFallback(cwd) };
  }

  private resolveToolHooks(options?: AgentSendOptions): ToolHooks | undefined {
    return options?.toolHooks;
  }

  private async throttleRequests(): Promise<void> {
    if (this.minRequestIntervalMs <= 0) {
      return;
    }
    const now = Date.now();
    const delay = this.nextAvailableAt - now;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async enqueueSend<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.sendQueue;
    let release: (() => void) | null = null;
    this.sendQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      await this.throttleRequests();
      const result = await fn();
      this.nextAvailableAt = Date.now() + this.minRequestIntervalMs;
      return result;
    } finally {
      release?.();
    }
  }

  private extractRetryAfterMs(error: ApiError): number | null {
    const header =
      (error.response as { headers?: Record<string, string> } | undefined)?.headers?.["retry-after"] ??
      (error as { retryAfter?: number }).retryAfter;
    if (!header) {
      return null;
    }
    const parsed = Number(header);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      const delta = date - Date.now();
      return delta > 0 ? delta : null;
    }
    return null;
  }

  private async sendWithRetry<T>(fn: () => Promise<T>, canRetry: () => boolean): Promise<T> {
    const maxAttempts = 3;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const status =
          error instanceof ApiError
            ? error.status
            : typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : null;
        if (status !== 429 && status !== 503) {
          throw error;
        }
        if (!canRetry()) {
          throw error;
        }
        if (attempt >= maxAttempts) {
          break;
        }
        const retryAfterMs = error instanceof ApiError ? this.extractRetryAfterMs(error) : null;
        const baseMs = retryAfterMs ?? 400 * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * 200);
        const waitMs = Math.min(8000, baseMs + jitter);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Gemini request failed")));
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    return this.enqueueSend(() => this.runSend(input, options));
  }

  private async runSend(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    this.requireReady();
    const prompt = normalizeInput(input);
    const model = this.model || this.config.model;
    const toolContext = this.resolveToolContext(options);
    const toolHooks = this.resolveToolHooks(options);
    const retryState = { toolCalls: 0 };
    const callableTool = buildCallableAdsTool(
      toolContext,
      {
        onInvoke: async (tool, payload) => {
          retryState.toolCalls += 1;
          await toolHooks?.onInvoke?.(tool, payload);
        },
        onResult: (summary) => toolHooks?.onResult?.(summary),
      },
    );
    const systemInstruction = this.workingDirectory
      ? `${this.systemPrompt}\n\nWorking directory: ${this.workingDirectory}`
      : this.systemPrompt;
    const chat = this.getChat(model);
    const response = await this.sendWithRetry(
      () =>
        chat.sendMessage({
          message: prompt,
          config: {
            abortSignal: options?.signal,
            systemInstruction,
            tools: [callableTool],
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.AUTO,
              },
            },
          },
        }),
      () => retryState.toolCalls === 0,
    );

    return {
      response: response.text || "(Gemini 无响应)",
      usage: mapUsage(response.usageMetadata),
      agentId: this.id,
    };
  }
}
