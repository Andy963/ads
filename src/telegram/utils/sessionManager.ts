import { CodexSession, type CodexSessionOptions, type CodexSendOptions, type CodexSendResult } from '../../codex/codexChat.js';
import type { SandboxMode } from '../config.js';
import { createLogger } from '../../utils/logger.js';
import type { AgentEvent } from '../../codex/events.js';
import type { Input } from '@openai/codex-sdk';

interface SessionRecord {
  session: CodexSession;
  lastActivity: number;
  cwd: string;
}

export interface SessionWrapper {
  send(prompt: Input, options?: CodexSendOptions): Promise<CodexSendResult>;
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
  private readonly logger = createLogger("SessionManager");

  constructor(
    private readonly sessionTimeoutMs: number = 30 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
    sandboxMode: SandboxMode = 'workspace-write',
    defaultModel?: string,
  ) {
    this.sandboxMode = sandboxMode;
    this.defaultModel = defaultModel;
    if (this.sessionTimeoutMs > 0 && this.cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup();
      }, this.cleanupIntervalMs);
    }
  }

  getOrCreate(userId: number, cwd?: string): SessionWrapper {
    const existing = this.sessions.get(userId);
    
    if (existing) {
      existing.lastActivity = Date.now();
      if (cwd && cwd !== existing.cwd) {
        existing.cwd = cwd;
        existing.session.setWorkingDirectory(cwd);
      }
      return this.wrapSession(existing.session);
    }

    const userModel = this.userModels.get(userId) || this.defaultModel;
    const effectiveCwd = cwd || process.cwd();

    this.logger.info(
      `Creating new session with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''} at cwd: ${effectiveCwd}`,
    );

    const options: CodexSessionOptions = {
      streamingEnabled: true,
      sandboxMode: this.sandboxMode,
      model: userModel,
      workingDirectory: effectiveCwd,
      networkAccessEnabled: true,
    };

    const session = new CodexSession(options);

    this.sessions.set(userId, {
      session,
      lastActivity: Date.now(),
      cwd: effectiveCwd,
    });

    return this.wrapSession(session);
  }

  private wrapSession(session: CodexSession): SessionWrapper {
    return {
      send: session.send.bind(session),
      onEvent: session.onEvent.bind(session),
      getThreadId: session.getThreadId.bind(session),
      reset: session.reset.bind(session),
      setModel: session.setModel.bind(session),
      setWorkingDirectory: session.setWorkingDirectory.bind(session),
      status: session.status.bind(session),
      getActiveAgentId: () => 'codex',
      listAgents: () => [{
        metadata: { id: 'codex', name: 'Codex' },
        status: { ready: true },
      }],
    };
  }

  hasSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  getActiveAgentLabel(userId: number): string {
    void userId;
    return 'Codex';
  }

  saveThreadId(userId: number, threadId: string, agentId?: string): void {
    void userId;
    void threadId;
    void agentId;
    // No-op: simplified version doesn't persist threads
  }

  getSavedThreadId(userId: number, agentId?: string): string | undefined {
    void userId;
    void agentId;
    return undefined;
  }

  getSavedState(userId: number): { threadId?: string; cwd?: string } | undefined {
    void userId;
    return undefined;
  }

  ensureLogger(userId: number): undefined {
    void userId;
    return undefined;
  }

  switchAgent(userId: number, agentId: string): { success: boolean; message: string } {
    void userId;
    void agentId;
    return { success: false, message: '❌ 精简版不支持多代理切换' };
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
    if (record) {
      record.session.reset();
      record.lastActivity = Date.now();
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
      this.sessions.delete(userId);
      this.logger.debug('Cleaned up idle session');
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
  }
}
