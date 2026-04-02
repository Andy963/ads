import type { WebSocket } from "ws";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { WsLogger, WsPromptSessionLogger, WsTaskResumeHandlerDeps } from "./deps.js";
import { invalidateWsPromptRun } from "./promptLifecycle.js";
import { resolveWorkspaceRootFromDirectory } from "../api/routes/workspacePath.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import type { WsMessage } from "./schema.js";

function parsePreservedReviewerSnapshotId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const raw = record.preserveReviewerSnapshotId;
  const snapshotId = typeof raw === "string" ? raw.trim() : "";
  return snapshotId || null;
}

function resolveReviewerSnapshotBindingToPreserve(args: {
  parsed: WsMessage;
  isReviewerChat: boolean;
  userId: number;
  historyKey: string;
  currentCwd: string;
  sessionManager: SessionManager;
  reviewerSnapshotBindings: Map<string, string>;
  ensureTaskContext: WsTaskResumeHandlerDeps["tasks"]["ensureTaskContext"];
}): string | null {
  if (!args.isReviewerChat) {
    return null;
  }
  const requestedSnapshotId = parsePreservedReviewerSnapshotId(args.parsed.payload);
  if (!requestedSnapshotId) {
    return null;
  }
  const currentBinding =
    String(args.reviewerSnapshotBindings.get(args.historyKey) ?? "").trim() ||
    String((args.sessionManager as SessionManager).getSavedReviewerSnapshotId?.(args.userId) ?? "").trim();
  if (!currentBinding || currentBinding !== requestedSnapshotId) {
    return null;
  }
  try {
    const workspaceRoot = resolveWorkspaceRootFromDirectory(args.currentCwd);
    const taskCtx = args.ensureTaskContext(workspaceRoot);
    return taskCtx.reviewStore.getSnapshot(requestedSnapshotId) ? requestedSnapshotId : null;
  } catch {
    return null;
  }
}

export function ensureWsSessionLogger(args: {
  sessionManager: SessionManager;
  userId: number;
  warn: WsLogger["warn"];
}): WsPromptSessionLogger | null {
  try {
    return (args.sessionManager.ensureLogger(args.userId) ?? null) as WsPromptSessionLogger | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.warn(`[WebSocket] Failed to initialize session logger: ${message}`);
    return null;
  }
}

export async function handleWsControlMessage(args: {
  parsed: WsMessage;
  isReviewerChat: boolean;
  userId: number;
  historyKey: string;
  currentCwd: string;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsTaskResumeHandlerDeps["sessions"]["getWorkspaceLock"];
  historyStore: WsTaskResumeHandlerDeps["history"]["historyStore"];
  interruptControllers?: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  reviewerSnapshotBindings: Map<string, string>;
  ensureTaskContext: WsTaskResumeHandlerDeps["tasks"]["ensureTaskContext"];
  sendJson: (payload: unknown) => void;
  logger: Pick<WsLogger, "info" | "warn">;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (args.parsed.type === "clear_history") {
    if (args.interruptControllers) {
      invalidateWsPromptRun({
        historyKey: args.historyKey,
        interruptControllers: args.interruptControllers,
        promptRunEpochs: args.promptRunEpochs,
      });
    }
    const preservedSnapshotId = resolveReviewerSnapshotBindingToPreserve({
      parsed: args.parsed,
      isReviewerChat: args.isReviewerChat,
      userId: args.userId,
      historyKey: args.historyKey,
      currentCwd: args.currentCwd,
      sessionManager: args.sessionManager,
      reviewerSnapshotBindings: args.reviewerSnapshotBindings,
      ensureTaskContext: args.ensureTaskContext,
    });
    const requestedSnapshotId = parsePreservedReviewerSnapshotId(args.parsed.payload);
    args.logger.info(
      `[Web][continuity] reset source=clear_history user=${args.userId} history=${args.historyKey} reviewer=${args.isReviewerChat} preserveRequested=${requestedSnapshotId ?? "none"} preserveApplied=${preservedSnapshotId ?? "none"}`,
    );
    args.historyStore.clear(args.historyKey);
    args.sessionManager.reset(args.userId);
    if (args.isReviewerChat) {
      args.reviewerSnapshotBindings.delete(args.historyKey);
      args.sessionManager.clearSavedReviewerSnapshotBinding?.(args.userId);
      if (preservedSnapshotId) {
        args.reviewerSnapshotBindings.set(args.historyKey, preservedSnapshotId);
        args.sessionManager.saveReviewerSnapshotBinding(args.userId, preservedSnapshotId);
      }
    }
    args.sendJson({ type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
    return { handled: true, orchestrator: args.orchestrator };
  }

  if (args.parsed.type === "task_resume") {
    if (args.isReviewerChat) {
      args.sendJson({ type: "error", message: "Reviewer lane does not support resuming threads." });
      return { handled: true, orchestrator: args.orchestrator };
    }
    const resume = await handleTaskResumeMessage({
      request: { parsed: args.parsed },
      transport: {
        ws: {} as WebSocket,
        safeJsonSend: (_ws, payload) => args.sendJson(payload),
      },
      observability: {
        logger: {
          warn: args.logger.warn,
          info: args.logger.info,
          debug: () => {},
        },
      },
      context: {
        userId: args.userId,
        historyKey: args.historyKey,
        currentCwd: args.currentCwd,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator: args.orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
      },
      history: {
        historyStore: args.historyStore,
      },
      tasks: {
        ensureTaskContext: args.ensureTaskContext,
      },
    });
    return { handled: true, orchestrator: resume.orchestrator ?? args.orchestrator };
  }

  if (args.isReviewerChat && (args.parsed.type === "command" || args.parsed.type === "set_agent")) {
    args.sendJson({ type: "error", message: "Reviewer lane is read-only and does not accept commands." });
    return { handled: true, orchestrator: args.orchestrator };
  }

  return { handled: false, orchestrator: args.orchestrator };
}
