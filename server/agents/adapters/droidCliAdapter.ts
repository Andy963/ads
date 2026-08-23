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
import { createAbortError, isAbortError } from "../../utils/abort.js";
import {
  createTransientModelRetryEvent,
  isTransientUpstreamModelError,
  runWithTransientModelRetry,
  TransientModelRetryAttemptError,
  type RetryAttemptState,
} from "./transientModelRetry.js";
import {
  createProviderSessionFallbackEvent,
  isMissingProviderSessionError,
} from "./missingProviderSession.js";

const logger = createLogger("DroidCliAdapter");
const EMPTY_RESPONSE_ERROR = "Droid CLI 成功退出但未返回最终消息";

export interface DroidCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  metadata?: Partial<AgentMetadata>;
}

const DEFAULT_METADATA: AgentMetadata = {
  id: "droid",
  name: "Droid",
  vendor: "Factory",
  capabilities: ["text", "images", "files", "commands"],
};

function resolveAutoMode(sandboxMode: SandboxMode): "medium" | "high" | null {
  if (sandboxMode === "read-only") return null;
  if (sandboxMode === "danger-full-access") return "high";
  return "medium";
}

function normalizeSpawnEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") normalized[key] = value;
  }
  return normalized;
}

function inputToPrompt(input: Input): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return String(input ?? "");

  const text = input
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const images = input
    .filter((part): part is { type: "local_image"; path: string } => part.type === "local_image" && typeof part.path === "string")
    .map((part) => part.path.trim())
    .filter(Boolean);

  if (images.length === 0) return text;
  const prompt = text.trim() || "Please respond based on the attached image(s).";
  return `${prompt}\n\nAttached images (local paths):\n${images.map((image) => `- ${image}`).join("\n")}\n`;
}

function isResumeModelMismatchError(message: string): boolean {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (!normalized.includes("model")) return false;
  if (!(normalized.includes("session") || normalized.includes("resume") || normalized.includes("different"))) return false;
  return (
    normalized.includes("mismatch") ||
    normalized.includes("different") ||
    normalized.includes("must match") ||
    normalized.includes("same model") ||
    normalized.includes("created with") ||
    normalized.includes("does not match") ||
    normalized.includes("doesn't match")
  );
}

export class DroidCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly metadata: AgentMetadata;

  private readonly binary: string;
  private readonly sandboxMode: SandboxMode;
  private spawnEnv?: NodeJS.ProcessEnv;
  private workingDirectory?: string;
  private model?: string;
  private modelReasoningEffort?: string;
  private sessionId: string | null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private sendChain: Promise<void> = Promise.resolve();
  private pendingSends = 0;
  private pendingReset = false;

  constructor(options: DroidCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.ADS_DROID_BIN ?? "droid";
    this.sandboxMode = options.sandboxMode ?? "workspace-write";
    this.workingDirectory = options.workingDirectory;
    this.model = options.model;
    this.modelReasoningEffort = options.modelReasoningEffort;
    this.sessionId = options.sessionId?.trim() || null;
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

  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void {
    if (this.workingDirectory === workingDirectory) return;
    this.workingDirectory = workingDirectory;
    if (!options?.preserveSession) this.reset();
  }

  setModel(model?: string): void {
    const next = String(model ?? "").trim() || undefined;
    if (this.model === next) return;
    this.model = next;
    // Droid exposes models from multiple providers, so model-name filtering
    // would incorrectly reject a valid model selected by ADS's UI.
    this.reset();
  }

  setModelReasoningEffort(effort?: string): void {
    const next = String(effort ?? "").trim() || undefined;
    if (this.modelReasoningEffort === next) return;
    this.modelReasoningEffort = next;
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
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.pendingSends -= 1;
      });
    return await run;
  }

  private async sendInner(input: Input, options?: AgentSendOptions): Promise<AgentRunResult> {
    const prompt = inputToPrompt(input);
    if (!prompt.trim()) throw new Error("Prompt 不能为空");

    const shouldResume = Boolean(this.sessionId) && options?.outputSchema === undefined;
    const mergedEnv: NodeJS.ProcessEnv | undefined = (() => {
      if (!options?.env || Object.keys(options.env).length === 0) return this.spawnEnv;
      return { ...(this.spawnEnv ?? {}), ...options.env };
    })();
    const spawnEnv = normalizeSpawnEnv(mergedEnv);

    const runAttempt = async (useResume: boolean, retryState: RetryAttemptState): Promise<AgentRunResult> => {
      const parser = new DroidStreamParser();
      let sawTerminalTurn = false;
      let sawTurnFailed = false;
      let streamError: string | null = null;
      let resumedPromptAccepted = false;
      const args = this.buildArgs(useResume);
      const autoMode = resolveAutoMode(this.sandboxMode);
      logger.info(
        `sending Droid request session=${useResume ? this.sessionId : "(new)"} auto=${autoMode ?? "(manual)"} attempt=${retryState.attempt}`,
      );

      const buildAttemptError = (message: string): Error => {
        if (useResume && resumedPromptAccepted && isTransientUpstreamModelError(message)) {
          return new TransientModelRetryAttemptError(message, {
            retryable: true,
            sideEffectObserved: true,
          });
        }
        return new Error(message);
      };

      const result = await runCli(
        {
          binary: this.binary,
          args: [...args, prompt],
          cwd: this.workingDirectory,
          env: spawnEnv,
          stdinData: "\n",
          signal: options?.signal,
          isRunComplete: () => sawTerminalTurn,
        },
        (parsed) => {
          const events = parser.parseLine(parsed);
          for (const event of events) {
            if (
              useResume &&
              (event.phase === "boot" || event.phase === "analysis" || event.phase === "responding")
            ) {
              resumedPromptAccepted = true;
            }
            retryState.markSideEffect(event);
            if (event.raw.type === "turn.failed") {
              sawTurnFailed = true;
              sawTerminalTurn = true;
              streamError = parser.getLastError() ?? streamError;
            } else if (event.raw.type === "turn.completed") {
              sawTerminalTurn = true;
            } else if (event.raw.type === "error") {
              streamError = parser.getLastError() ?? streamError;
            }
            this.emitEvent(event);
          }
        },
      );

      if (result.cancelled) throw createAbortError("用户中断了请求");

      const turnDeliveredResult = sawTerminalTurn && !sawTurnFailed;
      const exitIndicatesFailure = result.exitCode !== 0 && !result.terminatedAfterCompletion && !turnDeliveredResult;
      if (exitIndicatesFailure || sawTurnFailed) {
        const fallbackOutput = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        const message =
          streamError ??
          parser.getLastError() ??
          (fallbackOutput ||
            (sawTurnFailed ? "droid reported failure" : `droid exited with code ${result.exitCode}`));
        throw buildAttemptError(message);
      }

      const nextSessionId = parser.getSessionId();
      if (nextSessionId) this.sessionId = nextSessionId;
      const response = parser.getFinalMessage();
      if (!response) {
        throw buildAttemptError(parser.getLastError() ?? (result.stderr.trim() || EMPTY_RESPONSE_ERROR));
      }
      return { response, usage: parser.getUsage(), agentId: this.id };
    };

    const driveAttempts = (useResume: boolean) =>
      runWithTransientModelRetry(
        {
          agentName: "Droid CLI",
          signal: options?.signal,
          log: (message) => logger.warn(message),
          onRetry: (notice) => this.emitEvent(createTransientModelRetryEvent(notice)),
        },
        (retryState) => runAttempt(useResume, retryState),
      );

    try {
      return await driveAttempts(shouldResume);
    } catch (error) {
      if (!shouldResume || isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (isResumeModelMismatchError(message) || !isMissingProviderSessionError(message)) throw error;

      const previousSessionId = this.sessionId ?? "";
      logger.warn(`Resume target missing (session=${previousSessionId || "null"}); retrying on a fresh session. cause=${message}`);
      this.sessionId = null;
      this.emitEvent(
        createProviderSessionFallbackEvent({
          agentName: "Droid CLI",
          previousSessionId,
          message,
        }),
      );
      return await driveAttempts(false);
    }
  }

  private buildArgs(useResume: boolean): string[] {
    const args = ["exec", "-o", "stream-json"];
    const autoMode = resolveAutoMode(this.sandboxMode);
    if (autoMode) args.push("--auto", autoMode);
    if (this.model) args.push("--model", this.model);
    if (this.modelReasoningEffort) args.push("--reasoning-effort", this.modelReasoningEffort);
    if (this.workingDirectory) args.push("--cwd", this.workingDirectory);
    if (useResume && this.sessionId) args.push("--session-id", this.sessionId);
    return args;
  }

  private emitEvent(event: AgentEvent): void {
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch (error) {
        logger.warn("event handler failed", error);
      }
    }
  }
}
