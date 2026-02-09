import path from "node:path";

import type { Input, ThreadEvent } from "../agents/protocol/types.js";
import type { Usage } from "../agents/protocol/types.js";
import { getExecAllowlistFromEnv } from "../utils/commandRunner.js";
import { runCli } from "../agents/cli/cliRunner.js";
import type { BootstrapSandbox } from "./sandbox.js";

export type BootstrapAgentFeedback = {
  iteration: number;
  lintSummary: string;
  testSummary: string;
  diffSummary: string;
};

export interface BootstrapAgentRunner {
  reset(): void | Promise<void>;
  runIteration(args: { iteration: number; goal: string; cwd: string; feedback: BootstrapAgentFeedback | null; signal?: AbortSignal }): Promise<{
    response: string;
    usage: Usage | null;
  }>;
}

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

function inputToPrompt(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return String(input ?? "");
  }
  return input
    .map((part) => {
      const current = part as { type?: string; text?: string };
      if (current.type === "text" && typeof current.text === "string") {
        return current.text;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function buildBootstrapPrompt(args: { goal: string; feedback: BootstrapAgentFeedback | null }): string {
  const parts: string[] = [];
  parts.push("You are running in a sandboxed git worktree.");
  parts.push("Definition of Done: lint and test must pass.");
  parts.push("");
  parts.push("Goal:");
  parts.push(args.goal.trim());
  if (args.feedback) {
    parts.push("");
    parts.push(`Previous iteration feedback (iteration ${args.feedback.iteration}):`);
    if (args.feedback.diffSummary.trim()) {
      parts.push("");
      parts.push("Diff summary:");
      parts.push(args.feedback.diffSummary.trim());
    }
    if (args.feedback.lintSummary.trim()) {
      parts.push("");
      parts.push("Lint summary:");
      parts.push(args.feedback.lintSummary.trim());
    }
    if (args.feedback.testSummary.trim()) {
      parts.push("");
      parts.push("Test summary:");
      parts.push(args.feedback.testSummary.trim());
    }
  }
  parts.push("");
  parts.push("Please fix the issues and update the code. Do not run git push.");
  return parts.join("\n").trim() + "\n";
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function assertAllowlisted(cmd: string, allowlist: string[] | null): void {
  if (!allowlist) {
    return;
  }
  if (hasPathSeparator(cmd)) {
    throw new Error(`command path is not allowed when allowlist is enabled: ${cmd}`);
  }
  const executable = path.basename(cmd).toLowerCase();
  if (!allowlist.includes(executable)) {
    throw new Error(`command not allowed: ${executable}`);
  }
}

export class CodexBootstrapAgentRunner implements BootstrapAgentRunner {
  private readonly sandbox: BootstrapSandbox;
  private readonly binary: string;
  private readonly model?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private threadId: string | null = null;

  constructor(options: { sandbox: BootstrapSandbox; binary?: string; model?: string; env?: NodeJS.ProcessEnv }) {
    this.sandbox = options.sandbox;
    this.binary = options.binary ?? process.env.ADS_CODEX_BIN ?? "codex";
    this.model = options.model;
    this.env = options.env;
  }

  reset(): void {
    this.threadId = null;
  }

  async runIteration(args: { iteration: number; goal: string; cwd: string; feedback: BootstrapAgentFeedback | null; signal?: AbortSignal }): Promise<{ response: string; usage: Usage | null }> {
    const prompt = buildBootstrapPrompt({ goal: args.goal, feedback: args.feedback });
    const allowlist = getExecAllowlistFromEnv(this.env ?? process.env);
    assertAllowlisted(this.binary, allowlist);

    const useResume = Boolean(this.threadId);
    const codexArgs: string[] = ["exec"];
    if (useResume) {
      codexArgs.push("resume");
    }
    codexArgs.push("--full-auto", "--json", "--skip-git-repo-check");
    if (this.model) {
      codexArgs.push("--model", this.model);
    }
    if (useResume) {
      codexArgs.push(this.threadId!, "-");
    } else {
      codexArgs.push("-");
    }

    const spawn = this.sandbox.wrapSpawn({ cmd: this.binary, args: codexArgs, cwd: args.cwd, env: this.env });
    assertAllowlisted(spawn.cmd, allowlist);

    let nextThreadId: string | null = null;
    let responseText = "";
    let usage: Usage | null = null;
    let streamError: string | null = null;
    let sawTurnFailed = false;

    const result = await runCli(
      {
        binary: spawn.cmd,
        args: spawn.args,
        cwd: spawn.cwd,
        env: spawn.env ? Object.fromEntries(Object.entries(spawn.env).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined,
        stdinData: `${inputToPrompt(prompt)}\n`,
        signal: args.signal,
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
      },
    );

    if (result.cancelled) {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    }

    if (result.exitCode !== 0 || sawTurnFailed) {
      const message = streamError ?? (result.stderr.trim() || (sawTurnFailed ? "codex reported failure" : `codex exited with code ${result.exitCode}`));
      throw new Error(message);
    }

    if (nextThreadId && nextThreadId !== this.threadId) {
      this.threadId = nextThreadId;
    }

    return { response: responseText.trim(), usage };
  }
}
