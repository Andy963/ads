import type { Input, InputTextPart, ThreadEvent } from "../../../agents/protocol/types.js";

import fs from "node:fs";

import type { AgentEvent } from "../../../codex/events.js";
import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import { processSpecBlocks } from "../../../utils/specRecording.js";
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
import {
  ensureTaskBundleIdempotency,
  extractTaskBundleJsonBlocks,
  formatTaskBundleSummaryMarkdown,
  parseTaskBundle,
  stripTaskBundleCodeBlocks,
} from "../planner/taskBundle.js";
import {
  approveTaskBundleDraft,
  getTaskBundleDraftByRequestId,
  setTaskBundleDraftError,
  upsertTaskBundleDraft,
} from "../planner/taskBundleDraftStore.js";
import { normalizeCreateTaskInput } from "../planner/taskBundleApprover.js";
import { detectBundleRisk } from "../planner/riskDetector.js";
import { recordTaskQueueMetric, type TaskQueueContext } from "../taskQueue/manager.js";
import { upsertTaskNotificationBinding } from "../../taskNotifications/store.js";

type FileChangeLike = { kind?: unknown; path?: unknown };
type PatchFileStatLike = { added: number | null; removed: number | null };

const HISTORY_INJECTION_MAX_ENTRIES = 20;
const HISTORY_INJECTION_MAX_CHARS = 8_000;

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
  receivedAt: number;
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
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
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
    if (!deps.clientMessageId) {
      deps.historyStore.add(deps.historyKey, {
        role: "user",
        text: userLogEntry,
        ts: deps.receivedAt,
      });
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

      let effectiveInput: Input = inputToSend;
      if (deps.sessionManager.needsHistoryInjection(deps.userId)) {
        const historyEntries = deps.historyStore.get(deps.historyKey).filter((entry) => entry.ts <= deps.receivedAt);
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
      let createdSpecRefs: string[] = [];
      try {
        const adrProcessed = processAdrBlocks(outputToSend, workspaceRootForAdr);
        outputToSend = adrProcessed.finalText || outputToSend;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputToSend = `${outputToSend}\n\n---\nADR warning: failed to record ADR (${message})`;
      }
      try {
        const specProcessed = await processSpecBlocks(outputToSend, workspaceRootForAdr);
        outputToSend = specProcessed.finalText || outputToSend;
        createdSpecRefs = specProcessed.results.map((r) => r.specRef);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputToSend = `${outputToSend}\n\n---\nSpec warning: failed to record spec (${message})`;
      }
      const threadId = orchestrator.getThreadId();
      const threadReset = Boolean(expectedThreadId) && Boolean(threadId) && expectedThreadId !== threadId;
      let outputForChat = outputToSend;

      if (deps.chatSessionId === "planner") {
        let workspaceRootForDraft = workspaceRootForAdr;
        try {
          workspaceRootForDraft = fs.realpathSync(workspaceRootForDraft);
        } catch {
          // ignore
        }

        const blocks = extractTaskBundleJsonBlocks(outputToSend);
        const stripCandidates = new Set<string>();
        const summaryTasks: Array<{ title: string; prompt: string }> = [];
        const defaultRequestId = (() => {
          const clientMessageId = String(deps.clientMessageId ?? "").trim();
          if (clientMessageId) return `cmid:${clientMessageId}`;
          const requestId = String(deps.requestId ?? "").trim();
          return requestId ? `req:${requestId}` : null;
        })();
        const defaultSpecRef = (() => {
          const last = createdSpecRefs.length > 0 ? createdSpecRefs[createdSpecRefs.length - 1] : null;
          return last ? String(last).trim() : null;
        })();
        const allowAutoApprove = (() => {
          const lowered = String(userLogEntry ?? "").toLowerCase();
          const passphrase = String(process.env.ADS_PLANNER_AUTO_APPROVE_PASSPHRASE ?? "ads:autoapprove").trim().toLowerCase();
          if (!passphrase) {
            return false;
          }
          return lowered.includes(passphrase);
        })();

        for (const block of blocks) {
          const parsedBundle = parseTaskBundle(block);
          if (!parsedBundle.ok) {
            deps.logger.warn(`[PlannerDraft] invalid bundle: ${parsedBundle.error}`);
            continue;
          }
          try {
            const originalRequestId = String(parsedBundle.bundle.requestId ?? "").trim();
            let normalized = ensureTaskBundleIdempotency(parsedBundle.bundle, { defaultRequestId });
            if (defaultSpecRef && !String(normalized.specRef ?? "").trim()) {
              normalized = { ...normalized, specRef: defaultSpecRef };
            }
            if (normalized.autoApprove && !allowAutoApprove) {
              normalized = { ...normalized, autoApprove: undefined };
            }
            const requestId = String(normalized.requestId ?? "").trim();

            if (!originalRequestId && requestId) {
              const existing = getTaskBundleDraftByRequestId({
                authUserId: deps.authUserId,
                workspaceRoot: workspaceRootForDraft,
                requestId,
              });
              if (existing) {
                sendToChat({ type: "task_bundle_draft", action: "upsert", draft: existing });
                stripCandidates.add(block);
                for (const task of normalized.tasks ?? []) {
                  summaryTasks.push({ title: task.title ?? "", prompt: task.prompt ?? "" });
                }
                continue;
              }
            }

            const draft = upsertTaskBundleDraft({
              authUserId: deps.authUserId,
              workspaceRoot: workspaceRootForDraft,
              sourceChatSessionId: deps.chatSessionId,
              sourceHistoryKey: deps.historyKey,
              bundle: normalized,
            });

            const riskResult = normalized.autoApprove ? detectBundleRisk(normalized) : null;
            const shouldAutoApprove = normalized.autoApprove && !riskResult?.isHighRisk && deps.ensureTaskContext && deps.promoteQueuedTasksToPending && deps.broadcastToSession;

            if (riskResult?.isHighRisk) {
              const degradeReason = riskResult.reasons.join("；");
              deps.logger.info(`[PlannerDraft] Auto-approve degraded to draft: ${degradeReason}`);
              try {
                setTaskBundleDraftError({ authUserId: deps.authUserId, draftId: draft.id, error: `降级为草稿：${degradeReason}` });
              } catch {
                // ignore
              }
              sendToChat({ type: "task_bundle_draft", action: "upsert", draft: { ...draft, lastError: `降级为草稿：${degradeReason}`, degradeReason } });
            } else if (shouldAutoApprove) {
              const ensureCtx = deps.ensureTaskContext!;
              const promote = deps.promoteQueuedTasksToPending!;
              const broadcast = deps.broadcastToSession!;
              try {
                const taskCtx = ensureCtx(workspaceRootForDraft);
                const now = Date.now();
                const createdTaskIds: string[] = [];
                const taskTitles: string[] = [];

                await taskCtx.lock.runExclusive(async () => {
                  for (let i = 0; i < normalized.tasks.length; i++) {
                    const specTask = normalized.tasks[i]!;
                    const input = normalizeCreateTaskInput(draft.id, specTask, i);
                    const { attachments: _attachments, ...createInput } = input;

                    let created;
                    try {
                      created = taskCtx.taskStore.createTask(createInput, now, { status: "queued" });
                    } catch {
                      const existingTask = taskCtx.taskStore.getTask(input.id);
                      if (existingTask) {
                        created = existingTask;
                      } else {
                        throw new Error(`Auto-approve: create task failed (idx=${i + 1})`);
                      }
                    }

                    recordTaskQueueMetric(taskCtx.metrics, "TASK_ADDED", { ts: now, taskId: created.id, reason: "auto_approve" });
                    broadcast(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: created, ts: now });
                    createdTaskIds.push(created.id);
                    taskTitles.push(created.title ?? "");

                    try {
                      upsertTaskNotificationBinding({
                        authUserId: deps.authUserId,
                        workspaceRoot: workspaceRootForDraft,
                        taskId: created.id,
                        taskTitle: created.title,
                        now,
                        logger: deps.logger,
                      });
                    } catch {
                      // ignore
                    }
                  }

                  approveTaskBundleDraft({ authUserId: deps.authUserId, draftId: draft.id, approvedTaskIds: createdTaskIds, now });

                  taskCtx.runController.setModeAll();
                  taskCtx.taskQueue.resume();
                  taskCtx.queueRunning = true;
                  promote(taskCtx);
                });

                sendToChat({
                  type: "task_bundle_auto_approved",
                  draftId: draft.id,
                  createdTaskIds,
                  taskTitles,
                  specRef: String(normalized.specRef ?? "").trim() || null,
                });
                deps.logger.info(`[PlannerDraft] Auto-approved draft=${draft.id} tasks=${createdTaskIds.length}`);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                deps.logger.warn(`[PlannerDraft] Auto-approve failed draft=${draft.id}: ${message}`);
                try {
                  setTaskBundleDraftError({ authUserId: deps.authUserId, draftId: draft.id, error: message });
                } catch {
                  // ignore
                }
                sendToChat({ type: "task_bundle_draft", action: "upsert", draft });
              }
            } else {
              sendToChat({ type: "task_bundle_draft", action: "upsert", draft });
            }

            stripCandidates.add(block);
            for (const task of normalized.tasks ?? []) {
              summaryTasks.push({ title: task.title ?? "", prompt: task.prompt ?? "" });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`[PlannerDraft] Failed to persist bundle: ${message}`);
          }
        }

        if (stripCandidates.size > 0) {
          const stripped = stripTaskBundleCodeBlocks(outputToSend, { shouldStrip: (rawJson) => stripCandidates.has(rawJson) });
          const base = String(stripped.text ?? "").replace(/\n{3,}/g, "\n\n").trim();

          const summary = formatTaskBundleSummaryMarkdown(summaryTasks);
          outputForChat = base ? `${base}\n\n---\n${summary}` : summary;
        }
      }

      sendToChat({ type: "result", ok: true, output: outputForChat, threadId, expectedThreadId, threadReset });
      if (deps.sessionLogger) {
        deps.sessionLogger.attachThreadId(threadId ?? undefined);
        deps.sessionLogger.logOutput(outputForChat);
      }
      deps.historyStore.add(deps.historyKey, { role: "ai", text: outputForChat, ts: Date.now() });

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
