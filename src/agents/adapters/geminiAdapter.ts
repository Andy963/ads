import type { Input, Usage } from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  GoogleGenAI,
  ApiError,
  FunctionCallingConfigMode,
  createPartFromFunctionResponse,
  HarmCategory,
  HarmBlockThreshold,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Tool,
} from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import type { AgentAdapter, AgentMetadata, AgentRunResult, AgentSendOptions } from "../types.js";
import type { GeminiAgentConfig } from "../config.js";
import { executeToolInvocation, type ToolExecutionContext, type ToolHooks } from "../tools.js";
import { truncateForLog } from "../../utils/text.js";

type CodexInputPart = Exclude<Input, string>[number];

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1000;
const DEFAULT_MAX_RPM = 0;
const DEFAULT_MAX_RETRY_WAIT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOG_FILE = "gemini.log";

class AbortError extends Error {
  name = "AbortError";
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(new AbortError("Aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new AbortError("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function hashSecret(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function resolveLimiterKey(config: GeminiAgentConfig): string {
  const baseUrl = config.baseUrl ?? "";
  if (config.vertexai) {
    return `vertexai:${config.project ?? "unknown"}:${config.location ?? "unknown"}:${baseUrl}`;
  }
  if (config.apiKey) {
    return `gemini:${hashSecret(config.apiKey)}:${baseUrl}`;
  }
  if (config.accessToken) {
    return `gemini_token:${hashSecret(config.accessToken)}:${baseUrl}`;
  }
  if (config.googleAuthKeyFile) {
    return `gemini_keyfile:${config.googleAuthKeyFile}:${baseUrl}`;
  }
  return `gemini:unknown:${baseUrl}`;
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

function maskPathForLog(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.length <= 180) {
    return trimmed;
  }
  return `${trimmed.slice(0, 90)}…${trimmed.slice(-60)}`;
}

class GeminiRequestLimiter {
  private queue: Promise<void> = Promise.resolve();
  private nextAvailableAt = 0;
  private readonly recent: number[] = [];
  private minIntervalMs: number;
  private maxRpm: number;

  constructor(options: { minIntervalMs: number; maxRpm: number }) {
    this.minIntervalMs = options.minIntervalMs;
    this.maxRpm = options.maxRpm;
  }

  update(options: { minIntervalMs: number; maxRpm: number }): void {
    this.minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs));
    this.maxRpm = Math.max(0, Math.floor(options.maxRpm));
  }

  penalize(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }
    this.nextAvailableAt = Math.max(this.nextAvailableAt, Date.now() + Math.floor(ms));
  }

  async schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);

    try {
      await this.waitForSlot(signal);
      const now = Date.now();
      if (this.maxRpm > 0) {
        this.recent.push(now);
      }
      this.nextAvailableAt = now + this.minIntervalMs;
      return await fn();
    } finally {
      release?.();
    }
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw new AbortError("Aborted");
      }

      const now = Date.now();
      let waitMs = Math.max(0, this.nextAvailableAt - now);

      if (this.maxRpm > 0) {
        while (this.recent.length > 0 && now - this.recent[0] >= 60_000) {
          this.recent.shift();
        }
        if (this.recent.length >= this.maxRpm) {
          const earliest = this.recent[0];
          waitMs = Math.max(waitMs, earliest + 60_000 - now);
        }
      }

      if (waitMs <= 0) {
        return;
      }

      await sleepMs(Math.min(waitMs, 1_000), signal);
    }
  }
}

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
  return parseBoolean(process.env.ENABLE_AGENT_EXEC_TOOL, true);
}

function isFileToolsEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_FILE_TOOLS, true);
}

function isApplyPatchEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_AGENT_APPLY_PATCH, true);
}

function isGoogleSearchEnabled(): boolean {
  return parseBoolean(process.env.GEMINI_WEB_SEARCH, true);
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

export class GeminiAgentAdapter implements AgentAdapter {
  private static readonly limiters = new Map<string, GeminiRequestLimiter>();

  readonly id: string;
  readonly metadata: AgentMetadata;
  private readonly config: GeminiAgentConfig;
  private readonly systemPrompt: string;
  private workingDirectory?: string;
  private model?: string;
  private ai: GoogleGenAI | null = null;
  private readonly limiterKey: string;
  private readonly limiter: GeminiRequestLimiter;
  private history: Content[] = [];
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly instanceId: string;

  constructor(options: GeminiAgentAdapterOptions) {
    this.config = options.config;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.metadata = { ...DEFAULT_METADATA, defaultModel: this.config.model };
    this.id = this.metadata.id;
    const envInterval = parsePositiveInt(process.env.GEMINI_MIN_REQUEST_INTERVAL_MS, DEFAULT_MIN_REQUEST_INTERVAL_MS);
    const minIntervalMs = Math.min(Math.max(envInterval, 0), 60_000);
    const maxRpm = Math.max(0, parsePositiveInt(process.env.GEMINI_MAX_RPM, DEFAULT_MAX_RPM));
    this.limiterKey = resolveLimiterKey(this.config);
    this.limiter = this.getLimiter({ minIntervalMs, maxRpm });
    this.instanceId = Math.random().toString(36).slice(2, 10);
  }

  private getLimiter(options: { minIntervalMs: number; maxRpm: number }): GeminiRequestLimiter {
    const existing = GeminiAgentAdapter.limiters.get(this.limiterKey);
    if (existing) {
      existing.update(options);
      return existing;
    }
    const limiter = new GeminiRequestLimiter(options);
    GeminiAgentAdapter.limiters.set(this.limiterKey, limiter);
    return limiter;
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
    this.history = [];
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.workingDirectory !== workingDirectory) {
      this.workingDirectory = workingDirectory;
      this.reset();
      this.log("INFO", "working directory changed", { cwd: workingDirectory ?? "" });
    }
  }

  setModel(model?: string): void {
    if (this.model !== model) {
      this.model = model;
      this.reset();
      this.log("INFO", "model changed", { model: model ?? "" });
    }
  }

  getThreadId(): string | null {
    return null;
  }

  private resolveLogFilePath(): string | null {
    const baseDir = this.workingDirectory ? path.resolve(this.workingDirectory) : null;
    const fallback = path.join(process.cwd(), ".ads", "logs", DEFAULT_LOG_FILE);
    if (!baseDir) {
      return fallback;
    }
    return path.join(baseDir, ".ads", "logs", DEFAULT_LOG_FILE);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const filePath = this.resolveLogFilePath();
    if (!filePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        level,
        agent: "gemini",
        instance: this.instanceId,
        limiter: this.limiterKey,
        workspace: this.workingDirectory ? maskPathForLog(this.workingDirectory) : undefined,
        model: this.model ?? this.config.model,
        message,
        ...(data ? { data } : {}),
      };
      fs.appendFileSync(filePath, `${safeJson(entry)}\n`, "utf-8");
    } catch {
      // ignore file logging failures
    }
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

  private async enqueueSend<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.sendQueue;
    let release: (() => void) | undefined;
    this.sendQueue = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private extractRetryAfterMs(error: ApiError): number | null {
    const responseHeaders =
      (error as { response?: { headers?: Record<string, string> } }).response?.headers ??
      (error as { headers?: Record<string, string> }).headers;
    const retryAfterValue =
      responseHeaders?.["retry-after"] ??
      (error as { retryAfter?: number | string }).retryAfter;
    if (!retryAfterValue) {
      return null;
    }
    const header = String(retryAfterValue);
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

  private async sendWithRetry<T>(
    fn: () => Promise<T>,
    options?: { signal?: AbortSignal; maxAttempts?: number; maxWaitMs?: number },
  ): Promise<T> {
    const maxAttempts =
      options?.maxAttempts ??
      Math.max(1, parsePositiveInt(process.env.GEMINI_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS));
    const maxWaitMs =
      options?.maxWaitMs ??
      Math.max(1_000, parsePositiveInt(process.env.GEMINI_MAX_RETRY_WAIT_MS, DEFAULT_MAX_RETRY_WAIT_MS));
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
          this.log("ERROR", "request failed", {
            status,
            attempt,
            maxAttempts,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        if (attempt >= maxAttempts) {
          break;
        }
        const retryAfterMs = error instanceof ApiError ? this.extractRetryAfterMs(error) : null;
        const baseMs = retryAfterMs ?? 1200 * 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * 200);
        const waitMs = Math.min(maxWaitMs, baseMs + jitter);
        this.limiter.penalize(waitMs);
        this.log("WARN", "rate limited; backing off", {
          status,
          attempt,
          maxAttempts,
          waitMs,
          retryAfterMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleepMs(waitMs, options?.signal);
      }
    }
    this.log("ERROR", "request failed after retries", {
      attempts: attempt,
      maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? "Gemini request failed")));
  }

  private withRateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.limiter.schedule(fn, signal);
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    try {
      return await this.enqueueSend(() => this.runSend(input, options));
    } catch (error) {
      const aborted = options?.signal?.aborted;
      if (aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log("ERROR", "send failed", { error: message });
      const hint = [
        "建议：",
        "- 等待片刻后重试；或临时切换到 codex/claude。",
        "- 可调大 GEMINI_MIN_REQUEST_INTERVAL_MS（例如 2000-5000）。",
        "- 若存在多会话并发，可设置 GEMINI_MAX_RPM（例如 10）来限制全局速率。",
      ].join("\n");
      return { response: `⚠️ Gemini 调用失败：${message}\n\n${hint}`, usage: null, agentId: this.id };
    }
  }

  private async runSend(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    this.requireReady();
    const prompt = normalizeInput(input);
    const model = this.model || this.config.model;
    const toolContext = this.resolveToolContext(options);
    const toolHooks = this.resolveToolHooks(options);
    const retryState = { toolCalls: 0 };
    const functionDeclarations = buildAdsFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations }];
    if (isGoogleSearchEnabled()) {
      tools.push({ googleSearch: {} });
    }
    const systemInstruction = this.workingDirectory
      ? `${this.systemPrompt}\n\nWorking directory: ${this.workingDirectory}`
      : this.systemPrompt;

    const contents: Content[] = [...this.history, { role: "user", parts: [{ text: prompt }] }];
    this.log("INFO", "send start", {
      model,
      historyEntries: this.history.length,
      promptPreview: truncateForLog(prompt, 256),
      googleSearchEnabled: isGoogleSearchEnabled(),
    });

    const runModelRequest = async (
      mode: FunctionCallingConfigMode = FunctionCallingConfigMode.AUTO,
    ): Promise<{
      responseText: string;
      usage: Usage | null;
      modelContent?: Content;
      functionCalls?: FunctionCall[];
      functionResponses?: Part[];
    }> => {
      const response = await this.sendWithRetry(
        () =>
          this.withRateLimit(
            () =>
              this.getClient().models.generateContent({
                model,
                contents,
                config: {
                  abortSignal: options?.signal,
                  systemInstruction,
                  tools,
                  toolConfig: {
                    functionCallingConfig: { mode },
                  },
                  automaticFunctionCalling: { disable: true },
                  safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                  ],
                },
              }),
            options?.signal,
          ),
        { signal: options?.signal },
      );

      const candidate = response.candidates?.[0];
      const responseText =
        (candidate?.content?.parts ?? [])
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .filter((text) => Boolean(text))
          .join("\n") || "";
      const functionCalls =
        response.functionCalls ??
        candidate?.content?.parts
          ?.map((part) => part.functionCall)
          .filter((call): call is FunctionCall => Boolean(call));

      return {
        responseText: responseText || "(Gemini 无响应)",
        usage: mapUsage(response.usageMetadata),
        modelContent: candidate?.content,
        functionCalls,
        functionResponses: undefined,
      };
    };

    let lastResponse: string | null = null;
    let usage: Usage | null = null;
    const maxToolPasses = Math.max(1, parsePositiveInt(process.env.GEMINI_MAX_TOOL_PASSES, 6));
    let completed = false;

    for (let pass = 0; pass < maxToolPasses; pass += 1) {
      const modelResult = await runModelRequest(FunctionCallingConfigMode.AUTO);
      lastResponse = modelResult.responseText;
      usage = modelResult.usage ?? usage;

      if (modelResult.modelContent) {
        contents.push({ ...modelResult.modelContent, role: modelResult.modelContent.role ?? "model" });
      }

      const functionCalls = modelResult.functionCalls ?? [];
      this.log("DEBUG", "model response", {
        pass,
        functionCalls: functionCalls.length,
        responsePreview: truncateForLog(lastResponse ?? "", 256),
      });
      if (!functionCalls.length) {
        completed = true;
        break;
      }

      const functionResponseParts: Part[] = [];
      for (let idx = 0; idx < functionCalls.length; idx += 1) {
        const call = functionCalls[idx];
        const id = call.id ?? `${call.name ?? "tool"}-${Date.now()}-${idx}`;
        const name = (call.name ?? "").trim();
        const resolved = resolveToolPayload(call);
        retryState.toolCalls += 1;
        this.log("INFO", "tool invoke", {
          pass,
          tool: resolved.tool,
          payloadPreview: truncateForLog(resolved.payload, 512),
        });
        const result = await executeToolInvocation(resolved.tool, resolved.payload, toolContext, toolHooks);
        this.log("INFO", "tool result", {
          pass,
          tool: resolved.tool,
          ok: result.ok,
          error: result.ok ? undefined : result.error ?? "Tool failed",
          outputPreview: truncateForLog(result.output, 512),
        });
        functionResponseParts.push(
          createPartFromFunctionResponse(id, name, {
            ...(result.ok ? {} : { error: result.error ?? "Tool failed" }),
            output: result.output,
          }),
        );
      }

      // Gemini 的 Function Calling 结果应作为 user role 追加（SDK 内部 AFC 也如此处理）。
      contents.push({ role: "user", parts: functionResponseParts });
    }

    // 若达到工具回合上限而仍未拿到最终自然语言回复，则强制模型输出总结（禁用函数调用），
    // 避免会话停在 tool-result 状态导致“中断/报错”。
    if (!completed && contents[contents.length - 1]?.role === "user") {
      const finalResult = await runModelRequest(FunctionCallingConfigMode.NONE);
      lastResponse = finalResult.responseText;
      usage = finalResult.usage ?? usage;
      if (finalResult.modelContent) {
        contents.push({ ...finalResult.modelContent, role: finalResult.modelContent.role ?? "model" });
      } else {
        contents.push({ role: "model", parts: [{ text: lastResponse || "(无内容返回)" }] });
      }
    }

    const lastContent = contents[contents.length - 1];
    if (lastContent?.role === "user") {
      contents.push({ role: "model", parts: [{ text: lastResponse || "(无内容返回)" }] });
    }

    this.history = contents;
    this.log("INFO", "send complete", { toolCalls: retryState.toolCalls, completed, usage: usage ?? undefined });

    return {
      response: lastResponse ?? "(Gemini 无响应)",
      usage,
      agentId: this.id,
    };
  }
}
