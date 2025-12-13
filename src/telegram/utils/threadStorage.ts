import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { createLogger } from '../../utils/logger.js';

interface ThreadStorageOptions {
  namespace?: string;
  storagePath?: string;
  saltPath?: string;
}

interface ThreadRecord {
  userHash: string;
  threadId: string;
  lastActivity: number;
  cwd?: string;
  namespace?: string;

  // Legacy fields
  userId?: number;
}

interface ThreadState {
  threadId: string;
  cwd?: string;
}

const logger = createLogger('ThreadStorage');

export class ThreadStorage {
  private readonly namespace: string;
  private readonly storagePath: string;
  private readonly saltPath: string;
  private readonly storageDir: string;
  private threads = new Map<string, ThreadState>();
  private salt: string;

  constructor(options: ThreadStorageOptions = {}) {
    this.namespace = options.namespace?.trim() || 'tg';
    const storageDir = join(process.cwd(), '.ads');
    this.storagePath = options.storagePath ?? join(storageDir, this.namespace === 'tg' ? 'telegram-threads.json' : `${this.namespace}-threads.json`);
    this.saltPath = options.saltPath ?? join(storageDir, 'thread-storage-salt');
    this.storageDir = dirname(this.storagePath);
    this.salt = this.loadSalt();
    this.load();
  }

  private loadSalt(): string {
    try {
      if (existsSync(this.saltPath)) {
        const existing = readFileSync(this.saltPath, 'utf-8').trim();
        if (existing) {
          return existing;
        }
      }
    } catch {
      // fall through to regenerate salt
    }

    const generated = randomBytes(32).toString('hex');
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      writeFileSync(this.saltPath, generated, 'utf-8');
    } catch {
      // ignore write errors; regenerated next time
    }
    return generated;
  }

  private hashUserId(userId: number): string {
    return createHash('sha256').update(String(userId)).update(':').update(this.salt).digest('hex');
  }

  private load(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }

    try {
      const content = readFileSync(this.storagePath, 'utf-8');
      const data: ThreadRecord[] = JSON.parse(content);

      for (const record of data) {
        if (record.namespace && record.namespace !== this.namespace) {
          continue;
        }
        const key = record.userHash ?? (record.userId !== undefined ? this.hashUserId(record.userId) : null);
        if (!key) {
          continue;
        }
        this.threads.set(key, {
          threadId: record.threadId,
          cwd: record.cwd,
        });
      }

      logger.info(`Loaded ${this.threads.size} thread records`);
    } catch (error) {
      logger.warn('Failed to load', error);
    }
  }

  private save(): void {
    const records: ThreadRecord[] = [];

    for (const [userHash, state] of this.threads.entries()) {
      records.push({
        userHash,
        threadId: state.threadId,
        lastActivity: Date.now(),
        cwd: state.cwd,
        namespace: this.namespace,
      });
    }

    try {
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      writeFileSync(this.storagePath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('Failed to save', error);
    }
  }

  getThreadId(userId: number): string | undefined {
    const key = this.hashUserId(userId);
    return this.threads.get(key)?.threadId;
  }

  setThreadId(userId: number, threadId: string): void {
    const key = this.hashUserId(userId);
    const existing = this.threads.get(key);
    this.threads.set(key, {
      threadId,
      cwd: existing?.cwd,
    });
    this.save();
    logger.debug(`Saved thread ${threadId}`);
  }

  getRecord(userId: number): ThreadState | undefined {
    return this.threads.get(this.hashUserId(userId));
  }

  setRecord(userId: number, state: ThreadState): void {
    this.threads.set(this.hashUserId(userId), state);
    this.save();
    logger.debug(`Saved state (ns=${this.namespace} thread=${state.threadId}${state.cwd ? `, cwd=${state.cwd}` : ''})`);
  }

  removeThread(userId: number): void {
    this.threads.delete(this.hashUserId(userId));
    this.save();
    logger.debug('Removed thread');
  }

  clear(): void {
    this.threads.clear();
    this.save();
  }
}
