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
import { DroidStreamParser } from "../cli/droidStreamParser.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("DroidCliAdapter");

export interface DroidCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  sessionId?: string;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "droid",
  name: "Droid",
  vendor: "Factory",
  capabilities: ["text", "files", "commands"],
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

function resolveAutonomyFlag(sandboxMode: SandboxMode): string[] {
  if (sandboxMode === "read-only") {
    return [];
  }
  if (sandboxMode === "danger-full-access") {
    return ["--skip-permissions-unsafe"];
  }
  return ["--auto", "medium"];
}

export class DroidCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private workingDirectory?: string;
  private model?: string;
  private sessionId: string | null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: DroidCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_DROID_BIN ?? "droid";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model ?? process.env.ADS_DROID_MODEL;
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
      this.model = undefined;
      return;
    }
    this.model = normalized;
  }

  getThreadId(): string | null {
    return this.sessionId;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = inputToString(input);
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    const args: string[] = [];
    if (this.sessionId) {
      // droid exec --session-id appears to fail silently in some environments; use the global resume flag instead.
      args.push("--resume", this.sessionId);
    }
    args.push(
      "exec",
      "--output-format",
      "stream-json",
      ...resolveAutonomyFlag(this.sandboxMode),
    );
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.workingDirectory) {
      args.push("--cwd", this.workingDirectory);
    }

    const parser = new DroidStreamParser();
    logger.info(`sending Droid request resume=${this.sessionId ?? "(new)"} auto=${resolveAutonomyFlag(this.sandboxMode).join(" ") || "(default)"}`);

    const result = await runCli(
      {
        binary: this.binary,
        args,
        cwd: this.workingDirectory,
        stdinData: `${prompt}\n`,
        signal: options?.signal,
      },
      (parsed) => {
        for (const event of parser.parseLine(parsed)) {
          this.emitEvent(event);
        }
      },
    );

    if (result.cancelled) {
      const err = new Error("用户中断了请求");
      err.name = "AbortError";
      throw err;
    }

    if (result.exitCode !== 0) {
      const message = parser.getLastError() ?? (result.stderr.trim() || `droid exited with code ${result.exitCode}`);
      throw new Error(message);
    }

    const next = parser.getSessionId();
    if (next && next.trim()) {
      this.sessionId = next.trim();
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
