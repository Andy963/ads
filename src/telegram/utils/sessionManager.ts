import { CodexSession } from '../../cli/codexChat.js';
import { ThreadStorage } from './threadStorage.js';
import type { SandboxMode } from '../config.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../../systemPrompt/manager.js';
import { createLogger } from '../../utils/logger.js';

interface SessionRecord {
  session: CodexSession;
  lastActivity: number;
  cwd: string;
}

export class SessionManager {
  private sessions = new Map<number, SessionRecord>();
  private cleanupInterval: NodeJS.Timeout;
  private threadStorage: ThreadStorage;
  private sandboxMode: SandboxMode;
  private defaultModel?: string;
  private userModels = new Map<number, string>(); // 用户自定义模型
  private readonly reinjectionConfig = resolveReinjectionConfig("TELEGRAM");
  private readonly logger = createLogger("SessionManager");

  constructor(
    private readonly sessionTimeoutMs: number = 30 * 60 * 1000, // 30分钟
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,  // 5分钟检查一次
    sandboxMode: SandboxMode = 'workspace-write',
    defaultModel?: string
  ) {
    this.threadStorage = new ThreadStorage();
    this.sandboxMode = sandboxMode;
    this.defaultModel = defaultModel;
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
  }

  getOrCreate(userId: number, cwd?: string, resumeThread?: boolean): CodexSession {
    const existing = this.sessions.get(userId);
    
    if (existing) {
      existing.lastActivity = Date.now();
      if (cwd && cwd !== existing.cwd) {
        existing.cwd = cwd;
        existing.session.setWorkingDirectory(cwd);
      }
      return existing.session;
    }

    // 只有明确要求时才恢复 thread
    const savedThreadId = resumeThread ? this.threadStorage.getThreadId(userId) : undefined;
    
    const userModel = this.userModels.get(userId) || this.defaultModel;
    const effectiveCwd = cwd || process.cwd();
    
    console.log(`[SessionManager] Creating new session for user ${userId}${savedThreadId ? ` (resuming thread ${savedThreadId})` : ''} with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''} at cwd: ${effectiveCwd}`);
    
    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: effectiveCwd,
      reinjection: this.reinjectionConfig,
      logger: this.logger.child(`User:${userId}`),
    });
    
    const session = new CodexSession({
      streamingEnabled: true,
      resumeThreadId: savedThreadId,
      sandboxMode: this.sandboxMode,
      model: userModel,
      workingDirectory: effectiveCwd,
      systemPromptManager,
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

  hasSavedThread(userId: number): boolean {
    return !!this.threadStorage.getThreadId(userId);
  }
  
  getSavedThreadId(userId: number): string | undefined {
    return this.threadStorage.getThreadId(userId);
  }
  
  saveThreadId(userId: number, threadId: string): void {
    const record = this.sessions.get(userId);
    const cwd = record?.cwd;
    this.threadStorage.setRecord(userId, { threadId, cwd });
  }
  
  getSavedState(userId: number): { threadId?: string; cwd?: string } | undefined {
    const record = this.threadStorage.getRecord(userId);
    if (!record) return undefined;
    return { threadId: record.threadId, cwd: record.cwd };
  }

  setUserModel(userId: number, model: string): void {
    this.userModels.set(userId, model);
    const record = this.sessions.get(userId);
    if (record) {
      record.session.setModel(model);
      record.lastActivity = Date.now();
    }
    if (this.threadStorage.getThreadId(userId)) {
      this.threadStorage.removeThread(userId);
    }
    console.log(`[SessionManager] User ${userId} switched to model: ${model}`);
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
      console.log(`[SessionManager] Session reset for user ${userId}`);
    } else {
      console.log(`[SessionManager] Reset requested for user ${userId} without active session`);
    }

    if (this.threadStorage.getThreadId(userId)) {
      this.threadStorage.removeThread(userId);
    }
  }

  getUserCwd(userId: number): string | undefined {
    return this.sessions.get(userId)?.cwd;
  }

  setUserCwd(userId: number, cwd: string): void {
    const record = this.sessions.get(userId);
    if (record) {
      record.cwd = cwd;
      record.session.setWorkingDirectory(cwd);
    }
  }

  getStats(): { total: number; active: number; idle: number; sandboxMode: SandboxMode; defaultModel: string } {
    const now = Date.now();
    let active = 0;
    let idle = 0;

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
    const now = Date.now();
    const expiredUsers: number[] = [];

    for (const [userId, record] of this.sessions.entries()) {
      if (now - record.lastActivity > this.sessionTimeoutMs) {
        expiredUsers.push(userId);
      }
    }

    for (const userId of expiredUsers) {
      this.sessions.delete(userId);
      console.log(`[SessionManager] Cleaned up idle session for user ${userId}`);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    
    // 保存所有活跃 session 的 thread ID
    for (const [userId, record] of this.sessions.entries()) {
      const threadId = record.session.getThreadId();
      if (threadId) {
        this.threadStorage.setRecord(userId, { threadId, cwd: record.cwd });
      }
    }
    
    this.sessions.clear();
  }
}
