import { createHash } from 'node:crypto';

import type { SandboxMode } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { CodexAppServerAdapter } from '../agents/adapters/codexAppServerAdapter.js';
import { NativeAgentAdapter } from '../agents/adapters/nativeAgentAdapter.js';
import type { AgentAdapter, AgentIdentifier } from '../agents/types.js';
import { HybridOrchestrator } from '../agents/orchestrator.js';
import { ConversationLogger } from '../utils/conversationLogger.js';
import { ThreadStorage } from './threadStorage.js';
import {
  buildPreservedResetState,
  buildSyncedSessionState,
  clearSavedResumeThreadId,
  areSessionCwdsCompatible,
  type ContextRestoreMode,
  getSavedResumeThreadId,
  getSavedSessionState,
  resolveResumeState,
  type SavedSessionState,
  shouldClearSavedThreadsForCwdChange,
} from './sessionState.js';
import { SessionRuntimeRegistry, type SessionRuntimeRecord } from './sessionRuntimeRegistry.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../systemPrompt/manager.js';
import { detectWorkspaceFrom } from '../workspace/detector.js';
import { deriveProjectSessionId } from '../web/server/projectSessionId.js';
import type { LaneName } from '../state/lanePromptDefaults.js';
import { resolveAgentRuntime, type AgentRuntimeBackend, type SessionLifecycle } from '../runtime/config.js';
import { isNativeExecutionId } from '../runtime/sessionIdentity.js';
import { getStateDatabase } from '../state/database.js';
import { NativeTranscriptStore } from '../state/nativeTranscriptStore.js';

function isConversationLoggingEnabled(): boolean {
  const raw = process.env.ADS_CONVERSATION_LOG;
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return false;
}

function buildNativeTranscriptId(input: {
  owner: string;
  sessionKey: string;
  projectId: string;
  domain?: string;
  lane: LaneName | 'default';
  lifecycle: SessionLifecycle;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: 2,
      owner: input.owner,
      sessionKey: input.sessionKey,
      projectId: input.projectId,
      domain: input.domain ?? "default",
      lane: input.lane,
      lifecycle: input.lifecycle,
    }))
    .digest('hex');
}

export type SessionDisposeReason = "idle_timeout" | "drop";

export interface SessionDisposeInfo {
  userId: number;
  reason: SessionDisposeReason;
  cwd?: string;
  clearSavedThread: boolean;
}

export interface SessionManagerOptions {
  agentAllowlist?: AgentIdentifier[];
  /** Optional role lane. Only the Web Advisor and Worker sessions set this value. */
  lane?: LaneName;
  /** Stable namespace for durable sessions that do not own a ThreadStorage instance. */
  sessionDomain?: string;
  /** State database used for the versioned lane prompt store. */
  stateDbPath?: string;
  createSession?: (args: {
    userId: number;
    authUserId?: string;
    cwd: string;
    resumeThread: boolean;
    resumeThreadId?: string;
    userModel?: string;
    userModelReasoningEffort?: string;
    activeAgentId?: AgentIdentifier;
    workspaceRoot: string;
    sandboxMode: SandboxMode;
    codexEnv?: NodeJS.ProcessEnv;
  }) => HybridOrchestrator;
  onDispose?: (info: SessionDisposeInfo) => void;
}

export type SessionAgentSurface =
  | "telegram"
  | "web-worker"
  | "web-advisor"
  | "scheduler-runtime"
  | "scheduler-compiler";

const CODEX_ONLY_AGENT_ALLOWLIST: AgentIdentifier[] = ["codex"];

export function resolveSessionAgentAllowlist(
  _surface: SessionAgentSurface,
  _env: NodeJS.ProcessEnv = process.env,
): AgentIdentifier[] {
  return CODEX_ONLY_AGENT_ALLOWLIST;
}

export class SessionManager {
  private readonly runtime = new SessionRuntimeRegistry<HybridOrchestrator, ConversationLogger>();
  private cleanupInterval?: NodeJS.Timeout;
  private sandboxMode: SandboxMode;
  private defaultModel?: string;
  private userModels = new Map<number, string>();
  private userReasoningEfforts = new Map<number, string>();
  private threadStorage?: ThreadStorage;
  private codexEnv?: NodeJS.ProcessEnv;
  private readonly runtimeBackend: AgentRuntimeBackend;
  private readonly logger = createLogger("SessionManager");

  constructor(
    private readonly sessionTimeoutMs: number = 30 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
    sandboxMode: SandboxMode = 'workspace-write',
    defaultModel?: string,
    threadStorage?: ThreadStorage,
    codexEnv?: NodeJS.ProcessEnv,
    private readonly options: SessionManagerOptions = {},
  ) {
    this.sandboxMode = sandboxMode;
    this.defaultModel = defaultModel;
    this.threadStorage = threadStorage;
    this.codexEnv = codexEnv;
    this.runtimeBackend = resolveAgentRuntime(codexEnv ?? process.env);
    if (this.sessionTimeoutMs > 0 && this.cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, this.cleanupIntervalMs);
    }
  }

  /**
   * `resumeThread` defaults to true: reattaching to the saved provider session
   * is the normal path, and every read-only caller that just needs an
   * orchestrator handle (agent snapshots, model overrides) would otherwise
   * silently create a *fresh* session and strand the saved thread id.
   * Callers that genuinely want a new thread — `/new`, an explicit task reset —
   * must opt out by passing false.
   */
  getOrCreate(
    userId: number,
    cwd?: string,
    resumeThread: boolean = true,
    options?: { projectId?: string; authUserId?: string; lifecycle?: SessionLifecycle },
  ): HybridOrchestrator {
    const lifecycle = options?.lifecycle ?? "durable";
    const existing = this.runtime.touch(userId);
    
    if (existing) {
      if (existing.lifecycle !== lifecycle) {
        throw new Error(
          `Session lifecycle mismatch for user ${userId}: active=${existing.lifecycle}, requested=${lifecycle}`,
        );
      }
      if (cwd) {
        const clearThreads = this.shouldClearThreadsForCwdChange(userId, cwd);
        if (this.runtime.updateWorkingDirectory(userId, cwd, { preserveSession: !clearThreads })) {
          if (clearThreads) {
            this.runtime.setContextRestoreMode(userId, "fresh");
            this.retargetNativeTranscriptForCwd(userId, existing, cwd, options?.projectId);
          }
          this.syncStoredState(userId, { cwd, clearThreads });
        }
      }
      this.runtime.ensureContextRestoreMode(userId);
      return existing.session;
    }

    const savedState = lifecycle === "ephemeral" ? undefined : this.getSavedState(userId);
    const userModel = this.userModels.get(userId) || savedState?.model || this.defaultModel;
    const userModelReasoningEffort = this.userReasoningEfforts.get(userId) || savedState?.modelReasoningEffort;
    const effectiveCwd = cwd || savedState?.cwd || process.cwd();
    const workspaceRoot = detectWorkspaceFrom(effectiveCwd);
    const nativeRuntime = this.runtimeBackend === "native";
    const owner = String(options?.authUserId ?? userId);
    const projectId = String(options?.projectId ?? "").trim() || deriveProjectSessionId(workspaceRoot);
    const nativeTranscriptId = nativeRuntime && lifecycle === "durable"
      ? buildNativeTranscriptId({
          owner,
          sessionKey: String(userId),
          projectId,
          domain: this.getSessionDomain(),
          lane: this.options.lane ?? "default",
          lifecycle,
        })
      : undefined;
    const restoreNativeTranscript = lifecycle === "durable" && Boolean(resumeThread);
    const nativeTranscriptAvailable = restoreNativeTranscript
      && (!savedState?.cwd || areSessionCwdsCompatible(savedState.cwd, effectiveCwd))
      && nativeTranscriptId
      ? new NativeTranscriptStore(getStateDatabase(this.options.stateDbPath))
          .loadCompletedMessages(nativeTranscriptId).length > 0
      : false;

    let activeAgentId: AgentIdentifier | undefined = savedState?.activeAgentId;
    const resumeState = resolveResumeState({
      userId,
      resumeThread,
      storage: lifecycle === "durable" ? this.threadStorage : undefined,
      logger: this.logger,
      currentCwd: effectiveCwd,
      runtimeBackend: this.runtimeBackend,
      nativeTranscriptAvailable,
    });
    activeAgentId = resumeState.activeAgentId ?? activeAgentId;
    if (resumeState.shouldInjectHistory) {
      this.runtime.markHistoryInjection(userId);
    }
    this.runtime.setContextRestoreMode(userId, resumeState.restoreMode);

    this.logger.info(
      `Creating new session with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''}${resumeState.resumeThreadId ? ` resume=${resumeState.resumeThreadId}` : ' (fresh)'} at cwd: ${effectiveCwd}`,
    );

    const session = this.options.createSession?.({
      userId,
      authUserId: options?.authUserId,
      cwd: effectiveCwd,
      resumeThread: lifecycle === "durable" && Boolean(resumeThread) && !nativeRuntime,
      resumeThreadId: nativeRuntime ? undefined : resumeState.resumeThreadId,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
      sandboxMode: this.sandboxMode,
      codexEnv: this.codexEnv,
    }) ?? this.createSession({
      userId,
      authUserId: options?.authUserId,
      effectiveCwd,
      resumeThreadId: nativeRuntime ? undefined : resumeState.resumeThreadId,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
      projectId: options?.projectId,
      lifecycle,
      restoreNativeTranscript: restoreNativeTranscript && resumeState.restoreMode === "thread_resumed",
    });

    this.runtime.trackSession(userId, session, effectiveCwd, {
      runtimeBackend: this.runtimeBackend,
      lifecycle,
      nativeTranscriptId,
      transcriptOwner: owner,
      projectId,
    });
    this.syncStoredState(userId);

    return session;
  }

  /** Dispose only the in-memory state owned by an ephemeral runtime session. */
  releaseEphemeralSession(userId: number): void {
    this.userModels.delete(userId);
    this.userReasoningEfforts.delete(userId);
    this.disposeSession(userId, "drop");
  }

  hasSession(userId: number): boolean {
    return this.runtime.hasSession(userId);
  }

  needsHistoryInjection(userId: number): boolean {
    return this.runtime.needsHistoryInjection(userId);
  }

  clearHistoryInjection(userId: number): void {
    this.runtime.clearHistoryInjection(userId);
  }

  markHistoryInjection(userId: number): void {
    this.runtime.markHistoryInjection(userId);
    this.runtime.setContextRestoreMode(userId, "history_injection");
  }

  getContextRestoreMode(userId: number): ContextRestoreMode {
    return this.runtime.getContextRestoreMode(userId);
  }

  getConfiguredAgentIds(): AgentIdentifier[] {
    return ["codex"];
  }

  getActiveAgentLabel(userId: number): string {
    const session = this.runtime.getSession(userId);
    if (!session) {
      return "Codex";
    }
    const activeId = session.getActiveAgentId();
    const descriptor = session.listAgents().find((entry) => entry.metadata.id === activeId);
    return descriptor?.metadata.name ?? String(activeId);
  }

  saveThreadId(userId: number, threadId: string, agentId?: string): void {
    const storage = this.threadStorage;
    if (!storage || this.runtimeBackend === "native" || this.runtime.getRecord(userId)?.lifecycle === "ephemeral") {
      return;
    }
    if (isNativeExecutionId(threadId)) {
      this.logger.warn("Refused to persist a Native execution ID as a Codex provider thread");
      return;
    }
    storage.setThreadId(userId, threadId, agentId ?? "codex");
    this.syncStoredState(userId);
  }

  getSavedThreadId(userId: number, agentId?: string): string | undefined {
    if (this.runtimeBackend === "native") {
      return undefined;
    }
    return this.threadStorage?.getThreadId(userId, agentId ?? "codex");
  }

  /** Forget one agent's saved session id after the provider reported it gone. */
  clearSavedThreadId(userId: number, agentId?: string): void {
    this.threadStorage?.clearThreadId(userId, agentId ?? "codex");
  }

  getSavedState(userId: number): SavedSessionState | undefined {
    return getSavedSessionState(this.threadStorage, userId);
  }

  getSavedResumeThreadId(userId: number): string | undefined {
    if (this.runtimeBackend === "native") {
      return undefined;
    }
    return getSavedResumeThreadId(this.threadStorage, userId);
  }

  clearSavedResumeThreadId(userId: number): void {
    clearSavedResumeThreadId(this.threadStorage, userId);
  }

  ensureLogger(userId: number): ConversationLogger | undefined {
    return this.runtime.ensureLogger(
      userId,
      isConversationLoggingEnabled(),
      (cwd, targetUserId, threadId) => new ConversationLogger(cwd, targetUserId, threadId, {
        persistThreadId: this.runtimeBackend === "codex-app-server",
      }),
    );
  }

  switchAgent(userId: number, agentId: string): { success: boolean; message: string } {
    const record = this.runtime.getRecord(userId);
    if (!record) {
      return { success: false, message: "❌ 没有找到活跃会话" };
    }
    if (agentId !== "codex") {
      return { success: false, message: `❌ 不支持代理: ${agentId}，ADS 已统一使用 Codex 引擎` };
    }
    try {
      record.session.switchAgent(agentId);
      record.lastActivity = Date.now();
      this.syncStoredState(userId);
      return { success: true, message: `✅ 当前代理: ${agentId}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `❌ ${msg}` };
    }
  }

  setUserModel(userId: number, model?: string): void {
    const normalized = String(model ?? "").trim();
    if (normalized) {
      this.userModels.set(userId, normalized);
    } else {
      this.userModels.delete(userId);
    }
    const record = this.runtime.getRecord(userId);
    const previousModel = record?.session.getModel?.() ?? this.getSavedState(userId)?.model ?? this.defaultModel;
    const activeAgentId = record?.session.getActiveAgentId?.();
    const preservesThread = activeAgentId
      ? record?.session.getAdapter?.(activeAgentId)?.preservesThreadOnModelChange === true
      : true;
    if (record) {
      record.session.setModel(normalized || undefined);
      record.lastActivity = Date.now();
    }
    const modelChanged = previousModel !== (normalized || undefined);
    if (modelChanged && record && !preservesThread) {
      if (activeAgentId) {
        this.threadStorage?.clearThreadId(userId, activeAgentId);
      }
      this.markHistoryInjection(userId);
    }
    this.syncStoredState(userId);
    this.logger.info(`Switched to model: ${normalized || "(default)"}`);
  }

  getUserModel(userId: number): string {
    const sessionModel = this.runtime.getSession(userId)?.getModel?.();
    return (
      sessionModel ||
      this.userModels.get(userId) ||
      this.getSavedState(userId)?.model ||
      this.defaultModel ||
      'default'
    );
  }

  setUserModelReasoningEffort(userId: number, effort?: string): void {
    const normalized = String(effort ?? "").trim();
    if (normalized) {
      this.userReasoningEfforts.set(userId, normalized);
    } else {
      this.userReasoningEfforts.delete(userId);
    }
    const record = this.runtime.getRecord(userId);
    if (record) {
      record.session.setModelReasoningEffort(normalized || undefined);
      record.lastActivity = Date.now();
    }
    this.syncStoredState(userId);
  }

  getUserModelReasoningEffort(userId: number): string | undefined {
    return (
      this.runtime.getSession(userId)?.getModelReasoningEffort?.() ||
      this.userReasoningEfforts.get(userId) ||
      this.getSavedState(userId)?.modelReasoningEffort
    );
  }

  getEffectiveState(userId: number): {
    model?: string;
    modelReasoningEffort?: string;
    activeAgentId: AgentIdentifier;
    runtimeBackend: AgentRuntimeBackend;
    lifecycle: SessionLifecycle;
  } {
    const record = this.runtime.getRecord(userId);
    const saved = this.getSavedState(userId);
    const activeAgentId =
      (record?.session.getActiveAgentId?.() as AgentIdentifier | undefined) ||
      saved?.activeAgentId ||
      "codex";
    return {
      model: record?.session.getModel?.() || this.userModels.get(userId) || saved?.model || this.defaultModel,
      modelReasoningEffort:
        record?.session.getModelReasoningEffort?.() ||
        this.userReasoningEfforts.get(userId) ||
        saved?.modelReasoningEffort,
      activeAgentId,
      runtimeBackend: record?.runtimeBackend ?? this.runtimeBackend,
      lifecycle: record?.lifecycle ?? "durable",
    };
  }

  getDefaultModel(): string {
    return this.defaultModel || 'default';
  }

  getSandboxMode(): SandboxMode {
    return this.sandboxMode;
  }

  getCodexEnv(): NodeJS.ProcessEnv | undefined {
    return this.codexEnv;
  }

  getRuntimeBackend(): AgentRuntimeBackend {
    return this.runtimeBackend;
  }

  private getSessionDomain(): string {
    return this.threadStorage?.getNamespace() ?? this.options.sessionDomain ?? "default";
  }

  private retargetNativeTranscriptForCwd(
    userId: number,
    record: SessionRuntimeRecord<HybridOrchestrator, ConversationLogger>,
    cwd: string,
    explicitProjectId?: string,
  ): void {
    if (record.runtimeBackend !== "native") {
      record.nativeTranscriptId = undefined;
      return;
    }
    const projectId = String(explicitProjectId ?? "").trim()
      || deriveProjectSessionId(detectWorkspaceFrom(cwd));
    const transcriptId = buildNativeTranscriptId({
      owner: record.transcriptOwner ?? String(userId),
      sessionKey: String(userId),
      projectId,
      domain: this.getSessionDomain(),
      lane: this.options.lane ?? "default",
      lifecycle: record.lifecycle,
    });
    const adapter = record.session.getAdapter("codex");
    if (adapter instanceof NativeAgentAdapter) {
      adapter.retargetTranscript(transcriptId);
    }
    record.nativeTranscriptId = transcriptId;
    record.projectId = projectId;
  }

  reset(userId: number, options?: { preserveThreadForResume?: boolean }): void {
    const record = this.runtime.getRecord(userId);
    const storage = this.threadStorage;
    const savedState = storage?.getRecord(userId);
    const nativeTranscriptId = record?.nativeTranscriptId ?? savedState?.nativeTranscriptId;
    if (this.runtimeBackend === "native" && nativeTranscriptId) {
      new NativeTranscriptStore(getStateDatabase(this.options.stateDbPath)).clear(nativeTranscriptId);
    }
    const preserve = Boolean(options?.preserveThreadForResume) && this.runtimeBackend === "codex-app-server";
    if (storage) {
      if (preserve) {
        const savedState = storage.getRecord(userId);
        const nextState = buildPreservedResetState({
          currentThreadId: record?.session.getThreadId() ?? null,
          savedThreadId: this.getSavedThreadId(userId),
          savedState,
          cwd: record?.cwd ?? savedState?.cwd,
        });
        if (nextState) {
          storage.setRecord(userId, nextState);
        } else {
          storage.removeThread(userId);
        }
      } else {
        storage.removeThread(userId);
      }
    }
    if (record) {
      record.session.reset({ clearPersistedState: true });
      record.lastActivity = Date.now();
      this.runtime.closeLogger(userId);
      this.logger.info('Session reset');
    } else {
      this.logger.debug('Reset requested without active session');
    }
    this.runtime.clearHistoryInjection(userId);
    this.runtime.setContextRestoreMode(userId, "fresh");
  }

  dropSession(userId: number, options?: { clearSavedThread?: boolean }): void {
    this.disposeSession(userId, "drop", options);
  }

  getUserCwd(userId: number): string | undefined {
    return this.runtime.getUserCwd(userId);
  }

  setUserCwd(userId: number, cwd: string): void {
    const record = this.runtime.getRecord(userId);
    if (!record) {
      return;
    }

    if (record.cwd === cwd) {
      return;
    }

    const clearThreads = this.shouldClearThreadsForCwdChange(userId, cwd);
    this.runtime.updateWorkingDirectory(userId, cwd, { preserveSession: !clearThreads });
    if (clearThreads) {
      this.runtime.setContextRestoreMode(userId, "fresh");
      this.retargetNativeTranscriptForCwd(userId, record, cwd);
    }
    this.syncStoredState(userId, { cwd, clearThreads });
  }

  getStats(): { total: number; active: number; idle: number; sandboxMode: SandboxMode; defaultModel: string } {
    const now = Date.now();
    let active = 0;
    let idle = 0;

    if (this.sessionTimeoutMs <= 0) {
      return {
        total: this.runtime.size,
        active: this.runtime.size,
        idle: 0,
        sandboxMode: this.sandboxMode,
        defaultModel: this.defaultModel || 'default',
      };
    }

    for (const record of this.runtime.records()) {
      if (now - record.lastActivity < this.sessionTimeoutMs) {
        active++;
      } else {
        idle++;
      }
    }

    return {
      total: this.runtime.size,
      active,
      idle,
      sandboxMode: this.sandboxMode,
      defaultModel: this.defaultModel || 'default',
    };
  }

  private cleanup(): void {
    if (this.sessionTimeoutMs <= 0) {
      return;
    }
    for (const userId of this.runtime.getExpiredUserIds(this.sessionTimeoutMs)) {
      this.disposeSession(userId, "idle_timeout");
      this.logger.debug('Cleaned up idle session');
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.runtime.destroy();
  }

  private createSession(args: {
    userId: number;
    authUserId?: string;
    effectiveCwd: string;
    resumeThreadId?: string;
    userModel?: string;
    userModelReasoningEffort?: string;
    activeAgentId?: AgentIdentifier;
    workspaceRoot: string;
    projectId?: string;
    lifecycle: SessionLifecycle;
    restoreNativeTranscript: boolean;
  }): HybridOrchestrator {
    const adapters = this.createAdapters(args);

    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: detectWorkspaceFrom(args.workspaceRoot),
      lane: this.options.lane,
      stateDbPath: this.options.stateDbPath,
      reinjection: resolveReinjectionConfig(),
    });

    const orchestrator = new HybridOrchestrator({
      adapters,
      defaultAgentId: args.activeAgentId ?? "codex",
      initialWorkingDirectory: args.effectiveCwd,
      initialModel: args.userModel,
      systemPromptManager,
    });
    if (args.userModelReasoningEffort) {
      orchestrator.setModelReasoningEffort(args.userModelReasoningEffort);
    }
    return orchestrator;
  }

  private createAdapters(args: {
    userId: number;
    authUserId?: string;
    effectiveCwd: string;
    resumeThreadId?: string;
    userModel?: string;
    userModelReasoningEffort?: string;
    workspaceRoot: string;
    projectId?: string;
    lifecycle: SessionLifecycle;
    restoreNativeTranscript: boolean;
  }): AgentAdapter[] {
    const projectId = String(args.projectId ?? "").trim() || deriveProjectSessionId(args.workspaceRoot);

    if (this.runtimeBackend === "native") {
      const owner = String(args.authUserId ?? args.userId);
      return [
        new NativeAgentAdapter({
          credentialOwner: owner,
          stateDbPath: this.options.stateDbPath,
          workspaceRoot: args.workspaceRoot,
          workingDirectory: args.effectiveCwd,
          model: args.userModel,
          modelReasoningEffort: args.userModelReasoningEffort,
          resumeThreadId: args.resumeThreadId,
          env: this.codexEnv,
          transcriptId: args.lifecycle === "durable"
            ? buildNativeTranscriptId({
                owner,
                sessionKey: String(args.userId),
                projectId,
                domain: this.getSessionDomain(),
                lane: this.options.lane ?? "default",
                lifecycle: args.lifecycle,
              })
            : undefined,
          transcriptMode: args.lifecycle !== "durable"
            ? "disabled"
            : args.restoreNativeTranscript
              ? "restore"
              : "replace",
        }),
      ];
    }

    return [
      new CodexAppServerAdapter({
        projectId,
        sandboxMode: this.sandboxMode,
        model: args.userModel,
        workingDirectory: args.effectiveCwd,
        resumeThreadId: args.resumeThreadId,
        env: this.codexEnv,
      }),
    ];
  }

  private syncStoredState(userId: number, options?: { cwd?: string; clearThreads?: boolean }): void {
    const storage = this.threadStorage;
    if (!storage) {
      return;
    }
    const sessionRecord = this.runtime.getRecord(userId);
    if (!sessionRecord || sessionRecord.lifecycle === "ephemeral") {
      return;
    }
    const session = sessionRecord?.session;
    storage.setRecord(
      userId,
      buildSyncedSessionState({
        storedState: getSavedSessionState(storage, userId),
        sessionState: sessionRecord
          ? {
              cwd: sessionRecord.cwd,
              model: session?.getModel?.(),
              modelReasoningEffort: session?.getModelReasoningEffort?.(),
              activeAgentId: session?.getActiveAgentId?.() as AgentIdentifier | undefined,
              runtimeBackend: sessionRecord.runtimeBackend,
              lifecycle: sessionRecord.lifecycle,
            }
          : undefined,
        userModel: this.userModels.get(userId),
        userModelReasoningEffort: this.userReasoningEfforts.get(userId),
        defaultModel: this.defaultModel,
        cwd: options?.cwd,
        clearThreads: options?.clearThreads,
        runtimeBackend: sessionRecord.runtimeBackend,
        lifecycle: sessionRecord.lifecycle,
        nativeTranscriptId: sessionRecord.nativeTranscriptId ?? getSavedSessionState(storage, userId)?.nativeTranscriptId,
      }),
    );
  }

  private shouldClearThreadsForCwdChange(userId: number, nextCwd: string): boolean {
    const savedCwd = this.getSavedState(userId)?.cwd ?? this.runtime.getRecord(userId)?.cwd;
    return shouldClearSavedThreadsForCwdChange(savedCwd, nextCwd);
  }

  private disposeSession(userId: number, reason: SessionDisposeReason, options?: { clearSavedThread?: boolean }): void {
    const clearSavedThread = Boolean(options?.clearSavedThread);
    if (clearSavedThread) {
      this.threadStorage?.removeThread(userId);
    }
    const record = this.runtime.releaseSession(userId);
    this.options.onDispose?.({
      userId,
      reason,
      cwd: record?.cwd,
      clearSavedThread,
    });
  }
}
