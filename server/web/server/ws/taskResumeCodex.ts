import { runCli } from "../../../agents/cli/cliRunner.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

function normalizeSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

type ThreadEventLike = { type: string; error?: { message?: string }; message?: string };

function isThreadEventLike(payload: unknown): payload is ThreadEventLike {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const typeValue = (payload as { type?: unknown }).type;
  return typeof typeValue === "string" && typeValue.length > 0;
}

export function buildCodexResumeProbeArgs(args: {
  threadId: string;
  sandboxMode: ReturnType<SessionManager["getSandboxMode"]>;
}): string[] {
  const cliArgs: string[] = ["exec"];

  if (args.sandboxMode === "read-only") {
    cliArgs.push("--sandbox", "read-only");
  } else if (args.sandboxMode === "danger-full-access") {
    cliArgs.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    cliArgs.push("--full-auto");
  }

  cliArgs.push("--json", "--skip-git-repo-check", "resume", args.threadId, "-");
  return cliArgs;
}

export async function assertCodexThreadResumable(args: {
  threadId: string;
  cwd: string;
  sandboxMode: ReturnType<SessionManager["getSandboxMode"]>;
  env: NodeJS.ProcessEnv | undefined;
}): Promise<void> {
  const threadId = args.threadId.trim();
  if (!threadId) {
    throw new Error("empty thread id");
  }

  const binary = process.env.ADS_CODEX_BIN ?? "codex";
  const cliArgs = buildCodexResumeProbeArgs({
    threadId,
    sandboxMode: args.sandboxMode,
  });

  let sawTurnFailed = false;
  let lastError: string | null = null;

  const result = await runCli(
    {
      binary,
      args: cliArgs,
      cwd: args.cwd,
      env: normalizeSpawnEnv(args.env),
      stdinData: "Reply with exactly OK. Do not run any tools.\n",
    },
    (parsed) => {
      if (!isThreadEventLike(parsed)) {
        return;
      }
      if (parsed.type === "turn.failed") {
        sawTurnFailed = true;
        const message = parsed.error?.message;
        if (typeof message === "string" && message.trim()) {
          lastError = message.trim();
        }
      }
      if (parsed.type === "error") {
        const message = parsed.message;
        if (typeof message === "string" && message.trim()) {
          lastError = message.trim();
        }
      }
    },
  );

  if (result.exitCode !== 0 || sawTurnFailed) {
    const stderr = result.stderr.trim();
    const message = lastError ?? (stderr || `codex exited with code ${result.exitCode}`);
    throw new Error(message);
  }
}
