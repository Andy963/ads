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
  ownerPid?: number;
  isOwnerAlive?: (pid: number) => boolean;
  resolveCurrentGeneration: (entry: PromptQueueEntry) => number;
  reconcileBeforeRun?: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome | null>;
  runPrompt: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome>;
  emitSnapshot: (entry: PromptQueueEntry) => void;
  onError?: (error: unknown) => void;
};

export class PromptQueueService {
  private readonly store: PromptQueueStore;
  private readonly workerId: string;
  private readonly ownerPid: number;
  private readonly isOwnerAlive: (pid: number) => boolean;
  private readonly resolveCurrentGeneration: PromptQueueServiceOptions["resolveCurrentGeneration"];
  private readonly reconcileBeforeRun: PromptQueueServiceOptions["reconcileBeforeRun"];
  private readonly runPrompt: PromptQueueServiceOptions["runPrompt"];
  private readonly emitSnapshot: PromptQueueServiceOptions["emitSnapshot"];
  private readonly onError: PromptQueueServiceOptions["onError"];
  private started = false;
  private stopped = false;
  private ownershipTimer: ReturnType<typeof setInterval> | null = null;
  private readonly laneTails = new Map<string, Promise<void>>();

  constructor(options: PromptQueueServiceOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.ownerPid = Math.max(1, Math.floor(options.ownerPid ?? process.pid));
    this.isOwnerAlive = options.isOwnerAlive ?? (() => false);
    this.resolveCurrentGeneration = options.resolveCurrentGeneration;
    this.reconcileBeforeRun = options.reconcileBeforeRun;
    this.runPrompt = options.runPrompt;
    this.emitSnapshot = options.emitSnapshot;
    this.onError = options.onError;
  }

  start(): void {
    if (this.started) return;
    const claim = this.store.claimOwnership(
      this.workerId,
      this.ownerPid,
      Date.now(),
      60_000,
      this.isOwnerAlive,
    );
    if (!claim.claimed) {
      throw new Error("Prompt queue ownership is held by another live process");
    }
    this.started = true;
    this.stopped = false;
    this.store.recoverInterrupted(claim.previousOwnerId);
    this.ownershipTimer = setInterval(() => {
      try {
        const renewed = this.store.claimOwnership(
          this.workerId,
          this.ownerPid,
          Date.now(),
          60_000,
          this.isOwnerAlive,
        );
        if (!renewed.claimed) {
          this.onError?.(new Error("Prompt queue ownership renewal failed"));
        }
      } catch (error) {
        this.onError?.(error);
      }
    }, 20_000);
    this.ownershipTimer.unref?.();
    const scheduledLanes = new Set<string>();
    for (const entry of this.store.listRecoverable()) {
      const laneKey = this.laneKey(entry);
      if (scheduledLanes.has(laneKey)) continue;
      scheduledLanes.add(laneKey);
      this.scheduleLane(laneKey);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopped = true;
    if (this.ownershipTimer) {
      clearInterval(this.ownershipTimer);
      this.ownershipTimer = null;
    }
    await Promise.allSettled(Array.from(this.laneTails.values()));
    this.store.releaseOwnership(this.workerId);
    this.started = false;
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
    return this.store.listLogicalLane(lane).filter((entry) => entry.status !== "completed");
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
