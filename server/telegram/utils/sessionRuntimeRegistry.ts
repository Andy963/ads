import type { ContextRestoreMode } from "./sessionState.js";

export interface RuntimeSession {
  setWorkingDirectory(workingDirectory?: string, options?: { preserveSession?: boolean }): void;
  getThreadId(): string | null;
  reset(): void;
}

export interface RuntimeLogger {
  readonly isClosed?: boolean;
  attachThreadId?(threadId: string | null): void;
  close(): void;
}

export interface SessionRuntimeRecord<
  TSession extends RuntimeSession = RuntimeSession,
  TLogger extends RuntimeLogger = RuntimeLogger,
> {
  session: TSession;
  lastActivity: number;
  cwd: string;
  logger?: TLogger;
}

export class SessionRuntimeRegistry<
  TSession extends RuntimeSession = RuntimeSession,
  TLogger extends RuntimeLogger = RuntimeLogger,
> {
  private readonly sessions = new Map<number, SessionRuntimeRecord<TSession, TLogger>>();
  private readonly pendingHistoryInjections = new Set<number>();
  private readonly contextRestoreModes = new Map<number, ContextRestoreMode>();

  get size(): number {
    return this.sessions.size;
  }

  getRecord(userId: number): SessionRuntimeRecord<TSession, TLogger> | undefined {
    return this.sessions.get(userId);
  }

  getSession(userId: number): TSession | undefined {
    return this.sessions.get(userId)?.session;
  }

  hasSession(userId: number): boolean {
    return this.sessions.has(userId);
  }

  getUserCwd(userId: number): string | undefined {
    return this.sessions.get(userId)?.cwd;
  }

  records(): IterableIterator<SessionRuntimeRecord<TSession, TLogger>> {
    return this.sessions.values();
  }

  trackSession(userId: number, session: TSession, cwd: string): void {
    this.sessions.set(userId, {
      session,
      lastActivity: Date.now(),
      cwd,
    });
  }

  touch(userId: number): SessionRuntimeRecord<TSession, TLogger> | undefined {
    const record = this.sessions.get(userId);
    if (record) {
      record.lastActivity = Date.now();
    }
    return record;
  }

  updateWorkingDirectory(userId: number, cwd: string, options?: { preserveSession?: boolean }): boolean {
    const record = this.sessions.get(userId);
    if (!record || record.cwd === cwd) {
      return false;
    }
    record.cwd = cwd;
    record.lastActivity = Date.now();
    record.session.setWorkingDirectory(cwd, options);
    this.closeLogger(userId);
    return true;
  }

  closeLogger(userId: number): void {
    const record = this.sessions.get(userId);
    if (!record?.logger) {
      return;
    }
    record.logger.close();
    record.logger = undefined;
  }

  ensureLogger(
    userId: number,
    enabled: boolean,
    createLogger: (cwd: string, userId: number, threadId?: string) => TLogger,
  ): TLogger | undefined {
    const record = this.sessions.get(userId);
    if (!record) {
      return undefined;
    }

    record.lastActivity = Date.now();

    if (!enabled) {
      return undefined;
    }

    if (record.logger && !record.logger.isClosed) {
      record.logger.attachThreadId?.(record.session.getThreadId());
      return record.logger;
    }

    const threadId = record.session.getThreadId() ?? undefined;
    record.logger = createLogger(record.cwd, userId, threadId);
    return record.logger;
  }

  markHistoryInjection(userId: number): void {
    this.pendingHistoryInjections.add(userId);
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

  setContextRestoreMode(userId: number, mode: ContextRestoreMode): void {
    this.contextRestoreModes.set(userId, mode);
  }

  ensureContextRestoreMode(userId: number): void {
    if (!this.contextRestoreModes.has(userId)) {
      this.contextRestoreModes.set(userId, this.pendingHistoryInjections.has(userId) ? "history_injection" : "fresh");
    }
  }

  getContextRestoreMode(userId: number): ContextRestoreMode {
    if (this.pendingHistoryInjections.has(userId)) {
      return "history_injection";
    }
    return this.contextRestoreModes.get(userId) ?? "fresh";
  }

  migrateContinuityState(fromUserId: number, toUserId: number): void {
    if (this.pendingHistoryInjections.has(fromUserId)) {
      this.pendingHistoryInjections.add(toUserId);
    }
    const restoreMode = this.contextRestoreModes.get(fromUserId);
    if (restoreMode && !this.contextRestoreModes.has(toUserId)) {
      this.contextRestoreModes.set(toUserId, restoreMode);
    }
  }

  getExpiredUserIds(sessionTimeoutMs: number, now: number = Date.now()): number[] {
    if (sessionTimeoutMs <= 0) {
      return [];
    }
    const expiredUsers: number[] = [];
    for (const [userId, record] of this.sessions.entries()) {
      if (now - record.lastActivity > sessionTimeoutMs) {
        expiredUsers.push(userId);
      }
    }
    return expiredUsers;
  }

  releaseSession(
    userId: number,
    options: { resetSession?: boolean; clearContinuity?: boolean } = {},
  ): SessionRuntimeRecord<TSession, TLogger> | undefined {
    const record = this.sessions.get(userId);
    if (record) {
      if (options.resetSession !== false) {
        try {
          record.session.reset();
        } catch {
          // ignore session reset failures during disposal
        }
      }
      record.logger?.close();
      this.sessions.delete(userId);
    }
    if (options.clearContinuity !== false) {
      this.pendingHistoryInjections.delete(userId);
      this.contextRestoreModes.delete(userId);
    }
    return record;
  }

  destroy(): void {
    for (const record of this.sessions.values()) {
      record.logger?.close();
    }
    this.sessions.clear();
    this.pendingHistoryInjections.clear();
    this.contextRestoreModes.clear();
  }
}
