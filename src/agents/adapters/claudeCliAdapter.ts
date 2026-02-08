import crypto from "node:crypto";

import type { Input } from "../protocol/types.js";

import type {
  AgentAdapter,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "../types.js";
import type { AgentEvent } from "../../codex/events.js";
import type { SandboxMode } from "../../telegram/config.js";
import { runCli } from "../cli/cliRunner.js";
import { ClaudeStreamParser } from "../cli/claudeStreamParser.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("ClaudeCliAdapter");

export interface ClaudeCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  sessionId?: string;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "claude",
  name: "Claude Code",
  vendor: "Anthropic",
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

export class ClaudeCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private workingDirectory?: string;
  private model?: string;
  private sessionId: string;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: ClaudeCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_CLAUDE_BIN ?? "claude";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model ?? process.env.ADS_CLAUDE_MODEL;
    this.sessionId = options.sessionId?.trim() || crypto.randomUUID();
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
    this.sessionId = crypto.randomUUID();
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    this.reset();
  }

  setModel(model?: string): void {
    const normalized = String(model ?? "").trim();
    if (!normalized) {
      this.model = undefined;
      return;
    }
    const lower = normalized.toLowerCase();
    if (lower.startsWith("claude") || lower === "sonnet" || lower === "opus" || lower === "haiku") {
      this.model = normalized;
    }
  }

  getThreadId(): string | null {
    return this.sessionId;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = inputToString(input);
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    const permissionMode = this.sandboxMode === "read-only" ? "plan" : "bypassPermissions";
    const args: string[] = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      permissionMode,
      "--session-id",
      this.sessionId,
    ];
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push(prompt);

    const parser = new ClaudeStreamParser();
    let sawTurnFailed = false;
    logger.info(`sending Claude request session=${this.sessionId} mode=${permissionMode}`);

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
          const rawType = (event.raw as { type?: unknown } | undefined)?.type;
          if (rawType === "turn.failed") {
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
      const message = parser.getLastError() ?? (result.stderr.trim() || `claude exited with code ${result.exitCode}`);
      throw new Error(message);
    }

    return {
      response: parser.getFinalMessage(),
      usage: null,
      agentId: this.id,
    };
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (err) {
        logger.warn("event handler failed", err);
      }
    }
  }
}
