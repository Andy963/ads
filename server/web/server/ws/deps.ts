import type { IncomingMessage, Server as HttpServer } from "node:http";

import type { WebSocket } from "ws";

import type { AgentAvailability } from "../../../agents/health/agentAvailability.js";
import type { AgentEvent } from "../../../codex/events.js";
import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import type { DirectoryManager } from "../../../telegram/utils/directoryManager.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import type { WsMessage } from "./schema.js";

export type WsLogger = {
  info: (msg: string) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  debug: (msg: string) => void;
};

export type WsSessionLogger = {
  logInput: (text: string) => void;
  logOutput: (text: string) => void;
  logError: (text: string) => void;
  logEvent?: (event: AgentEvent) => void;
  attachThreadId?: (threadId?: string) => void;
} | null;

export type WsPromptSessionLogger = Exclude<WsSessionLogger, null> & {
  logEvent: (event: AgentEvent) => void;
  attachThreadId: (threadId?: string) => void;
};

export type WsClientMeta = {
  historyKey: string;
  sessionId: string;
  chatSessionId: string;
  connectionId: string;
  authUserId: string;
  sessionUserId: number;
  workspaceRoot?: string;
};

export type WsOrchestrator = ReturnType<SessionManager["getOrCreate"]>;

export type WsConfigDeps = {
  workspaceRoot: string;
  allowedDirs: string[];
  maxClients: number;
  pingIntervalMs: number;
  maxMissedPongs: number;
  traceWsDuplication: boolean;
};

export type WsAuthDeps = {
  allowedOrigins: Set<string>;
  isOriginAllowed: (originHeader: unknown, allowedOrigins: Set<string>) => boolean;
  authenticateRequest: (req: IncomingMessage) => { ok: false } | { ok: true; userId: string };
};

export type WsAgentDeps = {
  agentAvailability: AgentAvailability;
};

export type WsStateDeps = {
  workspaceCache: Map<string, string>;
  interruptControllers: Map<string, AbortController>;
  clientMetaByWs: Map<WebSocket, WsClientMeta>;
  clients: Set<WebSocket>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: (storePath: string, store: Map<string, string>) => void;
};

export type WsSessionDeps = {
  workerSessionManager: SessionManager;
  plannerSessionManager: SessionManager;
  reviewerSessionManager: SessionManager;
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  getPlannerWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  getReviewerWorkspaceLock: (workspaceRoot: string) => AsyncLock;
};

export type WsHistoryDeps = {
  workerHistoryStore: HistoryStore;
  plannerHistoryStore: HistoryStore;
  reviewerHistoryStore: HistoryStore;
};

export type WsTaskDeps = {
  ensureTaskContext: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending: (ctx: TaskQueueContext) => void;
  broadcastToSession: (sessionId: string, payload: unknown) => void;
};

export type WsCommandDeps = {
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sanitizeInput: (payload: unknown) => string;
  syncWorkspaceTemplates: () => void;
};

export type WsSchedulerDeps = {
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
};

export type AttachWebSocketServerDeps = {
  server: HttpServer;
  config: WsConfigDeps;
  auth: WsAuthDeps;
  agents: WsAgentDeps;
  state: WsStateDeps;
  sessions: WsSessionDeps;
  history: WsHistoryDeps;
  tasks: WsTaskDeps;
  commands: WsCommandDeps;
  scheduler: WsSchedulerDeps;
  logger: WsLogger;
};

export type WsRequestDeps = {
  parsed: WsMessage;
  requestId: string;
  clientMessageId: string | null;
  receivedAt: number;
};

export type WsTransportDeps = {
  ws: WebSocket;
  safeJsonSend: (ws: WebSocket, payload: unknown) => void;
  broadcastJson: (payload: unknown) => void;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
};

export type WsConnectionContextDeps = {
  authUserId: string;
  sessionId: string;
  chatSessionId: string;
  userId: number;
  historyKey: string;
  currentCwd: string;
};

export type WsObservabilityDeps = {
  logger: WsLogger;
  sessionLogger: WsSessionLogger;
  traceWsDuplication: boolean;
};

export type WsSessionRuntimeDeps = {
  sessionManager: SessionManager;
  orchestrator: WsOrchestrator;
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  interruptControllers: Map<string, AbortController>;
};

export type WsHistoryRuntimeDeps = {
  historyStore: HistoryStore;
};

export type WsTaskRuntimeDeps = {
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
};

export type WsCommandRuntimeDeps = {
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sanitizeInput: (payload: unknown) => string;
  syncWorkspaceTemplates: () => void;
};

export type WsCommandStateDeps = Pick<
  WsStateDeps,
  "workspaceCache" | "cwdStore" | "cwdStorePath" | "persistCwdStore"
> & {
  directoryManager: DirectoryManager;
  cacheKey: string;
};

export type WsTaskResumeDeps = Pick<WsTaskDeps, "ensureTaskContext">;

export type WsPromptHandlerDeps = {
  request: WsRequestDeps;
  transport: WsTransportDeps;
  observability: Omit<WsObservabilityDeps, "sessionLogger"> & {
    sessionLogger: WsPromptSessionLogger | null;
  };
  context: WsConnectionContextDeps;
  sessions: WsSessionRuntimeDeps;
  history: WsHistoryRuntimeDeps;
  tasks: WsTaskRuntimeDeps;
  scheduler: WsSchedulerDeps;
};

export type WsCommandHandlerDeps = {
  request: Pick<WsRequestDeps, "parsed" | "clientMessageId">;
  transport: WsTransportDeps;
  observability: WsObservabilityDeps;
  context: Pick<WsConnectionContextDeps, "sessionId" | "userId" | "historyKey" | "currentCwd">;
  agents: WsAgentDeps;
  state: WsCommandStateDeps;
  sessions: WsSessionRuntimeDeps;
  history: WsHistoryRuntimeDeps;
  commands: WsCommandRuntimeDeps;
};

export type WsTaskResumeHandlerDeps = {
  request: Pick<WsRequestDeps, "parsed">;
  transport: Pick<WsTransportDeps, "ws" | "safeJsonSend">;
  observability: Pick<WsObservabilityDeps, "logger">;
  context: Pick<WsConnectionContextDeps, "userId" | "historyKey" | "currentCwd">;
  sessions: Pick<WsSessionRuntimeDeps, "sessionManager" | "orchestrator" | "getWorkspaceLock">;
  history: WsHistoryRuntimeDeps;
  tasks: WsTaskResumeDeps;
};
