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
import { extractTextFromInput } from "../../utils/inputText.js";
import { createAbortError } from "../../utils/abort.js";

const logger = createLogger("ClaudeCliAdapter");
const CLAUDE_UNSET_ENV = ["CLAUDECODE"];

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

export class ClaudeCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private workingDirectory?: string;
  private model?: string;
  private sessionId: string | null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private sendChain: Promise<void> = Promise.resolve();
  private pendingSends = 0;
  private pendingReset = false;

  constructor(options: ClaudeCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_CLAUDE_BIN ?? "claude";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model ?? process.env.ADS_CLAUDE_MODEL;
    this.sessionId = options.sessionId?.trim() || null;
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
    if (this.pendingSends > 0) {
      this.pendingReset = true;
      return;
    }
    this.sessionId = null;
  }

  setWorkingDirectory(workingDirectory?: string): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    this.reset();
  }

  setModel(model?: string): void {
    const normalized = String(model ?? "").trim();
    if (!normalized) {
      if (!this.model) return;
      this.model = undefined;
      this.reset();
      return;
    }
    const lower = normalized.toLowerCase();
    if (!(lower.startsWith("claude") || lower === "sonnet" || lower === "opus" || lower === "haiku")) {
      return;
    }
    if (this.model === normalized) return;
    this.model = normalized;
    this.reset();
  }

  getThreadId(): string | null {
    return this.sessionId;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    this.pendingSends += 1;

    const run = this.sendChain.then(async () => {
      if (this.pendingReset) {
        this.pendingReset = false;
        this.sessionId = null;
      }
      return await this.sendInner(input, options);
    });

    this.sendChain = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pendingSends -= 1;
      });

    return await run;
  }

  private async sendInner(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = extractTextFromInput(input, { trim: false });
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    const permissionMode = this.sandboxMode === "read-only" ? "plan" : "bypassPermissions";
    const sessionId = this.sessionId;
    const args: string[] = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      permissionMode,
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push(prompt);

    const parser = new ClaudeStreamParser();
    let sawTurnFailed = false;
    logger.info(`sending Claude request session=${sessionId ?? "(new)"} mode=${permissionMode}`);

    const result = await runCli(
      {
        binary: this.binary,
        args,
        cwd: this.workingDirectory,
        env: options?.env,
        unsetEnv: CLAUDE_UNSET_ENV,
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
      throw createAbortError("用户中断了请求");
    }

    if (result.exitCode !== 0 || sawTurnFailed) {
      const message = parser.getLastError() ?? (result.stderr.trim() || `claude exited with code ${result.exitCode}`);
      throw new Error(message);
    }

    const nextSessionId = parser.getSessionId();
    if (nextSessionId && nextSessionId.trim()) {
      this.sessionId = nextSessionId.trim();
    } else if (!this.sessionId) {
      logger.warn("Claude CLI did not provide a session id; multi-turn resume will be unavailable");
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
