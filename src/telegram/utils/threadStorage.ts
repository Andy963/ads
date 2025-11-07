import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const STORAGE_PATH = join(process.cwd(), '.ads', 'telegram-threads.json');

interface ThreadRecord {
  userId: number;
  threadId: string;
  lastActivity: number;
}

export class ThreadStorage {
  private threads = new Map<number, string>();

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
        this.threads.set(record.userId, record.threadId);
      }
      
      console.log(`[ThreadStorage] Loaded ${this.threads.size} thread records`);
    } catch (error) {
      console.warn('[ThreadStorage] Failed to load:', error);
    }
  }

  private save(): void {
    const records: ThreadRecord[] = [];
    
    for (const [userId, threadId] of this.threads.entries()) {
      records.push({
        userId,
        threadId,
        lastActivity: Date.now(),
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
    return this.threads.get(userId);
  }

  setThreadId(userId: number, threadId: string): void {
    this.threads.set(userId, threadId);
    this.save();
    console.log(`[ThreadStorage] Saved thread ${threadId} for user ${userId}`);
  }

  removeThread(userId: number): void {
    this.threads.delete(userId);
    this.save();
    console.log(`[ThreadStorage] Removed thread for user ${userId}`);
  }

  clear(): void {
    this.threads.clear();
    this.save();
  }
}
