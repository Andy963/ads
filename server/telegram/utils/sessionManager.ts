import type { SandboxMode } from '../config.js';
import { createLogger } from '../../utils/logger.js';
import type { AgentEvent } from '../../codex/events.js';
import type { Input } from '../../agents/protocol/types.js';
import { CodexCliAdapter } from '../../agents/adapters/codexCliAdapter.js';
import { ClaudeCliAdapter } from '../../agents/adapters/claudeCliAdapter.js';
import { GeminiCliAdapter } from '../../agents/adapters/geminiCliAdapter.js';
import type { AgentAdapter, AgentIdentifier, AgentRunResult, AgentSendOptions } from '../../agents/types.js';
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
} from './sessionState.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../../systemPrompt/manager.js';
import { detectWorkspaceFrom } from '../../workspace/detector.js';

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

interface SessionRecord {
  session: HybridOrchestrator;
  lastActivity: number;
  cwd: string;
  logger?: ConversationLogger;
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
  createSession?: (args: {
    userId: number;
    cwd: string;
    resumeThread: boolean;
    resumeThreadId?: string;
    resumeThreadIds?: Partial<Record<AgentIdentifier, string>>;
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
  | "web-reviewer"
  | "task-queue"
  | "scheduler-runtime"
  | "scheduler-compiler";

const INTERACTIVE_AGENT_ALLOWLIST: AgentIdentifier[] = ["codex", "claude", "gemini"];
const CODEX_ONLY_AGENT_ALLOWLIST: AgentIdentifier[] = ["codex"];

export function resolveSessionAgentAllowlist(
  surface: SessionAgentSurface,
  env: NodeJS.ProcessEnv = process.env,
): AgentIdentifier[] {
  const preferred =
    surface === "telegram" || surface === "web-worker" || surface === "web-planner"
      ? INTERACTIVE_AGENT_ALLOWLIST
      : CODEX_ONLY_AGENT_ALLOWLIST;

  return preferred.filter((agentId) => {
    if (agentId === "claude") {
      return env.ADS_CLAUDE_ENABLED !== "0";
    }
    if (agentId === "gemini") {
      return env.ADS_GEMINI_ENABLED !== "0";
    }
    return true;
  });
}

export interface SessionWrapper {
  send(prompt: Input, options?: AgentSendOptions): Promise<AgentRunResult>;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  getThreadId(): string | null;
  reset(): void;
  setModel(model?: string): void;
  setWorkingDirectory(workingDirectory?: string): void;
  status(): { ready: boolean; error?: string; streaming: boolean };
  getActiveAgentId(): string;
  listAgents(): Array<{
    metadata: { id: string; name: string };
    status: { ready: boolean; error?: string };
  }>;
}

function resolveResumeTtlMs(): number {
  const raw = process.env.ADS_THREAD_RESUME_TTL_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 2 * 60 * 60 * 1000; // 2 hours
}

export class SessionManager {
  private sessions = new Map<number, SessionRecord>();
  private cleanupInterval?: NodeJS.Timeout;
  private sandboxMode: SandboxMode;
  private defaultModel?: string;
  private userModels = new Map<number, string>();
  private userReasoningEfforts = new Map<number, string>();
  private threadStorage?: ThreadStorage;
  private codexEnv?: NodeJS.ProcessEnv;
  private readonly logger = createLogger("SessionManager");
  private readonly resumeTtlMs = resolveResumeTtlMs();
  private readonly pendingHistoryInjections = new Set<number>();
  private readonly contextRestoreModes = new Map<number, ContextRestoreMode>();

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

  getOrCreate(userId: number, cwd?: string, resumeThread?: boolean): HybridOrchestrator {
    const existing = this.sessions.get(userId);
    
    if (existing) {
      existing.lastActivity = Date.now();
      if (cwd && cwd !== existing.cwd) {
        existing.cwd = cwd;
        existing.session.setWorkingDirectory(cwd);
        this.syncStoredState(userId, { cwd, clearThreads: true });
        existing.logger?.close();
        existing.logger = undefined;
      }
      if (!this.contextRestoreModes.has(userId)) {
        this.contextRestoreModes.set(userId, this.pendingHistoryInjections.has(userId) ? "history_injection" : "fresh");
      }
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
      resumeTtlMs: this.resumeTtlMs,
    });
    activeAgentId = resumeState.activeAgentId ?? activeAgentId;
    if (resumeState.shouldInjectHistory) {
      this.pendingHistoryInjections.add(userId);
    }
    this.contextRestoreModes.set(userId, resumeState.restoreMode);

    this.logger.info(
      `Creating new session with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''}${resumeState.resumeThreadId ? ` resume=${resumeState.resumeThreadId}` : ' (fresh)'} at cwd: ${effectiveCwd}`,
    );

    const session = this.options.createSession?.({
      userId,
      cwd: effectiveCwd,
      resumeThread: Boolean(resumeThread),
      resumeThreadId: resumeState.resumeThreadId,
      resumeThreadIds: resumeState.resumeThreadIds,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
      sandboxMode: this.sandboxMode,
      codexEnv: this.codexEnv,
    }) ?? this.createSession({
      effectiveCwd,
      resumeThreadId: resumeState.resumeThreadId,
      resumeThreadIds: resumeState.resumeThreadIds,
      userModel,
      userModelReasoningEffort,
      activeAgentId,
      workspaceRoot,
    });

    this.sessions.set(userId, {
      session,
      lastActivity: Date.now(),
      cwd: effectiveCwd,
    });

    return session;
  }

  hasSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  needsHistoryInjection(userId: number): boolean {
    return this.pendingHistoryInjections.has(userId);
  }

  clearHistoryInjection(userId: number): void {
    this.pendingHistoryInjections.delete(userId);
    if (this.contextRestoreModes.get(userId) === "history_injection") {
      this.contextRestoreModes.set(userId, "fresh");
    }
  }

  getContextRestoreMode(userId: number): ContextRestoreMode {
    if (this.pendingHistoryInjections.has(userId)) {
      return "history_injection";
    }
    return this.contextRestoreModes.get(userId) ?? "fresh";
  }

  getConfiguredAgentIds(): AgentIdentifier[] {
    const configured = this.options.agentAllowlist;
    if (configured && configured.length > 0) {
      return [...configured];
    }
    return ["codex"];
  }

  getActiveAgentLabel(userId: number): string {
    const session = this.sessions.get(userId)?.session;
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

  getSavedState(userId: number): SavedSessionState | undefined {
    return getSavedSessionState(this.threadStorage, userId);
  }

  maybeMigrateThreadState(fromUserId: number, toUserId: number): boolean {
    if (fromUserId === toUserId) {
      return false;
    }
    const storage = this.threadStorage;
    if (!storage) {
      return false;
    }

    const migrated = storage.cloneRecord(fromUserId, toUserId);
    if (!migrated) {
      return false;
    }

    const model = this.userModels.get(fromUserId);
    if (model && !this.userModels.has(toUserId)) {
      this.userModels.set(toUserId, model);
    }
    const reasoningEffort = this.userReasoningEfforts.get(fromUserId);
    if (reasoningEffort && !this.userReasoningEfforts.has(toUserId)) {
      this.userReasoningEfforts.set(toUserId, reasoningEffort);
    }
    if (this.pendingHistoryInjections.has(fromUserId)) {
      this.pendingHistoryInjections.add(toUserId);
    }
    const restoreMode = this.contextRestoreModes.get(fromUserId);
    if (restoreMode && !this.contextRestoreModes.has(toUserId)) {
      this.contextRestoreModes.set(toUserId, restoreMode);
    }

    return true;
  }

  getSavedResumeThreadId(userId: number): string | undefined {
    return getSavedResumeThreadId(this.threadStorage, userId);
  }

  clearSavedResumeThreadId(userId: number): void {
    clearSavedResumeThreadId(this.threadStorage, userId);
  }

  ensureLogger(userId: number): ConversationLogger | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
      return undefined;
    }

    record.lastActivity = Date.now();

    if (!isConversationLoggingEnabled()) {
      return undefined;
    }

    if (record.logger && !record.logger.isClosed) {
      record.logger.attachThreadId(record.session.getThreadId());
      return record.logger;
    }

    const threadId = record.session.getThreadId() ?? undefined;
    record.logger = new ConversationLogger(record.cwd, userId, threadId);
    return record.logger;
  }

  switchAgent(userId: number, agentId: string): { success: boolean; message: string } {
    const record = this.sessions.get(userId);
    if (!record) {
      return { success: false, message: "❌ 没有找到活跃会话" };
    }
    try {
      record.session.switchAgent(agentId);
      record.lastActivity = Date.now();
      this.syncStoredState(userId);
      return { success: true, message: `✅ 已切换到代理: ${agentId}` };
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
    const record = this.sessions.get(userId);
    const previousModel = record?.session.getModel?.() ?? this.getSavedState(userId)?.model ?? this.defaultModel;
    if (record) {
      record.session.setModel(normalized || undefined);
      record.lastActivity = Date.now();
    }
    this.contextRestoreModes.set(userId, "fresh");
    this.syncStoredState(userId, { clearThreads: previousModel !== (normalized || undefined) });
    this.logger.info(`Switched to model: ${normalized || "(default)"}`);
  }

  getUserModel(userId: number): string {
    const sessionModel = this.sessions.get(userId)?.session.getModel?.();
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
    const record = this.sessions.get(userId);
    if (record) {
      record.session.setModelReasoningEffort(normalized || undefined);
      record.lastActivity = Date.now();
    }
    this.syncStoredState(userId);
  }

  getUserModelReasoningEffort(userId: number): string | undefined {
    return (
      this.sessions.get(userId)?.session.getModelReasoningEffort?.() ||
      this.userReasoningEfforts.get(userId) ||
      this.getSavedState(userId)?.modelReasoningEffort
    );
  }

  getEffectiveState(userId: number): {
    model?: string;
    modelReasoningEffort?: string;
    activeAgentId: AgentIdentifier;
  } {
    const record = this.sessions.get(userId);
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
    const record = this.sessions.get(userId);
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
      record.logger?.close();
      record.logger = undefined;
      this.logger.info('Session reset');
    } else {
      this.logger.debug('Reset requested without active session');
    }
    this.pendingHistoryInjections.delete(userId);
    this.contextRestoreModes.set(userId, "fresh");
  }

  dropSession(userId: number, options?: { clearSavedThread?: boolean }): void {
    this.disposeSession(userId, "drop", options);
  }

  getUserCwd(userId: number): string | undefined {
    return this.sessions.get(userId)?.cwd;
  }

  setUserCwd(userId: number, cwd: string): void {
    const record = this.sessions.get(userId);
    if (!record) {
      return;
    }

    if (record.cwd === cwd) {
      return;
    }

    record.cwd = cwd;
    record.session.setWorkingDirectory(cwd);
    this.contextRestoreModes.set(userId, "fresh");
    this.syncStoredState(userId, { cwd, clearThreads: true });
    record.logger?.close();
    record.logger = undefined;
  }

  getStats(): { total: number; active: number; idle: number; sandboxMode: SandboxMode; defaultModel: string } {
    const now = Date.now();
    let active = 0;
    let idle = 0;

    if (this.sessionTimeoutMs <= 0) {
      return {
        total: this.sessions.size,
        active: this.sessions.size,
        idle: 0,
        sandboxMode: this.sandboxMode,
        defaultModel: this.defaultModel || 'default',
      };
    }

    for (const record of this.sessions.values()) {
      if (now - record.lastActivity < this.sessionTimeoutMs) {
        active++;
      } else {
        idle++;
      }
    }

    return {
      total: this.sessions.size,
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
    const now = Date.now();
    const expiredUsers: number[] = [];

    for (const [userId, record] of this.sessions.entries()) {
      if (now - record.lastActivity > this.sessionTimeoutMs) {
        expiredUsers.push(userId);
      }
    }

    for (const userId of expiredUsers) {
      this.disposeSession(userId, "idle_timeout");
      this.logger.debug('Cleaned up idle session');
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    for (const record of this.sessions.values()) {
      record.logger?.close();
    }
    this.sessions.clear();
    this.pendingHistoryInjections.clear();
    this.contextRestoreModes.clear();
  }

  private createSession(args: {
    effectiveCwd: string;
    resumeThreadId?: string;
    resumeThreadIds?: Partial<Record<AgentIdentifier, string>>;
    userModel?: string;
    userModelReasoningEffort?: string;
    activeAgentId?: AgentIdentifier;
    workspaceRoot: string;
  }): HybridOrchestrator {
    const adapters = this.createAdapters(args);

    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: args.workspaceRoot,
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
    effectiveCwd: string;
    resumeThreadId?: string;
    resumeThreadIds?: Partial<Record<AgentIdentifier, string>>;
    userModel?: string;
  }): AgentAdapter[] {
    const allowlist = this.getConfiguredAgentIds();
    const adapters: AgentAdapter[] = [];

    for (const agentId of allowlist) {
      if (agentId === "codex") {
        adapters.push(
          new CodexCliAdapter({
            sandboxMode: this.sandboxMode,
            model: args.userModel,
            workingDirectory: args.effectiveCwd,
            resumeThreadId: args.resumeThreadIds?.codex ?? args.resumeThreadId,
            env: this.codexEnv,
          }),
        );
        continue;
      }

      if (agentId === "claude") {
        adapters.push(
          new ClaudeCliAdapter({
            sandboxMode: this.sandboxMode,
            workingDirectory: args.effectiveCwd,
            sessionId: args.resumeThreadIds?.claude,
          }),
        );
        continue;
      }

      if (agentId === "gemini") {
        adapters.push(
          new GeminiCliAdapter({
            sandboxMode: this.sandboxMode,
            workingDirectory: args.effectiveCwd,
            sessionId: args.resumeThreadIds?.gemini,
          }),
        );
      }
    }

    if (adapters.length === 0) {
      throw new Error("SessionManager requires at least one enabled agent adapter");
    }

    return adapters;
  }

  private syncStoredState(userId: number, options?: { cwd?: string; clearThreads?: boolean }): void {
    const storage = this.threadStorage;
    if (!storage) {
      return;
    }
    const sessionRecord = this.sessions.get(userId);
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

  private disposeSession(userId: number, reason: SessionDisposeReason, options?: { clearSavedThread?: boolean }): void {
    const clearSavedThread = Boolean(options?.clearSavedThread);
    const record = this.sessions.get(userId);
    if (clearSavedThread) {
      this.threadStorage?.removeThread(userId);
    }
    if (record) {
      try {
        record.session.reset();
      } catch {
        // ignore
      }
      record.logger?.close();
      this.sessions.delete(userId);
    }
    this.pendingHistoryInjections.delete(userId);
    this.contextRestoreModes.delete(userId);
    this.options.onDispose?.({
      userId,
      reason,
      cwd: record?.cwd,
      clearSavedThread,
    });
  }
}
