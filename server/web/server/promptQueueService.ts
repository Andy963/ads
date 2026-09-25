import type {
  EnqueuePromptInput,
  PromptQueueEntry,
  PromptQueueLane,
  PromptQueueStore,
} from "../../state/promptQueueStore.js";

export type PromptQueueRunOutcome = {
  ok: boolean;
  error?: string;
};

export type PromptQueueServiceOptions = {
  store: PromptQueueStore;
  workerId: string;
  resolveCurrentGeneration: (entry: PromptQueueEntry) => number;
  reconcileBeforeRun?: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome | null>;
  runPrompt: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome>;
  emitSnapshot: (entry: PromptQueueEntry) => void;
  onError?: (error: unknown) => void;
};

export class PromptQueueService {
  private readonly store: PromptQueueStore;
  private readonly workerId: string;
  private readonly resolveCurrentGeneration: PromptQueueServiceOptions["resolveCurrentGeneration"];
  private readonly reconcileBeforeRun: PromptQueueServiceOptions["reconcileBeforeRun"];
  private readonly runPrompt: PromptQueueServiceOptions["runPrompt"];
  private readonly emitSnapshot: PromptQueueServiceOptions["emitSnapshot"];
  private readonly onError: PromptQueueServiceOptions["onError"];
  private started = false;
  private stopped = false;
  private readonly laneTails = new Map<string, Promise<void>>();

  constructor(options: PromptQueueServiceOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.resolveCurrentGeneration = options.resolveCurrentGeneration;
    this.reconcileBeforeRun = options.reconcileBeforeRun;
    this.runPrompt = options.runPrompt;
    this.emitSnapshot = options.emitSnapshot;
    this.onError = options.onError;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.store.recoverInterrupted(this.workerId);
    const scheduledLanes = new Set<string>();
    for (const entry of this.store.listRecoverable()) {
      const laneKey = this.laneKey(entry);
      if (scheduledLanes.has(laneKey)) continue;
      scheduledLanes.add(laneKey);
      this.scheduleLane(laneKey);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  enqueue(input: EnqueuePromptInput): { entry: PromptQueueEntry; duplicate: boolean } {
    if (!this.started) {
      throw new Error("Prompt queue service has not started");
    }
    const result = this.store.enqueue(input);
    this.emitSnapshot(result.entry);
    if (!result.duplicate) {
      this.scheduleLane(this.laneKey(result.entry));
    }
    return result;
  }

  getSnapshot(lane: PromptQueueLane): PromptQueueEntry[] {
    return this.store.listLane(lane).filter((entry) => entry.status !== "completed");
  }

  private laneKey(entry: PromptQueueEntry): string {
    return JSON.stringify([
      entry.authUserId,
      entry.sessionId,
      entry.chatSessionId,
      entry.logicalHistoryKey,
      entry.laneGeneration,
    ]);
  }

  private scheduleLane(laneKey: string): void {
    if (this.stopped || this.laneTails.has(laneKey)) return;
    const tail = Promise.resolve()
      .then(() => this.drainLane(laneKey))
      .catch((error) => this.onError?.(error));
    this.laneTails.set(laneKey, tail);
    void tail.finally(() => {
      if (this.laneTails.get(laneKey) === tail) {
        this.laneTails.delete(laneKey);
        if (!this.stopped && this.store.listRecoverable().some((entry) => this.laneKey(entry) === laneKey)) {
          this.scheduleLane(laneKey);
        }
      }
    });
  }

  private async drainLane(laneKey: string): Promise<void> {
    while (!this.stopped) {
      const next = this.store.listRecoverable().find((entry) => this.laneKey(entry) === laneKey);
      if (!next) return;
      const currentGeneration = this.resolveCurrentGeneration(next);
      if (currentGeneration !== next.laneGeneration) {
        this.store.markFailed(next.id, new Error("Lane generation changed before execution"));
        this.emitSnapshot(this.store.getByClientMessageId(next.clientMessageId) ?? next);
        continue;
      }
      if (!this.store.markRunning(next.id, this.workerId)) {
        continue;
      }
      const running = this.store.getByClientMessageId(next.clientMessageId) ?? next;
      this.emitSnapshot(running);
      try {
        const reconciled = await this.reconcileBeforeRun?.(running);
        const outcome = reconciled ?? await this.runPrompt(running);
        if (outcome.ok) {
          this.store.markCompleted(running.id, this.workerId);
        } else {
          this.store.markFailed(running.id, new Error(outcome.error ?? "Prompt execution failed"), Date.now(), this.workerId);
        }
      } catch (error) {
        this.store.markFailed(running.id, error, Date.now(), this.workerId);
        this.onError?.(error);
      }
      this.emitSnapshot(this.store.getByClientMessageId(running.clientMessageId) ?? running);
    }
  }
}
