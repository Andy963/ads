import type { Input } from "../protocol/types.js";
import type {
  AgentAdapter,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "../types.js";
import type { AgentEvent } from "../../codex/events.js";
import { runCli, runCliRaw } from "../cli/cliRunner.js";
import { AmpStreamParser } from "../cli/ampStreamParser.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("AmpCliAdapter");

export type AmpPermissions = "full-access" | "read-only";

export interface AmpCliAdapterOptions {
  binary?: string;
  mode?: string;
  permissions?: AmpPermissions;
  workingDirectory?: string;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "amp",
  name: "Amp",
  vendor: "Sourcegraph",
  capabilities: ["text", "images", "files", "commands"],
};

function inputToString(input: Input): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  }
  return String(input ?? "");
}

export class AmpCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private binary: string;
  private mode: string;
  private permissions: AmpPermissions;
  private workingDirectory?: string;
  private threadId: string | null = null;
  private warnedRushStreamJsonFallback = false;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: AmpCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_AMP_BIN ?? "amp";
    this.mode = options.mode ?? process.env.ADS_AMP_MODE ?? "smart";
    this.permissions = options.permissions ?? "full-access";
    this.workingDirectory = options.workingDirectory;
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

  getStreamingConfig(): { enabled: boolean; throttleMs: number } {
    return { enabled: true, throttleMs: 200 };
  }

  status(): AgentStatus {
    return { ready: true, streaming: true };
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  reset(): void {
    this.threadId = null;
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    this.reset();
  }

  setModel(_model?: string): void {
    // Amp 的 model 通过 --mode 控制，不支持动态切换
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = inputToString(input);
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    if (!this.threadId) {
      this.threadId = await this.createThread();
    }

    const args = this.buildArgs(prompt);
    const parser = new AmpStreamParser();
    let sawTurnFailed = false;

    logger.info(`发送 Amp 请求 thread=${this.threadId} mode=${this.mode}`);

    const result = await runCli(
      {
        binary: this.binary,
        args,
        cwd: this.workingDirectory,
        stdinData: "\n",
        signal: options?.signal,
      },
      (parsed) => {
        for (const event of parser.parseLine(parsed)) {
          if (event.raw?.type === "turn.failed") {
            sawTurnFailed = true;
          }
          this.emitEvent(event);
        }
      },
    );

    if (result.cancelled) {
      const err = new Error("用户中断了请求");
      err.name = "AbortError";
      throw err;
    }

    if (result.exitCode !== 0 || sawTurnFailed) {
      const message =
        parser.getLastError() ??
        (result.stderr.trim() ||
          (sawTurnFailed ? "amp reported failure" : `amp exited with code ${result.exitCode}`));
      logger.warn(`Amp 执行失败: ${message}`);
      throw new Error(message);
    }

    if (parser.getSessionId() && !this.threadId) {
      this.threadId = parser.getSessionId();
    }

    return {
      response: parser.getFinalMessage(),
      usage: null,
      agentId: this.id,
    };
  }

  private buildArgs(prompt: string): string[] {
    const requestedMode = this.mode.trim();
    const requestedModeLower = requestedMode.toLowerCase();
    const effectiveMode = requestedModeLower === "rush" ? "smart" : requestedMode;
    const args = [
      "--no-notifications",
      "--no-ide",
      "--no-jetbrains",
    ];
    if (this.permissions === "full-access") {
      args.push("--dangerously-allow-all");
    }
    if (effectiveMode) {
      if (requestedModeLower === "rush" && !this.warnedRushStreamJsonFallback) {
        this.warnedRushStreamJsonFallback = true;
        logger.warn("Amp stream-json is not permitted with 'rush' mode; falling back to 'smart'.");
      }
      args.push("--mode", effectiveMode);
    }
    args.push(
      "threads", "continue", this.threadId!,
      "--execute", prompt,
      "--stream-json",
    );
    return args;
  }

  private async createThread(): Promise<string> {
    const args = [
      "--no-notifications",
      "--no-ide",
      "--no-jetbrains",
    ];
    const requestedMode = this.mode.trim();
    const requestedModeLower = requestedMode.toLowerCase();
    const effectiveMode = requestedModeLower === "rush" ? "smart" : requestedMode;
    if (effectiveMode) {
      args.push("--mode", effectiveMode);
    }
    args.push("threads", "new");

    logger.debug("创建新 Amp 线程");
    const result = await runCliRaw({
      binary: this.binary,
      args,
      cwd: this.workingDirectory,
    });

    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || `amp threads new failed (exit ${result.exitCode})`;
      throw new Error(message);
    }

    const id = result.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!id) {
      throw new Error("amp threads new 返回了空的 thread ID");
    }

    logger.info(`创建 Amp 线程: ${id}`);
    return id;
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        logger.warn("事件回调异常", err);
      }
    }
  }
}
