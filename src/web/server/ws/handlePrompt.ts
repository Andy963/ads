import type { Input, ThreadEvent } from "../../../agents/protocol/types.js";

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
import { resolveWorkspaceStatePath } from "../../../workspace/adsPaths.js";
import { buildPromptInput, buildUserLogEntry, cleanupTempFiles } from "../../utils.js";
import { runCollaborativeTurn } from "../../../agents/hub.js";
import { extractCommandPayload } from "./utils.js";
import type { WsMessage } from "./schema.js";

type FileChangeLike = { kind?: unknown; path?: unknown };
type PatchFileStatLike = { added: number | null; removed: number | null };

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
  sessionId: string;
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

      const result = await runCollaborativeTurn(orchestrator, inputToSend, {
        streaming: true,
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
