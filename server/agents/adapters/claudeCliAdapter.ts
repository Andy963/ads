import type { Input } from "../protocol/types.js";

import path from "node:path";

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
import {
  createTransientModelRetryEvent,
  isTransientUpstreamModelError,
  TransientModelRetryAttemptError,
  runWithTransientModelRetry,
  type RetryAttemptState,
} from "./transientModelRetry.js";

const logger = createLogger("ClaudeCliAdapter");
const CLAUDE_UNSET_ENV = ["CLAUDECODE"];
const DEFAULT_IMAGE_ONLY_PROMPT = "Please respond based on the attached image(s).";
const EMPTY_RESPONSE_ERROR = "Claude CLI 成功退出但未返回最终消息";
const CLAUDE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeClaudeReasoningEffort(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CLAUDE_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function extractLocalImagePaths(input: Input): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((part): part is { type: "local_image"; path: string } => part.type === "local_image")
    .map((part) => part.path)
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = String(item ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function appendImageReferencesToPrompt(args: { prompt: string; imagePaths: string[] }): string {
  const imagePaths = uniq(args.imagePaths);
  if (imagePaths.length === 0) return args.prompt;

  const hasText = args.prompt.trim().length > 0;
  const basePrompt = hasText ? args.prompt : DEFAULT_IMAGE_ONLY_PROMPT;
  const lines = imagePaths.map((p) => `- @${p}`);
  return `${basePrompt}\n\nAttached images (local paths):\n${lines.join("\n")}\n`;
}

function resolveClaudeModelForCli(
  model: string,
  options?: { enable1mContext?: boolean; disable1mContext?: boolean },
): string {
  const normalized = String(model ?? "").trim();
  if (!normalized || options?.disable1mContext) return normalized;
  if (options?.enable1mContext !== true) return normalized;
  const lower = normalized.toLowerCase();
  if (lower.includes("[1m]")) return normalized;
  if (/^claude-(sonnet|opus)-4-[67](?:\b|$)/.test(lower)) {
    return `${normalized}[1m]`;
  }
  return normalized;
}

function summarizeStderr(stderr: string, maxLength = 200): string {
  const normalized = String(stderr ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildFailureMessage(args: {
  parserError: string | null;
  finalMessage: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): string {
  const parserError = String(args.parserError ?? "").trim();
  if (parserError) return parserError;
  const stderr = String(args.stderr ?? "").trim();
  if (stderr) return stderr;
  const finalMessage = String(args.finalMessage ?? "").trim();
  if (finalMessage) return finalMessage;
  const stdout = String(args.stdout ?? "").trim();
  if (stdout) return stdout;
  return `claude exited with code ${args.exitCode}`;
}

export interface ClaudeCliAdapterOptions {
  binary?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
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
  private modelReasoningEffort?: string;
  private betas: string[] = [];
  private enable1mContext = false;
  private disable1mContext = false;
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
    this.modelReasoningEffort = normalizeClaudeReasoningEffort(options.modelReasoningEffort);
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
    if (!(lower.startsWith("claude") || lower === "sonnet" || lower === "opus" || lower === "haiku")) {
      return;
    }
    if (this.model === normalized) return;
    this.model = normalized;
    this.reset();
  }

  setModelReasoningEffort(effort?: string): void {
    const next = normalizeClaudeReasoningEffort(effort);
    if (this.modelReasoningEffort === next) return;
    this.modelReasoningEffort = next;
  }

  setModelConfig(config?: Record<string, unknown> | null): void {
    const cfg = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const rawBetas = cfg.betas;
    const betas = Array.isArray(rawBetas)
      ? rawBetas.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    const enable1mContext = cfg.enable1mContext === true;
    const disable1mContext = cfg.disable1mContext === true;
    if (
      this.enable1mContext === enable1mContext &&
      this.disable1mContext === disable1mContext &&
      this.betas.length === betas.length &&
      this.betas.every((entry, index) => entry === betas[index])
    ) {
      return;
    }
    this.betas = betas;
    this.enable1mContext = enable1mContext;
    this.disable1mContext = disable1mContext;
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
    const imagePaths = extractLocalImagePaths(input);
    const promptWithImages = appendImageReferencesToPrompt({ prompt, imagePaths });
    if (!promptWithImages.trim()) {
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
      args.push(
        "--model",
        resolveClaudeModelForCli(this.model, {
          enable1mContext: this.enable1mContext,
          disable1mContext: this.disable1mContext,
        }),
      );
    }
    if (this.modelReasoningEffort) {
      args.push("--effort", this.modelReasoningEffort);
    }
    if (this.betas.length > 0) {
      args.push("--betas", ...this.betas);
    }
    if (imagePaths.length > 0) {
      const dirs = uniq(imagePaths.map((p) => path.dirname(p)));
      if (dirs.length > 0) {
        args.push("--add-dir", ...dirs);
      }
    }
    args.push(promptWithImages);

    const runAttempt = async (retryState: RetryAttemptState): Promise<AgentRunResult> => {
      const parser = new ClaudeStreamParser();
      let sawTurnFailed = false;
      let sawTerminalResult = false;
      let resumedPromptAccepted = false;
      logger.info(
        `sending Claude request session=${sessionId ?? "(new)"} mode=${permissionMode} attempt=${retryState.attempt}`,
      );

      const buildAttemptError = (message: string): Error => {
        if (sessionId && resumedPromptAccepted && isTransientUpstreamModelError(message)) {
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
          args,
          cwd: this.workingDirectory,
          env: options?.env,
          unsetEnv: CLAUDE_UNSET_ENV,
          stdinData: "\n",
          signal: options?.signal,
          // The CLI prints its terminal `result` line and then may keep the
          // stdout pipe open via a lingering MCP/tool grandchild, which would
          // otherwise stall runCli until the 30-minute hard timeout. Signal
          // completion on the result line so the runner ends the turn promptly.
          isRunComplete: () => sawTerminalResult,
        },
        (parsed) => {
          if ((parsed as { type?: unknown } | null)?.type === "result") {
            sawTerminalResult = true;
          }
          for (const event of parser.parseLine(parsed)) {
            if (sessionId && (event.phase === "boot" || event.phase === "analysis" || event.phase === "responding")) {
              resumedPromptAccepted = true;
            }
            retryState.markSideEffect(event);
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

      const finalMessage = parser.getFinalMessage();
      const hasFinalMessage = finalMessage.length > 0;
      const stderrSummary = summarizeStderr(result.stderr);

      // A non-zero exit code is only meaningful when the CLI never reached its
      // terminal result: once the result line arrived (and wasn't a failure),
      // the exit code merely reflects how the lingering process was reaped
      // (post-completion grace kill, hard timeout, cleanup crash).
      const turnDeliveredResult = sawTerminalResult && !sawTurnFailed;
      const exitIndicatesFailure =
        result.exitCode !== 0 && !result.terminatedAfterCompletion && !turnDeliveredResult;

      if (exitIndicatesFailure || sawTurnFailed) {
        logger.warn(
          `[Claude CLI] request failed session=${sessionId ?? "(new)"} exitCode=${result.exitCode ?? "null"} stderr=${JSON.stringify(stderrSummary)} hasFinalMessage=${hasFinalMessage}`,
        );
        const message = buildFailureMessage({
          parserError: parser.getLastError(),
          finalMessage,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
        throw buildAttemptError(message);
      }

      const nextSessionId = parser.getSessionId();
      if (nextSessionId && nextSessionId.trim()) {
        this.sessionId = nextSessionId.trim();
      } else if (!this.sessionId) {
        logger.warn("Claude CLI did not provide a session id; multi-turn resume will be unavailable");
      }

      if (!hasFinalMessage) {
        const parserError = parser.getLastError();
        if (parserError) {
          logger.warn(
            `[Claude CLI] request completed with stream error session=${sessionId ?? "(new)"} exitCode=${result.exitCode ?? "null"} stderr=${JSON.stringify(stderrSummary)} hasFinalMessage=${hasFinalMessage}`,
          );
          throw buildAttemptError(parserError);
        }
        logger.warn(
          `[Claude CLI] request completed without final message session=${sessionId ?? "(new)"} exitCode=${result.exitCode ?? "null"} stderr=${JSON.stringify(stderrSummary)} hasFinalMessage=${hasFinalMessage}`,
        );
        throw new Error(stderrSummary === "(empty)" ? EMPTY_RESPONSE_ERROR : `${EMPTY_RESPONSE_ERROR}（stderr: ${stderrSummary}）`);
      }

      logger.info(
        `[Claude CLI] request completed session=${sessionId ?? "(new)"} exitCode=${result.exitCode ?? "null"} stderr=${JSON.stringify(stderrSummary)} hasFinalMessage=${hasFinalMessage}`,
      );

      return {
        response: finalMessage,
        usage: null,
        agentId: this.id,
      };
    };

    return await runWithTransientModelRetry(
      {
        agentName: "Claude CLI",
        signal: options?.signal,
        log: (message) => logger.warn(message),
        onRetry: (notice) => this.emitEvent(createTransientModelRetryEvent(notice)),
      },
      runAttempt,
    );
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
