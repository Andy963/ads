import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const STORAGE_PATH = join(process.cwd(), '.ads', 'telegram-threads.json');

interface ThreadRecord {
  userId: number;
  threadId: string;
  lastActivity: number;
  cwd?: string;
}

interface ThreadState {
  threadId: string;
  cwd?: string;
}

export class ThreadStorage {
  private threads = new Map<number, ThreadState>();

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(STORAGE_PATH)) {
      return;
    }

    try {
      const content = readFileSync(STORAGE_PATH, 'utf-8');
      const data: ThreadRecord[] = JSON.parse(content);

      for (const record of data) {
        this.threads.set(record.userId, {
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

    for (const [userId, state] of this.threads.entries()) {
      records.push({
        userId,
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
    return this.threads.get(userId)?.threadId;
  }

  setThreadId(userId: number, threadId: string): void {
    const existing = this.threads.get(userId);
    this.threads.set(userId, {
      threadId,
      cwd: existing?.cwd,
    });
    this.save();
    console.log(`[ThreadStorage] Saved thread ${threadId}`);
  }

  getRecord(userId: number): ThreadState | undefined {
    return this.threads.get(userId);
  }

  setRecord(userId: number, state: ThreadState): void {
    this.threads.set(userId, state);
    this.save();
    console.log(
      `[ThreadStorage] Saved state (thread=${state.threadId}${state.cwd ? `, cwd=${state.cwd}` : ''})`,
    );
  }

  removeThread(userId: number): void {
    this.threads.delete(userId);
    this.save();
    console.log(`[ThreadStorage] Removed thread`);
  }

  clear(): void {
    this.threads.clear();
    this.save();
  }
}
