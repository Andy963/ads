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
import { runCli, runCliRaw } from "../cli/cliRunner.js";
import { GeminiStreamParser } from "../cli/geminiStreamParser.js";
import { createLogger } from "../../utils/logger.js";
import { extractTextFromInput } from "../../utils/inputText.js";
import { createAbortError } from "../../utils/abort.js";

const logger = createLogger("GeminiCliAdapter");

export interface GeminiCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  sessionId?: string;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "gemini",
  name: "Gemini",
  vendor: "Google",
  capabilities: ["text", "images", "files", "commands"],
};

function parseSessionIndexList(output: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = String(output ?? "").split(/\r?\n/);
  const re = /^\s*(\d+)\.\s.*\[(.+)\]\s*$/;
  for (const line of lines) {
    const match = line.match(re);
    if (!match) continue;
    const idx = String(match[1] ?? "").trim();
    const sid = String(match[2] ?? "").trim();
    if (idx && sid) {
      map.set(sid, idx);
    }
  }
  return map;
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private workingDirectory?: string;
  private model?: string;
  private sessionId: string | null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: GeminiCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_GEMINI_BIN ?? "gemini";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model ?? process.env.ADS_GEMINI_MODEL;
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

  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    if (!options?.preserveSession) {
      this.reset();
    }
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
    if (!(lower.includes("gemini") || lower.startsWith("auto-gemini"))) {
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
    const prompt = extractTextFromInput(input, { trim: false });
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    const approvalMode = this.sandboxMode === "read-only" ? "default" : "yolo";
    const resumeIndex = this.sessionId ? await this.resolveResumeIndex(this.sessionId) : null;

    const args: string[] = ["--output-format", "stream-json", "--approval-mode", approvalMode, "--prompt", prompt];
    if (this.model) {
      args.push("--model", this.model);
    }
    if (resumeIndex) {
      args.push("--resume", resumeIndex);
    }

    const parser = new GeminiStreamParser();
    let sawTurnFailed = false;
    logger.info(`sending Gemini request session=${this.sessionId ?? "(new)"} approval=${approvalMode} resume=${resumeIndex ?? "(none)"}`);

    const result = await runCli(
      {
        binary: this.binary,
        args,
        cwd: this.workingDirectory,
        env: options?.env,
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
      const message = parser.getLastError() ?? (result.stderr.trim() || `gemini exited with code ${result.exitCode}`);
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

  private async resolveResumeIndex(sessionId: string): Promise<string | null> {
    const sid = sessionId.trim();
    if (!sid) return null;

    try {
      const result = await runCliRaw({
        binary: this.binary,
        args: ["--list-sessions"],
        cwd: this.workingDirectory,
      });
      if (result.exitCode !== 0) {
        return null;
      }
      const mapping = parseSessionIndexList(result.stdout);
      return mapping.get(sid) ?? null;
    } catch (error) {
      void error;
      return null;
    }
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
