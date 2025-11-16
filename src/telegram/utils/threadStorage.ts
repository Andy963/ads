import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const STORAGE_DIR = join(process.cwd(), '.ads');
const STORAGE_PATH = join(STORAGE_DIR, 'telegram-threads.json');
const SALT_PATH = join(STORAGE_DIR, 'thread-storage-salt');

interface ThreadRecord {
  userHash: string;
  threadId: string;
  lastActivity: number;
  cwd?: string;

  // Legacy field to support older files
  userId?: number;
}

interface ThreadState {
  threadId: string;
  cwd?: string;
}

export class ThreadStorage {
  private threads = new Map<string, ThreadState>();
  private salt: string;

  constructor() {
    this.salt = this.loadSalt();
    this.load();
  }

  private loadSalt(): string {
    try {
      if (existsSync(SALT_PATH)) {
        const existing = readFileSync(SALT_PATH, 'utf-8').trim();
        if (existing) {
          return existing;
        }
      }
    } catch {
      // fall through to regenerate salt
    }

    const generated = randomBytes(32).toString('hex');
    try {
      if (!existsSync(STORAGE_DIR)) {
        mkdirSync(STORAGE_DIR, { recursive: true });
      }
      writeFileSync(SALT_PATH, generated, 'utf-8');
    } catch {
      // ignore write errors; regenerated next time
    }
    return generated;
  }

  private hashUserId(userId: number): string {
    return createHash('sha256').update(String(userId)).update(':').update(this.salt).digest('hex');
  }

  private load(): void {
    if (!existsSync(STORAGE_PATH)) {
      return;
    }

    try {
      const content = readFileSync(STORAGE_PATH, 'utf-8');
      const data: ThreadRecord[] = JSON.parse(content);

      for (const record of data) {
        const key = record.userHash ?? (record.userId !== undefined ? this.hashUserId(record.userId) : null);
        if (!key) {
          continue;
        }
        this.threads.set(key, {
          threadId: record.threadId,
          cwd: record.cwd,
        });
      }

      console.log(`[ThreadStorage] Loaded ${this.threads.size} thread records`);
    } catch (error) {
      console.warn('[ThreadStorage] Failed to load:', error);
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
      });
    }

    try {
      const dir = dirname(STORAGE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      writeFileSync(STORAGE_PATH, JSON.stringify(records, null, 2), 'utf-8');
    } catch (error) {
      console.warn('[ThreadStorage] Failed to save:', error);
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
    console.log(`[ThreadStorage] Saved thread ${threadId}`);
  }

  getRecord(userId: number): ThreadState | undefined {
    return this.threads.get(this.hashUserId(userId));
  }

  setRecord(userId: number, state: ThreadState): void {
    this.threads.set(this.hashUserId(userId), state);
    this.save();
    console.log(
      `[ThreadStorage] Saved state (thread=${state.threadId}${state.cwd ? `, cwd=${state.cwd}` : ''})`,
    );
  }

  removeThread(userId: number): void {
    this.threads.delete(this.hashUserId(userId));
    this.save();
    console.log(`[ThreadStorage] Removed thread`);
  }

  clear(): void {
    this.threads.clear();
    this.save();
  }
}
