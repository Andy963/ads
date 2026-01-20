import { CodexAgentAdapter } from '../../agents/adapters/codexAdapter.js';
import { HybridOrchestrator } from '../../agents/orchestrator.js';
import { ThreadStorage } from './threadStorage.js';
import type { SandboxMode } from '../config.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../../systemPrompt/manager.js';
import { createLogger } from '../../utils/logger.js';
import { ConversationLogger } from '../../utils/conversationLogger.js';
import type { AgentAdapter } from '../../agents/types.js';

interface SessionRecord {
  orchestrator: HybridOrchestrator;
  lastActivity: number;
  cwd: string;
  logger?: ConversationLogger;
}

export class SessionManager {
  private sessions = new Map<number, SessionRecord>();
  private cleanupInterval?: NodeJS.Timeout;
  private threadStorage: ThreadStorage;
  private sandboxMode: SandboxMode;
  private defaultModel?: string;
  private userModels = new Map<number, string>();
  private readonly reinjectionConfig = resolveReinjectionConfig("TELEGRAM");
  private readonly logger = createLogger("SessionManager");

  constructor(
    private readonly sessionTimeoutMs: number = 30 * 60 * 1000,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
    sandboxMode: SandboxMode = 'workspace-write',
    defaultModel?: string,
    threadStorage?: ThreadStorage
  ) {
    this.threadStorage = threadStorage ?? new ThreadStorage();
    this.sandboxMode = sandboxMode;
    this.defaultModel = defaultModel;
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
        existing.orchestrator.setWorkingDirectory(cwd);
      }
      return existing.orchestrator;
    }

    const savedThreadId = resumeThread ? this.threadStorage.getThreadId(userId, "codex") : undefined;
    
    const userModel = this.userModels.get(userId) || this.defaultModel;
    const effectiveCwd = cwd || process.cwd();

    const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    this.logger.info(
      `Creating new session (id: ${sessionId})${
        savedThreadId ? ` (resuming thread ${savedThreadId})` : ''
      } with sandbox mode: ${this.sandboxMode}${userModel ? `, model: ${userModel}` : ''} at cwd: ${effectiveCwd}`,
    );

    const systemPromptManager = new SystemPromptManager({
      workspaceRoot: effectiveCwd,
      reinjection: this.reinjectionConfig,
      logger: this.logger.child(`Session-${sessionId}`),
    });
    
    const adapters: AgentAdapter[] = [
      new CodexAgentAdapter({
        streamingEnabled: true,
        resumeThreadId: savedThreadId,
        sandboxMode: this.sandboxMode,
        model: userModel,
        workingDirectory: effectiveCwd,
        systemPromptManager,
        networkAccessEnabled: true,
      }),
    ];

    const orchestrator = new HybridOrchestrator({
      adapters,
      defaultAgentId: "codex",
      initialWorkingDirectory: effectiveCwd,
      initialModel: userModel,
      systemPromptManager,
    });

    this.sessions.set(userId, {
      orchestrator,
      lastActivity: Date.now(),
      cwd: effectiveCwd,
      logger: undefined,
    });

    return orchestrator;
  }
  
  hasSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  getLogger(userId: number): ConversationLogger | undefined {
    return this.sessions.get(userId)?.logger;
  }

  ensureLogger(userId: number): ConversationLogger | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
      return undefined;
    }

    if (record.logger) {
      const threadId = record.orchestrator.getThreadId();
      if (threadId) {
        record.logger.attachThreadId(threadId);
      }
      return record.logger;
    }

    const threadId = record.orchestrator.getThreadId();
    record.logger = new ConversationLogger(record.cwd, userId, threadId ?? undefined);
    return record.logger;
  }

  hasSavedThread(userId: number, agentId = "codex"): boolean {
    return !!this.threadStorage.getThreadId(userId, agentId);
  }
  
  getSavedThreadId(userId: number, agentId = "codex"): string | undefined {
    return this.threadStorage.getThreadId(userId, agentId);
  }
  
  saveThreadId(userId: number, threadId: string, agentId = "codex"): void {
    const record = this.sessions.get(userId);
    if (record?.cwd) {
      const existing = this.threadStorage.getRecord(userId);
      this.threadStorage.setRecord(userId, {
        threadId: existing?.threadId,
        cwd: record.cwd,
        agentThreads: {
          ...(existing?.agentThreads ?? {}),
          [agentId]: threadId,
        },
      });
      return;
    }
    this.threadStorage.setThreadId(userId, threadId, agentId);
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
      record.orchestrator.setModel(model);
      record.lastActivity = Date.now();
    }
    if (this.threadStorage.getRecord(userId)) {
      this.threadStorage.removeThread(userId);
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
      if (record.logger) {
        record.logger.close();
        record.logger = undefined;
      }
      record.orchestrator.reset();
      record.lastActivity = Date.now();
      this.logger.info('Session reset');
    } else {
      this.logger.debug('Reset requested without active session');
    }

    if (this.threadStorage.getRecord(userId)) {
      this.threadStorage.removeThread(userId);
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

    const threadId = record.orchestrator.getThreadId();
    const activeAgentId = record.orchestrator.getActiveAgentId();

    if (record.cwd === cwd) {
      if (threadId) {
        this.saveThreadId(userId, threadId, activeAgentId);
      }
      return;
    }

    record.cwd = cwd;
    record.orchestrator.setWorkingDirectory(cwd);

    if (threadId) {
      this.saveThreadId(userId, threadId, activeAgentId);
    }
  }

  listAgents(userId: number) {
    return this.sessions.get(userId)?.orchestrator.listAgents() ?? [];
  }

  getActiveAgentLabel(userId: number): string | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
      return undefined;
    }
    const activeId = record.orchestrator.getActiveAgentId();
    const descriptor = record
      .orchestrator
      .listAgents()
      .find((entry) => entry.metadata.id === activeId);
    return descriptor?.metadata.name ?? activeId;
  }

  switchAgent(userId: number, agentId: string): { success: boolean; message: string } {
    const record = this.sessions.get(userId);
    if (!record) {
      return { success: false, message: "❌ 当前没有活跃会话" };
    }
    const normalized = agentId.toLowerCase();
    const descriptor = record
      .orchestrator
      .listAgents()
      .find(
        (entry) =>
          entry.metadata.id.toLowerCase() === normalized ||
          entry.metadata.name.toLowerCase() === normalized,
      );
    if (!descriptor) {
      return { success: false, message: `❌ 未知代理: ${agentId}` };
    }
    if (!descriptor.status.ready) {
      return {
        success: false,
        message: `❌ ${descriptor.metadata.name} 不可用: ${descriptor.status.error ?? "未配置"}`,
      };
    }
    record.orchestrator.switchAgent(descriptor.metadata.id);
    return { success: true, message: `🤖 已切换至 ${descriptor.metadata.name}` };
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
      if (record && record.logger) {
        record.logger.close();
      }
      this.sessions.delete(userId);
      this.logger.debug('Cleaned up idle session');
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const [userId, record] of this.sessions.entries()) {
      const threadId = record.orchestrator.getThreadId();
      const activeAgentId = record.orchestrator.getActiveAgentId();
      const existing = this.threadStorage.getRecord(userId);
      if (threadId) {
        const agentThreads = { ...(existing?.agentThreads ?? {}) };
        agentThreads[activeAgentId] = threadId;
        const codexThreadId = activeAgentId === "codex" ? threadId : existing?.threadId;
        this.threadStorage.setRecord(userId, {
          threadId: codexThreadId,
          cwd: record.cwd,
          agentThreads,
        });
      } else if (existing && record.cwd) {
        this.threadStorage.setRecord(userId, { ...existing, cwd: record.cwd });
      }
      if (record.logger) {
        record.logger.close();
      }
    }

    this.sessions.clear();
  }
}
