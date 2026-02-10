import type { Input, InputTextPart, ThreadEvent } from "../../../agents/protocol/types.js";

import fs from "node:fs";
import path from "node:path";

import type { AgentEvent } from "../../../codex/events.js";
import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import { parseSlashCommand } from "../../../codexConfig.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { extractTextFromInput } from "../../../utils/inputText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import type { SearchParams } from "../../../tools/search/types.js";
import { SearchTool } from "../../../tools/index.js";
import { ensureApiKeys, resolveSearchConfig } from "../../../tools/search/config.js";
import { formatSearchResults } from "../../../tools/search/format.js";
import type { ExploredEntry } from "../../../utils/activityTracker.js";
import { truncateForLog } from "../../utils.js";
import { buildWorkspacePatch } from "../../gitPatch.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { detectWorkspaceFrom } from "../../../workspace/detector.js";
import { resolveAdsStateDir, resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import { buildPromptInput, buildUserLogEntry, cleanupTempFiles } from "../../utils.js";
import { runCollaborativeTurn } from "../../../agents/hub.js";
import { extractCommandPayload } from "./utils.js";
import type { WsMessage } from "./schema.js";
import { extractTaskBundleJsonBlocks, parseTaskBundle } from "../planner/taskBundle.js";
import { upsertTaskBundleDraft } from "../planner/taskBundleDraftStore.js";
import { createMcpBearerToken } from "../mcp/auth.js";
import { resolveMcpPepper } from "../mcp/secret.js";
import { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import { runBootstrapLoop } from "../../../bootstrap/bootstrapLoop.js";
import { CodexBootstrapAgentRunner } from "../../../bootstrap/agentRunner.js";
import { BwrapSandbox, NoopSandbox } from "../../../bootstrap/sandbox.js";
import { normalizeBootstrapProjectRef } from "../../../bootstrap/projectId.js";

type FileChangeLike = { kind?: unknown; path?: unknown };
type PatchFileStatLike = { added: number | null; removed: number | null };

const HISTORY_INJECTION_MAX_ENTRIES = 20;
const HISTORY_INJECTION_MAX_CHARS = 8_000;

type ParsedBootstrapArgs = {
  projectRef: string;
  goal: string;
  softSandbox: boolean;
  allowNetwork: boolean;
  allowInstallDeps: boolean;
  maxIterations: number;
  model?: string;
};

function looksLikeGitUrl(value: string): boolean {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  if (trimmed.startsWith("git@")) return true;
  if (/^[a-zA-Z0-9._-]+@[^:]+:.+/.test(trimmed)) return true;
  if (trimmed.startsWith("ssh://")) return true;
  return false;
}

function parseBootstrapArgs(body: string): { ok: true; args: ParsedBootstrapArgs } | { ok: false; error: string } {
  const tokens = body
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: "用法: /bootstrap [--soft] [--no-install] [--no-network] [--max-iterations=N] [--model=MODEL] <repoPath|gitUrl> <goal...>",
    };
  }

  const params: Record<string, string> = {};
  const positional: string[] = [];
  let softSandbox = false;
  let allowInstallDeps = true;
  let allowNetwork = true;

  for (const token of tokens) {
    if (token === "--soft") {
      softSandbox = true;
      continue;
    }
    if (token === "--no-install") {
      allowInstallDeps = false;
      continue;
    }
    if (token === "--no-network") {
      allowNetwork = false;
      continue;
    }
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex > -1) {
        const key = token.slice(2, eqIndex);
        const value = token.slice(eqIndex + 1);
        params[key] = value;
      } else {
        params[token.slice(2)] = "true";
      }
      continue;
    }
    positional.push(token.replace(/^['"]|['"]$/g, ""));
  }

  const projectRef = (params.repo ?? params.project ?? positional.shift() ?? "").trim();
  const goal = (params.goal ?? positional.join(" ")).trim();
  if (!projectRef) {
    return { ok: false, error: "缺少 repoPath/gitUrl。用法: /bootstrap <repoPath|gitUrl> <goal...>" };
  }
  if (!goal) {
    return { ok: false, error: "缺少 goal。用法: /bootstrap <repoPath|gitUrl> <goal...>" };
  }

  const maxIterationsRaw = params["max-iterations"] ?? params.max_iterations ?? params.maxIterations;
  const maxIterationsParsed = maxIterationsRaw ? Number.parseInt(maxIterationsRaw, 10) : 10;
  const maxIterations = Number.isFinite(maxIterationsParsed) ? Math.max(1, Math.min(10, maxIterationsParsed)) : 10;
  const model = params.model ? String(params.model).trim() : undefined;

  return {
    ok: true,
    args: {
      projectRef,
      goal,
      softSandbox,
      allowNetwork,
      allowInstallDeps,
      maxIterations,
      model: model && model.length > 0 ? model : undefined,
    },
  };
}

export function buildHistoryInjectionContext(entries: Array<{ role: string; text: string }>): string | null {
  const relevant = entries.filter((e) => e.role === "user" || e.role === "ai");
  if (relevant.length === 0) {
    return null;
  }
  const recent = relevant.slice(-HISTORY_INJECTION_MAX_ENTRIES);
  const lines: string[] = [];
  for (const entry of recent) {
    const role = entry.role === "user" ? "User" : "Assistant";
    const text = String(entry.text ?? "").trim();
    if (!text) continue;
    const maxPerEntry = 800;
    const truncated = text.length <= maxPerEntry ? text : `${text.slice(0, maxPerEntry)}…`;
    lines.push(`${role}: ${truncated}`);
  }
  if (lines.length === 0) {
    return null;
  }
  let transcript = lines.join("\n");
  if (transcript.length > HISTORY_INJECTION_MAX_CHARS) {
    transcript = transcript.slice(transcript.length - HISTORY_INJECTION_MAX_CHARS);
  }
  return [
    "[Context restore] Recent chat history (for reference only). Do not repeat it; answer the user's next request directly:",
    "",
    transcript,
    "",
    "---",
    "",
  ].join("\n");
}

export function prependContextToInput(context: string, input: Input): Input {
  if (typeof input === "string") {
    return `${context}${input}`;
  }
  if (Array.isArray(input)) {
    const prefix: InputTextPart = { type: "text", text: context };
    return [prefix, ...input];
  }
  return `${context}${String(input ?? "")}`;
}

export function formatWriteExploredSummary(
  changes: FileChangeLike[],
  patchFiles?: PatchFileStatLike[],
): string {
  const safeChanges = Array.isArray(changes) ? changes : [];

  const diffstat = (() => {
    const files = Array.isArray(patchFiles) ? patchFiles : [];
    let added = 0;
    let removed = 0;
    let hasKnown = false;
    for (const file of files) {
      if (typeof file.added === "number" && typeof file.removed === "number") {
        added += file.added;
        removed += file.removed;
        hasKnown = true;
      }
    }
    if (!hasKnown) return "";
    return `(+${added} -${removed})`;
  })();

  const toBaseName = (p: string): string => {
    const rawPath = String(p ?? "").trim();
    if (!rawPath) return "";
    const parts = rawPath.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1]! : rawPath;
  };

  const formatted = safeChanges
    .map((c) => {
      const kind = String(c.kind ?? "").trim();
      const path = String(c.path ?? "").trim();
      if (!kind || !path) return "";
      const label = path.length <= 60 ? path : toBaseName(path);
      return `${kind} ${label}`;
    })
    .filter(Boolean);
  const shown = formatted.slice(0, 4);
  const hidden = Math.max(0, formatted.length - shown.length);
  const coreSummary = shown.join(", ") + (hidden ? ` (+${hidden} more)` : "");
  return coreSummary && diffstat ? `${coreSummary} ${diffstat}` : coreSummary;
}

export async function handlePromptMessage(deps: {
  parsed: WsMessage;
  ws: import("ws").WebSocket;
  safeJsonSend: (ws: import("ws").WebSocket, payload: unknown) => void;
  broadcastJson: (payload: unknown) => void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; debug: (msg: string) => void };
  sessionLogger: {
    logInput: (text: string) => void;
    logOutput: (text: string) => void;
    logError: (text: string) => void;
    logEvent: (event: AgentEvent) => void;
    attachThreadId: (threadId?: string) => void;
  } | null;
  requestId: string;
  clientMessageId: string | null;
  traceWsDuplication: boolean;
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
  allowedDirs: string[];
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  interruptControllers: Map<import("ws").WebSocket, AbortController>;
  historyStore: HistoryStore;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  sendWorkspaceState: (ws: import("ws").WebSocket, workspaceRoot: string) => void;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (deps.parsed.type !== "prompt") {
    return { handled: false, orchestrator: deps.orchestrator };
  }

  const sendToClient = (payload: unknown): void => deps.safeJsonSend(deps.ws, payload);
  const sendToChat = (payload: unknown): void => deps.broadcastJson(payload);

  let orchestrator = deps.orchestrator;

  const workspaceRoot = detectWorkspaceFrom(deps.currentCwd);
  const lock = deps.getWorkspaceLock(workspaceRoot);

  await lock.runExclusive(async () => {
    const imageDir = resolveWorkspaceStatePath(workspaceRoot, "temp", "web-images");
    const promptInput = buildPromptInput(deps.parsed.payload, imageDir);
    if (!promptInput.ok) {
      deps.sessionLogger?.logError(promptInput.message);
      sendToClient({ type: "error", message: promptInput.message });
      return;
    }
    const tempAttachments = promptInput.attachments || [];
    const cleanupAttachments = () => cleanupTempFiles(tempAttachments);
    const userLogEntry = buildUserLogEntry(promptInput.input, deps.currentCwd);
    deps.sessionLogger?.logInput(userLogEntry);
    const entryKind = deps.clientMessageId ? `client_message_id:${deps.clientMessageId}` : undefined;
    const inserted = deps.historyStore.add(deps.historyKey, {
      role: "user",
      text: userLogEntry,
      ts: Date.now(),
      kind: entryKind,
    });
    if (deps.clientMessageId) {
      sendToClient({ type: "ack", client_message_id: deps.clientMessageId, duplicate: !inserted });
      if (!inserted) {
        if (deps.traceWsDuplication) {
          deps.logger.warn(
            `[WebSocket][Dedupe] req=${deps.requestId} session=${deps.sessionId} user=${deps.userId} history=${deps.historyKey} client_message_id=${deps.clientMessageId}`,
          );
        }
        cleanupAttachments();
        return;
      }
    }
    const promptText = extractTextFromInput(promptInput.input).trim();

    const promptSlash = parseSlashCommand(promptText);
    if (promptSlash?.command === "search") {
      const query = promptSlash.body.trim();
      if (!query) {
        const output = "用法: /search <query>";
        sendToChat({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
        cleanupAttachments();
        return;
      }
      const config = resolveSearchConfig();
      const missingKeys = ensureApiKeys(config);
      if (missingKeys) {
        const output = `/search 未启用: ${missingKeys.message}`;
        sendToChat({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
        cleanupAttachments();
        return;
      }
      try {
        const result = await SearchTool.search({ query } satisfies SearchParams, { config });
        const output = formatSearchResults(query, result);
        sendToChat({ type: "result", ok: true, output });
        deps.sessionLogger?.logOutput(output);
        deps.historyStore.add(deps.historyKey, { role: "ai", text: output, ts: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const output = `/search 失败: ${message}`;
        sendToChat({ type: "result", ok: false, output });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "error" });
      }
      cleanupAttachments();
      return;
    }

    if (promptSlash?.command === "bootstrap") {
      const parsedArgs = parseBootstrapArgs(promptSlash.body);
      if (!parsedArgs.ok) {
        sendToChat({ type: "result", ok: false, output: parsedArgs.error, kind: "bootstrap" });
        deps.sessionLogger?.logError(parsedArgs.error);
        deps.historyStore.add(deps.historyKey, { role: "status", text: parsedArgs.error, ts: Date.now(), kind: "command" });
        cleanupAttachments();
        return;
      }

      const controller = new AbortController();
      deps.interruptControllers.set(deps.ws, controller);
      try {
        const directoryManager = new DirectoryManager(deps.allowedDirs);
        const inputRef = parsedArgs.args.projectRef;
        const project = looksLikeGitUrl(inputRef)
          ? ({ kind: "git_url", value: inputRef } as const)
          : (() => {
              const resolved = path.resolve(deps.currentCwd, inputRef);
              if (!directoryManager.validatePath(resolved)) {
                const allowed = deps.allowedDirs.join("\n");
                throw new Error(`目录不在白名单内。允许的目录：\n${allowed}`);
              }
              return { kind: "local_path", value: resolved } as const;
            })();

        const normalizedProject = normalizeBootstrapProjectRef(project);
        const bootstrapRoot = path.join(resolveAdsStateDir(), "bootstraps", normalizedProject.projectId);
        const hardSandbox = !parsedArgs.args.softSandbox;
        const sandbox = hardSandbox
          ? new BwrapSandbox({ rootDir: bootstrapRoot, allowNetwork: parsedArgs.args.allowNetwork })
          : new NoopSandbox();
        const agentRunner = new CodexBootstrapAgentRunner({ sandbox, model: parsedArgs.args.model });

        sendToChat({
          type: "result",
          ok: true,
          output: `bootstrap started (sandbox=${hardSandbox ? "hard" : "soft"})`,
          kind: "bootstrap",
        });

        const result = await runBootstrapLoop(
          {
            project: normalizedProject.project,
            goal: parsedArgs.args.goal,
            maxIterations: parsedArgs.args.maxIterations,
            allowNetwork: parsedArgs.args.allowNetwork,
            allowInstallDeps: parsedArgs.args.allowInstallDeps,
            requireHardSandbox: hardSandbox,
            sandbox: { backend: hardSandbox ? "bwrap" : "none" },
          },
          {
            agentRunner,
            signal: controller.signal,
            hooks: {
              onStarted(ctx) {
                sendToChat({
                  type: "result",
                  ok: true,
                  output: `bootstrap worktree ready runId=${ctx.runId}\nworktree: ${ctx.worktreeDir}\nartifacts: ${ctx.artifactsDir}\nbranch: ${ctx.branchName}`,
                  kind: "bootstrap",
                });
              },
              onIteration(progress) {
                const testState = progress.test.summary === "(skipped)" ? "skipped" : progress.test.ok ? "ok" : "fail";
                const line = `bootstrap iter=${progress.iteration} ok=${progress.ok} lint=${progress.lint.ok ? "ok" : "fail"} test=${testState} strategy=${progress.strategy}`;
                sendToChat({ type: "result", ok: true, output: line, kind: "bootstrap_progress" });
              },
            },
          },
        );

        const artifactsDir = path.dirname(result.lastReportPath);
        const derivedRunId = path.basename(artifactsDir);
        const derivedBootstrapRoot = path.resolve(artifactsDir, "..", "..");
        const worktreeDir = path.join(derivedBootstrapRoot, "worktrees", derivedRunId);

        const outputLines: string[] = [];
        outputLines.push(`bootstrap finished ok=${result.ok} iterations=${result.iterations} strategyChanges=${result.strategyChanges}`);
        outputLines.push(`runId: ${derivedRunId}`);
        outputLines.push(`worktree: ${worktreeDir}`);
        outputLines.push(`artifacts: ${artifactsDir}`);
        if (result.finalBranch) outputLines.push(`branch: ${result.finalBranch}`);
        if (result.finalCommit) outputLines.push(`commit: ${result.finalCommit}`);
        outputLines.push(`report: ${result.lastReportPath}`);

        const output = outputLines.join("\n");
        sendToChat({ type: "result", ok: result.ok, output, kind: "bootstrap" });
        deps.sessionLogger?.logOutput(output);
        deps.historyStore.add(deps.historyKey, {
          role: result.ok ? "ai" : "status",
          text: output,
          ts: Date.now(),
          kind: result.ok ? undefined : "command",
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        const output = aborted ? "bootstrap 已中断" : `bootstrap failed: ${message}`;
        sendToChat({ type: "result", ok: false, output, kind: "bootstrap" });
        deps.sessionLogger?.logError(output);
        deps.historyStore.add(deps.historyKey, { role: "status", text: output, ts: Date.now(), kind: "command" });
      } finally {
        deps.interruptControllers.delete(deps.ws);
        cleanupAttachments();
      }
      return;
    }

    const inputToSend: Input = promptInput.input;
    const cleanupAfter = cleanupAttachments;
    const turnCwd = deps.currentCwd;

    const controller = new AbortController();
    deps.interruptControllers.set(deps.ws, controller);
    orchestrator = deps.sessionManager.getOrCreate(deps.userId, turnCwd);
    const status = orchestrator.status();
    if (!status.ready) {
      deps.sessionLogger?.logError(status.error ?? "代理未启用");
      sendToClient({ type: "error", message: status.error ?? "代理未启用，请配置凭证" });
      deps.interruptControllers.delete(deps.ws);
      cleanupAfter();
      return;
    }
    orchestrator.setWorkingDirectory(turnCwd);
    const formatStepTraceLine = (event: AgentEvent): string | null => {
      const title = String(event.title ?? "").trim();
      if (!title) {
        return null;
      }
      const phase = String(event.phase ?? "").trim();
      const prefix = phase ? `[${phase}] ` : "";
      const detail = phase === "analysis" ? "" : String(event.detail ?? "").trim();
      return detail ? `${prefix}${title}: ${detail}\n` : `${prefix}${title}\n`;
    };
    let lastRespondingText = "";
    let lastReasoningText = "";
    const lastCommandOutputsByKey = new Map<string, string>();
    const announcedCommandKeys = new Set<string>();
    let hasCommandOutput = false;
    const unsubscribe = orchestrator.onEvent((event: AgentEvent) => {
      deps.sessionLogger?.logEvent(event);
      deps.logger.debug(`[Event] phase=${event.phase} title=${event.title} detail=${event.detail?.slice(0, 50)}`);
      const raw = event.raw as ThreadEvent;
      if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
        const next = event.delta;
        let delta = next;
        if (lastRespondingText && next.startsWith(lastRespondingText)) {
          delta = next.slice(lastRespondingText.length);
        }
        if (next.length >= lastRespondingText.length) {
          lastRespondingText = next;
        }
        if (delta) {
          sendToChat({ type: "delta", delta });
        }
        return;
      }
      const rawItem = (raw as { item?: { type?: unknown } }).item;
      const rawItemType = rawItem && typeof rawItem === "object" ? String((rawItem as { type?: unknown }).type ?? "").trim() : "";
      if (raw.type === "item.completed" && rawItemType === "file_change") {
        const item = rawItem as { changes?: unknown };
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ kind?: unknown; path?: unknown }>) : [];
        const paths = changes.map((c) => String(c.path ?? "").trim()).filter(Boolean);
        const patch = buildWorkspacePatch(turnCwd, paths);
        const summary = formatWriteExploredSummary(changes, patch?.files);
        if (summary) {
          sendToChat({
            type: "explored",
            header: false,
            entry: { category: "Write", summary },
          });
        }

        if (patch) {
          sendToChat({ type: "patch", patch });
        }
      }
      if (rawItemType === "reasoning" && typeof event.delta === "string" && event.delta) {
        const next = event.delta;
        const prev = lastReasoningText;
        let delta = next;
        if (prev && next.startsWith(prev)) {
          delta = next.slice(prev.length);
        }
        lastReasoningText = next;
        if (delta) {
          const payload = prev ? delta : `[analysis] ${delta}`;
          sendToChat({ type: "delta", delta: payload, source: "step" });
        }
        return;
      }
      if (
        event.phase === "boot" ||
        event.phase === "analysis" ||
        event.phase === "context" ||
        event.phase === "editing" ||
        event.phase === "tool" ||
        event.phase === "connection"
      ) {
        const line = formatStepTraceLine(event);
        if (line) {
          sendToChat({ type: "delta", delta: line, source: "step" });
        }
      }
      if (event.phase === "command") {
        const commandPayload = extractCommandPayload(event);
        deps.logger.info(
          `[Command Event] ${JSON.stringify({
            detail: event.detail ?? event.title,
            command: commandPayload
              ? { id: commandPayload.id, command: commandPayload.command, status: commandPayload.status, exit_code: commandPayload.exit_code }
              : null,
          })}`,
        );

        const commandLine = commandPayload?.command ? String(commandPayload.command).trim() : "";
        // Some runtimes may reuse a command_execution id while changing the command string (e.g. batched execution).
        // Track deltas per (id, command) so "new commands" are detected correctly and output deltas don't bleed
        // across unrelated commands that happen to share an id.
        const commandKey = commandLine
          ? (commandPayload?.id ? `id:${commandPayload.id}:cmd:${commandLine}` : `cmd:${commandLine}`)
          : "";

        if (!commandPayload || !commandLine || !commandKey) {
          return;
        }

        let outputDelta: string | undefined;
        const nextOutput = String(commandPayload.aggregated_output ?? "");
        const prevOutput = lastCommandOutputsByKey.get(commandKey) ?? "";
        if (nextOutput !== prevOutput) {
          if (prevOutput && nextOutput.startsWith(prevOutput)) {
            outputDelta = nextOutput.slice(prevOutput.length);
          } else {
            outputDelta = nextOutput;
          }
          lastCommandOutputsByKey.set(commandKey, nextOutput);
        }

        const isNewCommand = !announcedCommandKeys.has(commandKey);
        if (isNewCommand) {
          announcedCommandKeys.add(commandKey);
          const header = `${hasCommandOutput ? "\n" : ""}$ ${commandLine}\n`;
          outputDelta = header + (outputDelta ?? "");
          hasCommandOutput = true;
        } else if (outputDelta) {
          hasCommandOutput = true;
        }

        if (!isNewCommand && !outputDelta) {
          return;
        }

        sendToChat({
          type: "command",
          detail: event.detail ?? event.title,
          command: {
            id: commandPayload.id,
            command: commandLine,
            status: commandPayload.status,
            exit_code: commandPayload.exit_code,
            outputDelta,
          },
        });

        if (isNewCommand) {
          deps.historyStore.add(deps.historyKey, {
            role: "status",
            text: `$ ${commandLine}`,
            ts: Date.now(),
            kind: "command",
          });
        }
        return;
      }
      if (event.phase === "error") {
        sendToChat({ type: "error", message: event.detail ?? event.title });
      }
    });

    let exploredHeaderSent = false;
    const handleExploredEntry = (entry: ExploredEntry) => {
      sendToChat({
        type: "explored",
        header: !exploredHeaderSent,
        entry: { category: entry.category, summary: entry.summary },
      });
      exploredHeaderSent = true;
    };

    try {
      const expectedThreadId = deps.sessionManager.getSavedThreadId(deps.userId, orchestrator.getActiveAgentId());

      const delegationIdsByFingerprint = new Map<string, string[]>();
      const delegationFingerprint = (agentId: string, prompt: string): string =>
        `${String(agentId ?? "").trim().toLowerCase()}:${truncateForLog(prompt, 200)}`;
      const nextDelegationId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stashDelegationId = (agentId: string, prompt: string): string => {
        const fp = delegationFingerprint(agentId, prompt);
        const next = delegationIdsByFingerprint.get(fp) ?? [];
        const id = nextDelegationId();
        delegationIdsByFingerprint.set(fp, [...next, id]);
        return id;
      };
      const popDelegationId = (agentId: string, prompt: string): string => {
        const fp = delegationFingerprint(agentId, prompt);
        const existing = delegationIdsByFingerprint.get(fp) ?? [];
        if (existing.length === 0) {
          return nextDelegationId();
        }
        const [head, ...tail] = existing;
        if (tail.length > 0) delegationIdsByFingerprint.set(fp, tail);
        else delegationIdsByFingerprint.delete(fp);
        return head!;
      };

      const mcpEnv = (() => {
        if (deps.chatSessionId !== "planner") {
          return undefined;
        }
        let workspaceRootForMcp = detectWorkspaceFrom(turnCwd);
        try {
          workspaceRootForMcp = fs.realpathSync(workspaceRootForMcp);
        } catch {
          // ignore
        }
        const token = createMcpBearerToken({
          pepper: resolveMcpPepper(),
          context: {
            authUserId: deps.authUserId,
            sessionId: deps.sessionId,
            chatSessionId: deps.chatSessionId,
            historyKey: deps.historyKey,
            workspaceRoot: workspaceRootForMcp,
          },
        });
        return { ADS_MCP_BEARER_TOKEN: token };
      })();

      let effectiveInput: Input = inputToSend;
      if (deps.sessionManager.needsHistoryInjection(deps.userId)) {
        const historyEntries = deps.historyStore.get(deps.historyKey);
        const injectionContext = buildHistoryInjectionContext(historyEntries);
        if (injectionContext) {
          effectiveInput = prependContextToInput(injectionContext, inputToSend);
          deps.logger.info(
            `[ContextRestore] Injected ${historyEntries.length} history entries for user=${deps.userId} session=${deps.sessionId}`,
          );
        }
        deps.sessionManager.clearHistoryInjection(deps.userId);
      }

      const result = await runCollaborativeTurn(orchestrator, effectiveInput, {
        streaming: true,
        env: mcpEnv,
        signal: controller.signal,
        onExploredEntry: handleExploredEntry,
        hooks: {
          onSupervisorRound: (round, directives) => deps.logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
          onDelegationStart: ({ agentId, agentName, prompt }) => {
            deps.logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`);
            // The LiveActivity UI is intentionally short-lived (TTL). Emit a structured message so
            // the frontend can keep a persistent "agents in progress" indicator while delegations run.
            const delegationId = stashDelegationId(agentId, prompt);
            sendToChat({
              type: "agent",
              event: "delegation:start",
              delegationId,
              agentId,
              agentName,
              prompt: truncateForLog(prompt, 200),
              ts: Date.now(),
            });
            handleExploredEntry({
              category: "Agent",
              summary: `${agentName}（${agentId}）在后台执行：${truncateForLog(prompt, 140)}`,
              ts: Date.now(),
              source: "tool_hook",
            } as ExploredEntry);
          },
          onDelegationResult: (summary) => {
            deps.logger.info(`[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`);
            const delegationId = popDelegationId(summary.agentId, summary.prompt);
            sendToChat({
              type: "agent",
              event: "delegation:result",
              delegationId,
              agentId: summary.agentId,
              agentName: summary.agentName,
              prompt: truncateForLog(summary.prompt, 200),
              ts: Date.now(),
            });
            handleExploredEntry({
              category: "Agent",
              summary: `✓ ${summary.agentName} 完成：${truncateForLog(summary.prompt, 140)}`,
              ts: Date.now(),
              source: "tool_hook",
            } as ExploredEntry);
          },
        },
        cwd: turnCwd,
        historyNamespace: "web",
        historySessionId: deps.historyKey,
      });

      const rawResponse = typeof result.response === "string" ? result.response : String(result.response ?? "");
      const finalOutput = stripLeadingTranslation(rawResponse);
      const workspaceRootForAdr = detectWorkspaceFrom(turnCwd);
      let outputToSend = finalOutput;
      try {
        const adrProcessed = processAdrBlocks(finalOutput, workspaceRootForAdr);
        outputToSend = adrProcessed.finalText || finalOutput;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputToSend = `${finalOutput}\n\n---\nADR warning: failed to record ADR (${message})`;
      }
      const threadId = orchestrator.getThreadId();
      const threadReset = Boolean(expectedThreadId) && Boolean(threadId) && expectedThreadId !== threadId;
      sendToChat({ type: "result", ok: true, output: outputToSend, threadId, expectedThreadId, threadReset });
      if (deps.sessionLogger) {
        deps.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.sessionLogger.logOutput(outputToSend);
      }
      deps.historyStore.add(deps.historyKey, { role: "ai", text: outputToSend, ts: Date.now() });

      if (deps.chatSessionId === "planner") {
        let workspaceRootForDraft = workspaceRootForAdr;
        try {
          workspaceRootForDraft = fs.realpathSync(workspaceRootForDraft);
        } catch {
          // ignore
        }

        const blocks = extractTaskBundleJsonBlocks(outputToSend);
        for (const block of blocks) {
          const parsedBundle = parseTaskBundle(block);
          if (!parsedBundle.ok) {
            deps.logger.warn(`[PlannerDraft] invalid bundle: ${parsedBundle.error}`);
            continue;
          }
          try {
            const draft = upsertTaskBundleDraft({
              authUserId: deps.authUserId,
              workspaceRoot: workspaceRootForDraft,
              sourceChatSessionId: deps.chatSessionId,
              sourceHistoryKey: deps.historyKey,
              bundle: parsedBundle.bundle,
            });
            sendToChat({ type: "task_bundle_draft", action: "upsert", draft });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[PlannerDraft] Failed to persist bundle: ${message}`);
          }
        }
      }

      if (threadId) {
        deps.sessionManager.saveThreadId(deps.userId, threadId, orchestrator.getActiveAgentId());
      }
      deps.sendWorkspaceState(deps.ws, turnCwd);
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        sendToChat({ type: "error", message: "已中断，输出可能不完整" });
      } else {
        const errorInfo: CodexErrorInfo =
          error instanceof CodexClassifiedError
            ? error.info
            : classifyError(error);

        const logMessage = `[${errorInfo.code}] ${errorInfo.message}`;
        const stack = error instanceof Error ? error.stack : undefined;
        deps.sessionLogger?.logError(stack ? `${logMessage}\n${stack}` : logMessage);
        deps.logger.warn(`[Prompt Error] code=${errorInfo.code} retryable=${errorInfo.retryable} needsReset=${errorInfo.needsReset} message=${errorInfo.message}`);

        deps.historyStore.add(deps.historyKey, {
          role: "status",
          text: `[${errorInfo.code}] ${errorInfo.userHint}`,
          ts: Date.now(),
          kind: "error",
        });

        sendToChat({
          type: "error",
          message: errorInfo.userHint,
          errorInfo: {
            code: errorInfo.code,
            retryable: errorInfo.retryable,
            needsReset: errorInfo.needsReset,
            originalError: errorInfo.originalError,
          },
        });
      }
    } finally {
      unsubscribe();
      deps.interruptControllers.delete(deps.ws);
      cleanupAfter();
    }
  });

  return { handled: true, orchestrator };
}
