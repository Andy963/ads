import type { Input, ThreadEvent, Usage } from "../protocol/types.js";

import type {
  AgentAdapter,
  AgentMetadata,
  AgentRunResult,
  AgentSendOptions,
  AgentStatus,
} from "../types.js";
import type { AgentEvent } from "../../codex/events.js";
import { mapThreadEventToAgentEvent } from "../../codex/events.js";
import type { SandboxMode } from "../../telegram/config.js";
import { runCli } from "../cli/cliRunner.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("CodexCliAdapter");
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);

export interface CodexCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  resumeThreadId?: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "codex",
  name: "Codex",
  vendor: "OpenAI",
  capabilities: ["text", "images", "files", "commands"],
};

function normalizeSpawnEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function inputToPromptAndImages(input: Input): { prompt: string; images: string[] } {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }
  if (!Array.isArray(input)) {
    return { prompt: String(input ?? ""), images: [] };
  }

  const promptParts: string[] = [];
  const images: string[] = [];

  for (const part of input) {
    const current = part as { type?: string; text?: string; path?: string };
    if (current.type === "text" && typeof current.text === "string") {
      promptParts.push(current.text);
      continue;
    }
    if (current.type === "local_image" && typeof current.path === "string") {
      images.push(current.path);
    }
  }

  const prompt = promptParts.join("\n").trim();
  if (prompt) {
    return { prompt, images };
  }
  if (images.length > 0) {
    return { prompt: "Please respond based on the attached image(s).", images };
  }
  return { prompt: "", images };
}

function isThreadEvent(payload: unknown): payload is ThreadEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const typeValue = (payload as { type?: unknown }).type;
  if (typeof typeValue !== "string" || typeValue.length === 0) {
    return false;
  }
  if (!KNOWN_EVENT_TYPES.has(typeValue)) {
    return false;
  }
  if (typeValue.startsWith("item.")) {
    const itemValue = (payload as { item?: unknown }).item;
    if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) {
      return false;
    }
    const itemType = (itemValue as { type?: unknown }).type;
    return typeof itemType === "string" && itemType.length > 0;
  }
  return true;
}

export class CodexCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private spawnEnv?: NodeJS.ProcessEnv;
  private workingDirectory?: string;
  private model?: string;
  private threadId: string | null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(options: CodexCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_CODEX_BIN ?? "codex";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model;
    this.threadId = options.resumeThreadId?.trim() || null;
    this.spawnEnv = options.env;
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

  setModel(model?: string): void {
    const normalized = String(model ?? "").trim();
    if (!normalized) {
      if (!this.model) return;
      this.model = undefined;
      this.reset();
      return;
    }
    const lower = normalized.toLowerCase();
    if (
      lower.startsWith("gemini") ||
      lower.startsWith("auto-gemini") ||
      lower.includes("gemini") ||
      lower.startsWith("claude") ||
      lower === "sonnet" ||
      lower === "opus" ||
      lower === "haiku"
    ) {
      return;
    }
    if (this.model === normalized) return;
    this.model = normalized;
    this.reset();
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  async send(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const { prompt, images } = inputToPromptAndImages(input);
    if (!prompt.trim()) {
      throw new Error("Prompt 不能为空");
    }

    const useResume = Boolean(this.threadId) && options?.outputSchema === undefined;
    const args = this.buildArgs({ images, useResume });
    const spawnEnv = normalizeSpawnEnv(this.spawnEnv);

    let nextThreadId: string | null = null;
    let responseText = "";
    let usage: Usage | null = null;
    let streamError: string | null = null;
    let sawTurnFailed = false;

    const result = await runCli(
      {
        binary: this.binary,
        args: useResume ? [...args, this.threadId!, "-"] : [...args, "-"],
        cwd: this.workingDirectory,
        env: spawnEnv,
        stdinData: `${prompt}\n`,
        signal: options?.signal,
      },
      (parsed) => {
        if (!isThreadEvent(parsed)) {
          return;
        }
        const event = parsed;

        if (event.type === "thread.started") {
          const id = (event as { thread_id?: unknown }).thread_id;
          if (typeof id === "string" && id.trim()) {
            nextThreadId = id.trim();
          }
        }

        if (event.type === "error") {
          const msg = (event as { message?: unknown }).message;
          if (typeof msg === "string" && msg.trim()) {
            streamError = msg.trim();
          }
        }

        if (event.type === "turn.failed") {
          sawTurnFailed = true;
          const msg = (event as { error?: { message?: unknown } }).error?.message;
          if (typeof msg === "string" && msg.trim()) {
            streamError = msg.trim();
          }
        }

        if (event.type === "turn.completed") {
          const maybeUsage = (event as { usage?: unknown }).usage;
          if (maybeUsage && typeof maybeUsage === "object") {
            usage = maybeUsage as Usage;
          }
        }

        if (event.type === "item.updated" || event.type === "item.completed") {
          const item = (event as { item?: { type?: unknown; text?: unknown } }).item;
          if (item && item.type === "agent_message" && typeof item.text === "string") {
            responseText = item.text;
          }
        }

        const mapped = mapThreadEventToAgentEvent(event, Date.now());
        if (mapped) {
          this.emitEvent(mapped);
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
        streamError ??
        (result.stderr.trim() ||
          (sawTurnFailed ? "codex reported failure" : `codex exited with code ${result.exitCode}`));
      throw new Error(message);
    }

    if (nextThreadId && nextThreadId !== this.threadId) {
      this.threadId = nextThreadId;
    }

    return {
      response: responseText.trim(),
      usage,
      agentId: this.id,
    };
  }

  private buildArgs(options: { images: string[]; useResume: boolean }): string[] {
    const args: string[] = ["exec"];
    if (options.useResume) {
      args.push("resume");
    }

    if (!options.useResume) {
      if (this.workingDirectory) {
        args.push("--cd", this.workingDirectory);
      }
      if (this.sandboxMode === "read-only") {
        args.push("--sandbox", "read-only");
      } else if (this.sandboxMode === "danger-full-access") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("--full-auto");
      }
    } else {
      if (this.sandboxMode === "danger-full-access") {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else if (this.sandboxMode !== "read-only") {
        args.push("--full-auto");
      }
    }

    args.push("--json", "--skip-git-repo-check");
    if (this.model) {
      args.push("--model", this.model);
    }
    for (const imagePath of options.images) {
      args.push("--image", imagePath);
    }
    return args;
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
