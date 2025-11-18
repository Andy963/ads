import { CodexAgentAdapter } from '../../agents/adapters/codexAdapter.js';
import { ClaudeAgentAdapter } from '../../agents/adapters/claudeAdapter.js';
import { HybridOrchestrator } from '../../agents/orchestrator.js';
import { ThreadStorage } from './threadStorage.js';
import type { SandboxMode } from '../config.js';
import { SystemPromptManager, resolveReinjectionConfig } from '../../systemPrompt/manager.js';
import { createLogger } from '../../utils/logger.js';
import { ConversationLogger } from '../../utils/conversationLogger.js';
import { resolveClaudeAgentConfig } from '../../agents/config.js';
import type { AgentMode } from '../../agents/delegation.js';
import type { AgentAdapter } from '../../agents/types.js';

interface SessionRecord {
  orchestrator: HybridOrchestrator;
  lastActivity: number;
  cwd: string;
  logger?: ConversationLogger;
  agentMode: AgentMode;
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
  private readonly claudeConfig = resolveClaudeAgentConfig();

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

    // 只有明确要求时才恢复 thread
    const savedThreadId = resumeThread ? this.threadStorage.getThreadId(userId) : undefined;
    
    const userModel = this.userModels.get(userId) || this.defaultModel;
    const effectiveCwd = cwd || process.cwd();

    // 使用时间戳和随机数生成唯一的会话ID（不暴露用户信息）
    const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(
      `[SessionManager] Creating new session (id: ${sessionId})${
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
      }),
    ];

    if (this.claudeConfig.enabled) {
      adapters.push(new ClaudeAgentAdapter({ config: this.claudeConfig }));
    }

    const orchestrator = new HybridOrchestrator({
      adapters,
      defaultAgentId: "codex",
      initialWorkingDirectory: effectiveCwd,
      initialModel: userModel,
    });

    this.sessions.set(userId, {
      orchestrator,
      lastActivity: Date.now(),
      cwd: effectiveCwd,
      logger: undefined, // 延迟创建，等到获取 threadId 后
      agentMode: "manual",
    });

    return orchestrator;
  }
  
  hasSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  getLogger(userId: number): ConversationLogger | undefined {
    return this.sessions.get(userId)?.logger;
  }

  /**
   * 确保 logger 存在，如果不存在则创建
   * 必须在 session 有 threadId 后调用
   */
  ensureLogger(userId: number): ConversationLogger | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
      return undefined;
    }

    // 如果已经有 logger，直接返回
    if (record.logger) {
      return record.logger;
    }

    // 获取 threadId
    const threadId = record.orchestrator.getThreadId();
    if (!threadId) {
      // 没有 threadId，说明还没发送过消息，暂时不创建 logger
      return undefined;
    }

    // 创建 logger
    record.logger = new ConversationLogger(record.cwd, userId, threadId);
    return record.logger;
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
      record.orchestrator.setModel(model);
      record.lastActivity = Date.now();
    }
    if (this.threadStorage.getThreadId(userId)) {
      this.threadStorage.removeThread(userId);
    }
    console.log(`[SessionManager] Switched to model: ${model}`);
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
      // 关闭旧的 logger
      if (record.logger) {
        record.logger.close();
        record.logger = undefined;
      }
      record.orchestrator.reset();
      record.lastActivity = Date.now();
      console.log(`[SessionManager] Session reset`);
    } else {
      console.log(`[SessionManager] Reset requested without active session`);
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
    if (!record) {
      return;
    }

    const threadId = record.orchestrator.getThreadId();

    if (record.cwd === cwd) {
      if (threadId) {
        // 确保最新 cwd 被持久化
        this.saveThreadId(userId, threadId);
      }
      return;
    }

    record.cwd = cwd;
    record.orchestrator.setWorkingDirectory(cwd);

    if (threadId) {
      this.saveThreadId(userId, threadId);
    }
  }

  listAgents(userId: number) {
    return this.sessions.get(userId)?.orchestrator.listAgents() ?? [];
  }

  getAgentMode(userId: number): AgentMode {
    return this.sessions.get(userId)?.agentMode ?? "manual";
  }

  setAgentMode(userId: number, mode: AgentMode): void {
    const record = this.sessions.get(userId);
    if (!record) {
      return;
    }
    record.agentMode = mode;
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
      const record = this.sessions.get(userId);
      if (record && record.logger) {
        record.logger.close();
      }
      this.sessions.delete(userId);
      console.log(`[SessionManager] Cleaned up idle session`);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);

    // 保存所有活跃 session 的 thread ID 并关闭 logger
    for (const [userId, record] of this.sessions.entries()) {
      const threadId = record.orchestrator.getThreadId();
      if (threadId) {
        this.threadStorage.setRecord(userId, { threadId, cwd: record.cwd });
      }
      if (record.logger) {
        record.logger.close();
      }
    }

    this.sessions.clear();
  }
}
