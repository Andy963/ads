import {
  Codex,
  type ThreadEvent,
  type TurnOptions,
  type Usage,
  type SandboxMode,
} from "@openai/codex-sdk";

import { resolveCodexConfig, type CodexResolvedConfig } from "../codexConfig.js";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../codex/events.js";
import type { IntakeClassification } from "../intake/types.js";

interface CodexSessionOptions {
  overrides?: Partial<CodexResolvedConfig>;
  streamingEnabled?: boolean;
  streamThrottleMs?: number;
  resumeThreadId?: string;
  sandboxMode?: SandboxMode;
  model?: string;
  workingDirectory?: string;
}

export interface CodexSendOptions {
  streaming?: boolean;
  outputSchema?: unknown;
  signal?: AbortSignal;
}

export interface CodexSendResult {
  response: string;
  usage: Usage | null;
}

export class CodexSession {
  private codex: Codex | null = null;
  private thread: ReturnType<Codex["startThread"]> | null = null;
  private ready = false;
  private lastError: string | null = null;
  private readonly streamingEnabled: boolean;
  private readonly streamThrottleMs: number;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private options: CodexSessionOptions;

  constructor(options: CodexSessionOptions = {}) {
    this.options = { ...options };
    this.streamingEnabled =
      this.options.streamingEnabled ?? process.env.ADS_CODEX_STREAMING !== "0";

    const envThrottle = Number(process.env.ADS_CODEX_STREAM_THROTTLE_MS);
    this.streamThrottleMs = this.options.streamThrottleMs ?? (Number.isFinite(envThrottle) && envThrottle >= 0 ? envThrottle : 200);
  }

  private ensureClient(): void {
    if (this.ready || this.lastError) {
      return;
    }

    try {
      const config = resolveCodexConfig(this.options.overrides ?? {});
      this.codex = new Codex({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
      this.ready = true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private ensureThread(): ReturnType<Codex["startThread"]> {
    if (!this.thread && this.codex) {
      const threadOptions = {
        skipGitRepoCheck: true,
        sandboxMode: this.options.sandboxMode,
        model: this.options.model,
        workingDirectory: this.options.workingDirectory,
      };
      
      if (this.options.resumeThreadId) {
        try {
          this.thread = this.codex.resumeThread(this.options.resumeThreadId, threadOptions);
          console.log(`[CodexSession] Resumed thread ${this.options.resumeThreadId}`);
        } catch (error) {
          console.warn(`[CodexSession] Failed to resume thread, creating new one:`, error);
          this.thread = this.codex.startThread(threadOptions);
        }
      } else {
        this.thread = this.codex.startThread(threadOptions);
      }
    }
    return this.thread!;
  }
  
  getThreadId(): string | null {
    return this.thread?.id ?? null;
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        console.warn("事件回调异常", err);
      }
    }
  }

  private emitSynthetic(
    phase: AgentEvent["phase"],
    title: string,
    detail?: string,
    rawType: ThreadEvent["type"] = "turn.started",
  ): void {
    const syntheticEvent: AgentEvent = {
      phase,
      title,
      detail,
      timestamp: Date.now(),
      raw: { type: rawType } as ThreadEvent,
    } as AgentEvent;
    this.emitEvent(syntheticEvent);
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: this.streamingEnabled, throttleMs: this.streamThrottleMs };
  }

  reset(): void {
    this.thread = null;
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.options.workingDirectory === workingDirectory) {
      return;
    }
    this.options = { ...this.options, workingDirectory };
    this.reset();
  }

  status(): { ready: boolean; error?: string; streaming: boolean } {
    this.ensureClient();
    return { ready: this.ready, error: this.lastError ?? undefined, streaming: this.streamingEnabled };
  }

  async send(prompt: any, options: CodexSendOptions = {}): Promise<CodexSendResult> {
    this.ensureClient();
    if (!this.ready || !this.codex) {
      throw new Error(this.lastError ?? "未配置 Codex 凭证");
    }

    const thread = this.ensureThread();
    const turnOptions = this.buildTurnOptions(options);
    const useStreaming = options.streaming ?? this.streamingEnabled;
    const signal = options.signal;

    if (!useStreaming) {
      return this.sendNonStreaming(thread, prompt, turnOptions, signal);
    }

    return this.sendStreaming(thread, prompt, turnOptions, signal);
  }

  private buildTurnOptions(options: CodexSendOptions): TurnOptions | undefined {
    if (options.outputSchema === undefined) {
      return undefined;
    }
    return { outputSchema: options.outputSchema } satisfies TurnOptions;
  }

  private async sendNonStreaming(
    thread: ReturnType<Codex["startThread"]>,
    prompt: any,
    turnOptions: TurnOptions | undefined,
    signal?: AbortSignal,
  ): Promise<CodexSendResult> {
    this.emitSynthetic("analysis", "开始处理请求", undefined, "turn.started");
    try {
      // SDK 不支持 signal 参数，使用 Promise.race 实现中断
      const runPromise = thread.run(prompt, turnOptions);
      
      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('用户中断了请求'));
          });
        });
        const result = await Promise.race([runPromise, abortPromise]);
        this.emitSynthetic("completed", "处理完成", undefined, "turn.completed");
        return {
          response: this.normalizeResponse(result.finalResponse),
          usage: result.usage,
        };
      }
      
      const result = await runPromise;
      this.emitSynthetic("completed", "处理完成", undefined, "turn.completed");
      return {
        response: this.normalizeResponse(result.finalResponse),
        usage: result.usage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitSynthetic("error", "执行失败", message, "turn.failed");
      throw error;
    }
  }

  private async sendStreaming(
    thread: ReturnType<Codex["startThread"]>,
    prompt: any,
    turnOptions: TurnOptions | undefined,
    signal?: AbortSignal,
  ): Promise<CodexSendResult> {
    // SDK 不支持 signal 参数，使用 Promise.race 实现中断
    const streamedPromise = thread.runStreamed(prompt, turnOptions);
    
    if (signal) {
      const abortPromise = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('用户中断了请求'));
        });
      });
      const streamed = await Promise.race([streamedPromise, abortPromise]);
      return this.processStreamedResult(streamed, signal);
    }
    
    const streamed = await streamedPromise;
    return this.processStreamedResult(streamed, signal);
  }

  private async processStreamedResult(
    streamed: Awaited<ReturnType<ReturnType<Codex["startThread"]>["runStreamed"]>>,
    _signal?: AbortSignal,
  ): Promise<CodexSendResult> {
    const aggregator = new StreamAggregator();

    try {
      for await (const event of streamed.events) {
        const mapped = mapThreadEventToAgentEvent(event);
        if (mapped) {
          this.emitEvent(mapped);
        }
        aggregator.consume(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitSynthetic("error", "事件流异常", message, "error");
      throw error;
    }

    const final = aggregator.final();
    if (final.error) {
      this.emitSynthetic("error", "执行失败", final.error.message, "turn.failed");
      throw final.error;
    }
    return {
      response: this.normalizeResponse(final.finalResponse ?? ""),
      usage: final.usage,
    };
  }

  private normalizeResponse(finalResponse: unknown): string {
    if (typeof finalResponse === "string") {
      return finalResponse;
    }
    if (finalResponse && typeof finalResponse === "object") {
      const candidate =
        (finalResponse as Record<string, unknown>).text ??
        (finalResponse as Record<string, unknown>).content ??
        (finalResponse as Record<string, unknown>).message;
      if (candidate) {
        return String(candidate);
      }
    }
    return JSON.stringify(finalResponse ?? "", null, 2);
  }

  async classifyInput(input: string): Promise<IntakeClassification> {
    this.ensureClient();
    if (!this.ready || !this.codex) {
      throw new Error(this.lastError ?? "未配置 Codex 凭证");
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return "unknown";
    }

    const prompt = [
      "你是一个分类器。",
      "请阅读用户输入，判断是否为需要启动开发工作流的任务需求。",
      "只能回答以下三种之一：",
      "task - 明确的任务或需求，应该创建工作流",
      "chat - 普通对话或不需要建档的请求",
      "unknown - 无法判断，需继续向用户确认",
      "请只输出上述关键字之一。",
      "",
      `用户输入: ${trimmed}`,
    ].join("\n");

    try {
      const thread = this.codex.startThread({ skipGitRepoCheck: true });
      const result = await thread.run(prompt);
      const normalized = this.normalizeResponse(result.finalResponse).trim().toLowerCase();
      const raw = normalized.split(/\s+/)[0] ?? "";
      if (raw === "task" || raw === "chat" || raw === "unknown") {
        return raw;
      }
      if (raw.includes("task")) {
        return "task";
      }
      if (raw.includes("chat")) {
        return "chat";
      }
      if (raw.includes("unknown")) {
        return "unknown";
      }
    } catch {
      // 忽略分类失败，回退为 unknown
    }
    return "unknown";
  }
}

class StreamAggregator {
  private finalResponse: unknown = "";
  private usage: Usage | null = null;
  private failure: Error | null = null;

  consume(event: ThreadEvent): void {
    switch (event.type) {
      case "item.completed":
        if (event.item.type === "agent_message") {
          this.finalResponse = event.item.text;
        }
        break;
      case "turn.completed":
        this.usage = event.usage;
        break;
      case "turn.failed":
        this.failure = new Error(event.error.message);
        break;
      case "error":
        this.failure = new Error(event.message);
        break;
      default:
        break;
    }
  }

  final(): { finalResponse: unknown; usage: Usage | null; error: Error | null } {
    return {
      finalResponse: this.finalResponse,
      usage: this.usage,
      error: this.failure,
    };
  }
}
