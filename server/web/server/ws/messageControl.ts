import type { WebSocket } from "ws";

import type { SessionManager } from "../../../sessions/sessionManager.js";
import { getStateDatabase } from "../../../state/database.js";
import { createGlobalModelConfigStore } from "../../../state/globalModelConfigStore.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type {
  WsLaneValidityCheck,
  WsLogger,
  WsPromptSessionLogger,
  WsResetResult,
  WsTaskResumeHandlerDeps,
} from "./deps.js";
import { invalidateWsPromptRun } from "./promptLifecycle.js";
import { handleSessionListMessage } from "./handleSessionList.js";
import { handleTaskResumeMessage } from "./handleTaskResume.js";
import type { WsMessage } from "./schema.js";

type ClearHistoryScope = "lane" | "shared";

const STANDARD_REASONING_EFFORTS = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function readModelOverridePayload(payload: unknown): { model: string; effort?: string } | { error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Model override payload must be an object" };
  }
  const record = payload as Record<string, unknown>;
  const model = String(record.model ?? record.modelId ?? record.model_id ?? "").trim();
  if (!model) {
    return { error: "Model id is required" };
  }
  const rawEffort = record.model_reasoning_effort ?? record.modelReasoningEffort;
  if (rawEffort === undefined || rawEffort === null || String(rawEffort).trim() === "") {
    return { model };
  }
  const effort = String(rawEffort).trim().toLowerCase();
  if (effort === "default") {
    return { model };
  }
  if (!STANDARD_REASONING_EFFORTS.has(effort)) {
    return { error: `Invalid reasoning effort: ${effort}` };
  }
  return { model, effort };
}

function readConfiguredReasoningEfforts(configJson: unknown): string[] {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) return [];
  const values = (configJson as Record<string, unknown>).reasoningEfforts;
  return Array.isArray(values) ? values.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : [];
}

function resolveClearHistoryScope(payload: unknown, chatSessionId: string): ClearHistoryScope {
  if (String(chatSessionId ?? "").trim() === "planner") {
    return "lane";
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "lane";
  }
  const scope = String((payload as Record<string, unknown>).scope ?? "").trim().toLowerCase();
  return scope === "shared" || scope === "project" ? "shared" : "lane";
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
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
  sessionManager: SessionManager;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
  getWorkspaceLock: WsTaskResumeHandlerDeps["sessions"]["getWorkspaceLock"];
  historyStore: WsTaskResumeHandlerDeps["history"]["historyStore"];
  interruptControllers?: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
  isLaneCurrent?: WsLaneValidityCheck;
  sendJson: (payload: unknown) => void;
  broadcastJson?: (payload: unknown) => void;
  broadcastSessionReset?: (payload: unknown) => void;
  resetLaneState?: () => WsResetResult;
  resetSharedSessionState?: (options: {
    sourceChatSessionId: string;
  }) => WsResetResult;
  closeAfterReset?: () => void;
  logger: Pick<WsLogger, "info" | "warn">;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  if (args.parsed.type === "model_override") {
    const requestId = String(args.parsed.client_message_id ?? "").trim() || undefined;
    const parsed = readModelOverridePayload(args.parsed.payload);
    if ("error" in parsed) {
      args.sendJson({ type: "result", ok: false, kind: "model_override", output: parsed.error, client_message_id: requestId });
      return { handled: true, orchestrator: args.orchestrator };
    }

    const modelStore = createGlobalModelConfigStore(getStateDatabase());
    const modelConfig = modelStore.getModelConfigByAgentModelId(parsed.model) ?? modelStore.getModelConfig(parsed.model);
    if (!modelConfig || !modelConfig.isEnabled) {
      args.sendJson({ type: "result", ok: false, kind: "model_override", output: `Unknown or disabled model: ${parsed.model}`, client_message_id: requestId });
      return { handled: true, orchestrator: args.orchestrator };
    }
    const allowedEfforts = readConfiguredReasoningEfforts(modelConfig.configJson);
    if (parsed.effort && allowedEfforts.length > 0 && !allowedEfforts.includes(parsed.effort)) {
      args.sendJson({ type: "result", ok: false, kind: "model_override", output: `Reasoning effort "${parsed.effort}" is not available for ${modelConfig.modelId}`, client_message_id: requestId });
      return { handled: true, orchestrator: args.orchestrator };
    }

    const modelId = String(modelConfig.modelId ?? modelConfig.id ?? parsed.model).trim();
    args.sessionManager.setUserModel(args.userId, modelId);
    if (parsed.effort !== undefined) {
      args.sessionManager.setUserModelReasoningEffort(args.userId, parsed.effort);
    }
    args.orchestrator.setModelConfig?.(modelConfig.configJson ?? null);
    const effective = args.sessionManager.getEffectiveState(args.userId);
    args.sendJson({
      type: "result",
      ok: true,
      kind: "model_override",
      output: `Model switched to ${modelId}${effective.modelReasoningEffort ? ` (${effective.modelReasoningEffort})` : ""}`,
      model: effective.model,
      model_reasoning_effort: effective.modelReasoningEffort,
      client_message_id: requestId,
    });
    return { handled: true, orchestrator: args.orchestrator };
  }

  if (args.parsed.type === "clear_history") {
    const scope = resolveClearHistoryScope(args.parsed.payload, args.chatSessionId);
    if (args.interruptControllers) {
      invalidateWsPromptRun({
        historyKey: args.historyKey,
        interruptControllers: args.interruptControllers,
        promptRunEpochs: args.promptRunEpochs,
      });
    }
    args.logger.info(
      `[Web][continuity] reset source=clear_history scope=${scope} user=${args.userId} history=${args.historyKey}`,
    );
    const resetResult: WsResetResult = scope === "shared" && args.resetSharedSessionState
      ? args.resetSharedSessionState({ sourceChatSessionId: args.chatSessionId })
      : args.resetLaneState?.() ?? (() => {
          args.historyStore.clear(args.historyKey);
          args.sessionManager.reset(args.userId);
          return undefined;
        })();
    const resetPayload: Record<string, unknown> = {
      type: "session_reset",
      source: "clear_history",
      sourceChatSessionId: args.chatSessionId,
      scope,
    };
    if (typeof resetResult === "number") {
      resetPayload.laneGeneration = resetResult;
    } else if (resetResult && typeof resetResult === "object") {
      if (typeof resetResult.sourceGeneration === "number") {
        resetPayload.laneGeneration = resetResult.sourceGeneration;
      }
      if (resetResult.laneGenerations && Object.keys(resetResult.laneGenerations).length > 0) {
        resetPayload.laneGenerations = resetResult.laneGenerations;
      }
    }
    args.broadcastSessionReset?.(resetPayload);
    args.sendJson({ type: "result", ok: true, output: "已清空历史缓存并重置会话", kind: "clear_history" });
    args.closeAfterReset?.();
    return { handled: true, orchestrator: args.orchestrator };
  }

  if (args.parsed.type === "task_resume") {
    const resume = await handleTaskResumeMessage({
      request: { parsed: args.parsed },
      transport: {
        ws: {} as WebSocket,
        safeJsonSend: (_ws, payload) => args.sendJson(payload),
        broadcastJson: args.broadcastJson,
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
        isLaneCurrent: args.isLaneCurrent,
      },
      sessions: {
        sessionManager: args.sessionManager,
        orchestrator: args.orchestrator,
        getWorkspaceLock: args.getWorkspaceLock,
      },
      history: {
        historyStore: args.historyStore,
      },
    });
    return { handled: true, orchestrator: resume.orchestrator ?? args.orchestrator };
  }

  if (args.parsed.type === "session_list") {
    await handleSessionListMessage({
      payload: args.parsed.payload,
      historyStore: args.historyStore as unknown as HistoryStore,
      currentCwd: args.currentCwd,
      activeAgentId: args.orchestrator.getActiveAgentId(),
      currentSessionId: args.orchestrator.getThreadId(),
      sendJson: args.sendJson,
      logger: args.logger,
    });
    return { handled: true, orchestrator: args.orchestrator };
  }

  return { handled: false, orchestrator: args.orchestrator };
}
