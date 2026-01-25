import type { SandboxMode } from '../config.js';
import { createLogger } from '../../utils/logger.js';
import type { AgentEvent } from '../../codex/events.js';
import type { Input } from '@openai/codex-sdk';
import { CodexAgentAdapter } from '../../agents/adapters/codexAdapter.js';
import { HybridOrchestrator } from '../../agents/orchestrator.js';
import type { AgentRunResult, AgentSendOptions } from '../../agents/types.js';
import { ConversationLogger } from '../../utils/conversationLogger.js';
import { ThreadStorage } from './threadStorage.js';

interface SessionRecord {
  session: HybridOrchestrator;
  lastActivity: number;
  cwd: string;
  logger?: ConversationLogger;
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

export class SessionManager {
  private sessions = new Map<number, SessionRecord>();
  private cleanupInterval?: NodeJS.Timeout;
  private sandboxMode: SandboxMode;
  private defaultModel?: string;
  private userModels = new Map<number, string>();
  private threadStorage?: ThreadStorage;
  private readonly logger = createLogger("SessionManager");

  constructor(
    private readonly sessionTimeoutMs: number = 30 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
    sandboxMode: SandboxMode = 'workspace-write',
    defaultModel?: string,
    threadStorage?: ThreadStorage,
  ) {
    this.sandboxMode = sandboxMode;
    this.defaultModel = defaultModel;
    this.threadStorage = threadStorage;
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
        existing.logger?.close();
        existing.logger = undefined;
      }
      return existing.session;
    }

    const userModel = this.userModels.get(userId) || this.defaultModel;
    const savedState = resumeThread ? this.getSavedState(userId) : undefined;
    const effectiveCwd = cwd || savedState?.cwd || process.cwd();
    const resumeThreadId = resumeThread ? this.getSavedThreadId(userId) : undefined;

    this.logger.info(
      `Creating new session with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''} at cwd: ${effectiveCwd}`,
    );

    const adapter = new CodexAgentAdapter({
      streamingEnabled: true,
      sandboxMode: this.sandboxMode,
      model: userModel,
      workingDirectory: effectiveCwd,
      networkAccessEnabled: true,
      resumeThreadId,
    });

    const session = new HybridOrchestrator({
      adapters: [adapter],
      defaultAgentId: "codex",
      initialWorkingDirectory: effectiveCwd,
      initialModel: userModel,
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

    const cwd = this.getUserCwd(userId);
    if (!cwd) {
      return;
    }
    const record = storage.getRecord(userId);
    if (!record) {
      return;
    }
    storage.setRecord(userId, { ...record, cwd });
  }

  getSavedThreadId(userId: number, agentId?: string): string | undefined {
    return this.threadStorage?.getThreadId(userId, agentId ?? "codex");
  }

  getSavedState(userId: number): { threadId?: string; cwd?: string } | undefined {
    const record = this.threadStorage?.getRecord(userId);
    if (!record) {
      return undefined;
    }
    return { threadId: record.threadId, cwd: record.cwd };
  }

  ensureLogger(userId: number): ConversationLogger | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
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
      return { success: true, message: `✅ 已切换到代理: ${agentId}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `❌ ${msg}` };
    }
  }

  setUserModel(userId: number, model: string): void {
    this.userModels.set(userId, model);
    const record = this.sessions.get(userId);
    if (record) {
      record.session.setModel(model);
      record.lastActivity = Date.now();
    }
    this.logger.info(`Switched to model: ${model}`);
  }

  getUserModel(userId: number): string {
    return this.userModels.get(userId) || this.defaultModel || 'default';
  }

  getDefaultModel(): string {
    return this.defaultModel || 'default';
  }

  reset(userId: number): void {
    const record = this.sessions.get(userId);
    this.threadStorage?.removeThread(userId);
    if (record) {
      record.session.reset();
      record.lastActivity = Date.now();
      record.logger?.close();
      record.logger = undefined;
      this.logger.info('Session reset');
    } else {
      this.logger.debug('Reset requested without active session');
    }
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
      const record = this.sessions.get(userId);
      record?.logger?.close();
      this.sessions.delete(userId);
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
  }
}
