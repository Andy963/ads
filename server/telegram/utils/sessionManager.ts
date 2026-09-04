import type { SandboxMode } from '../config.js';
import { createLogger } from '../../utils/logger.js';
import { CodexAppServerAdapter } from '../../agents/adapters/codexAppServerAdapter.js';
import type { AgentAdapter, AgentIdentifier } from '../../agents/types.js';
import { HybridOrchestrator } from '../../agents/orchestrator.js';
import { ConversationLogger } from '../../utils/conversationLogger.js';
import { ThreadStorage } from './threadStorage.js';
import {
  buildPreservedResetState,
  buildSyncedSessionState,
  clearSavedResumeThreadId,
  type ContextRestoreMode,
  getSavedResumeThreadId,
  getSavedSessionState,
  resolveResumeState,
  type SavedSessionState,
  shouldClearSavedThreadsForCwdChange,
} from './sessionState.js';
import { SessionRuntimeRegistry } from './sessionRuntimeRegistry.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../../systemPrompt/manager.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';
import { deriveProjectSessionId } from '../../web/server/projectSessionId.js';

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

export type SessionDisposeReason = "idle_timeout" | "drop";

export interface SessionDisposeInfo {
  userId: number;
  reason: SessionDisposeReason;
  cwd?: string;
  clearSavedThread: boolean;
}

export interface SessionManagerOptions {
  agentAllowlist?: AgentIdentifier[];
  /** Template file injected into this lane's system prompt only (see SystemPromptManager). */
  laneInstructionsFile?: string;
  createSession?: (args: {
    userId: number;
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
  | "web-planner"
  | "task-queue"
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
    options?: { projectId?: string },
  ): HybridOrchestrator {
    const existing = this.runtime.touch(userId);
    
    if (existing) {
      if (cwd) {
        const clearThreads = this.shouldClearThreadsForCwdChange(userId, cwd);
        if (this.runtime.updateWorkingDirectory(userId, cwd, { preserveSession: !clearThreads })) {
          if (clearThreads) {
            this.runtime.setContextRestoreMode(userId, "fresh");
          }
          this.syncStoredState(userId, { cwd, clearThreads });
        }
      }
      this.runtime.ensureContextRestoreMode(userId);
      return existing.session;
    }

    const savedState = this.getSavedState(userId);
    const userModel = this.userModels.get(userId) || savedState?.model || this.defaultModel;
    const userModelReasoningEffort = this.userReasoningEfforts.get(userId) || savedState?.modelReasoningEffort;
    const effectiveCwd = cwd || savedState?.cwd || process.cwd();
    const workspaceRoot = detectWorkspaceFrom(effectiveCwd);

    let activeAgentId: AgentIdentifier | undefined = savedState?.activeAgentId;
    const resumeState = resolveResumeState({
      userId,
      resumeThread,
      storage: this.threadStorage,
      logger: this.logger,
      currentCwd: effectiveCwd,
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
      cwd: effectiveCwd,
      resumeThread: Boolean(resumeThread),
      resumeThreadId: resumeState.resumeThreadId,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
      sandboxMode: this.sandboxMode,
      codexEnv: this.codexEnv,
    }) ?? this.createSession({
      effectiveCwd,
      resumeThreadId: resumeState.resumeThreadId,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
      projectId: options?.projectId,
    });

    this.runtime.trackSession(userId, session, effectiveCwd);

    return session;
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
    if (!storage) {
      return;
    }
    storage.setThreadId(userId, threadId, agentId ?? "codex");
    this.syncStoredState(userId);
  }

  getSavedThreadId(userId: number, agentId?: string): string | undefined {
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
    return getSavedResumeThreadId(this.threadStorage, userId);
  }

  clearSavedResumeThreadId(userId: number): void {
    clearSavedResumeThreadId(this.threadStorage, userId);
  }

  ensureLogger(userId: number): ConversationLogger | undefined {
    return this.runtime.ensureLogger(
      userId,
      isConversationLoggingEnabled(),
      (cwd, targetUserId, threadId) => new ConversationLogger(cwd, targetUserId, threadId),
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

  reset(userId: number, options?: { preserveThreadForResume?: boolean }): void {
    const record = this.runtime.getRecord(userId);
    const storage = this.threadStorage;
    const preserve = Boolean(options?.preserveThreadForResume);
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
      record.session.reset();
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
    effectiveCwd: string;
    resumeThreadId?: string;
    userModel?: string;
    userModelReasoningEffort?: string;
    activeAgentId?: AgentIdentifier;
    workspaceRoot: string;
    projectId?: string;
  }): HybridOrchestrator {
    const adapters = this.createAdapters(args);

    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: args.workspaceRoot,
      reinjection: resolveReinjectionConfig(),
      laneInstructionsFile: this.options.laneInstructionsFile,
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
    effectiveCwd: string;
    resumeThreadId?: string;
    userModel?: string;
    userModelReasoningEffort?: string;
    workspaceRoot: string;
    projectId?: string;
  }): AgentAdapter[] {
    const projectId = String(args.projectId ?? "").trim() || deriveProjectSessionId(args.workspaceRoot);

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
            }
          : undefined,
        userModel: this.userModels.get(userId),
        userModelReasoningEffort: this.userReasoningEfforts.get(userId),
        defaultModel: this.defaultModel,
        cwd: options?.cwd,
        clearThreads: options?.clearThreads,
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
