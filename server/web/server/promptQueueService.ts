import type {
  EnqueuePromptInput,
  PromptQueueEntry,
  PromptQueueLane,
  PromptQueueStore,
} from "../../state/promptQueueStore.js";
import { INTERRUPTED_PROMPT_ERROR } from "../../state/promptQueueStore.js";

export type PromptQueueRunOutcome = {
  ok: boolean;
  error?: string;
};

export type PromptQueueServiceOptions = {
  store: PromptQueueStore;
  workerId: string;
  ownerPid?: number;
  isOwnerAlive?: (pid: number) => boolean;
  ownershipRenewalIntervalMs?: number;
  resolveCurrentGeneration: (entry: PromptQueueEntry) => number;
  reconcileBeforeRun?: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome | null>;
  runPrompt: (entry: PromptQueueEntry) => Promise<PromptQueueRunOutcome>;
  abortRun?: (entry: PromptQueueEntry) => void;
  emitSnapshot: (entry: PromptQueueEntry) => void;
  onError?: (error: unknown) => void;
};

export class PromptQueueService {
  private readonly store: PromptQueueStore;
  private readonly workerId: string;
  private readonly ownerPid: number;
  private readonly isOwnerAlive: (pid: number) => boolean;
  private readonly ownershipRenewalIntervalMs: number;
  private readonly resolveCurrentGeneration: PromptQueueServiceOptions["resolveCurrentGeneration"];
  private readonly reconcileBeforeRun: PromptQueueServiceOptions["reconcileBeforeRun"];
  private readonly runPrompt: PromptQueueServiceOptions["runPrompt"];
  private readonly abortRun: PromptQueueServiceOptions["abortRun"];
  private readonly emitSnapshot: PromptQueueServiceOptions["emitSnapshot"];
  private readonly onError: PromptQueueServiceOptions["onError"];
  private started = false;
  private stopped = false;
  private ownershipLost = false;
  private ownershipTimer: ReturnType<typeof setInterval> | null = null;
  private readonly laneTails = new Map<string, Promise<void>>();
  private readonly activeEntries = new Set<PromptQueueEntry>();

  constructor(options: PromptQueueServiceOptions) {
    this.store = options.store;
    this.workerId = options.workerId;
    this.ownerPid = Math.max(1, Math.floor(options.ownerPid ?? process.pid));
    this.isOwnerAlive = options.isOwnerAlive ?? (() => false);
    this.ownershipRenewalIntervalMs = Math.max(10, Math.floor(options.ownershipRenewalIntervalMs ?? 20_000));
    this.resolveCurrentGeneration = options.resolveCurrentGeneration;
    this.reconcileBeforeRun = options.reconcileBeforeRun;
    this.runPrompt = options.runPrompt;
    this.abortRun = options.abortRun;
    this.emitSnapshot = options.emitSnapshot;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
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
    this.ownershipLost = false;
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
          this.loseOwnership(new Error("Prompt queue ownership renewal failed"));
        }
      } catch (error) {
        this.loseOwnership(error);
      }
    }, this.ownershipRenewalIntervalMs);
    this.ownershipTimer.unref?.();
    await this.reconcileInterrupted(claim.previousOwnerId);
    if (this.stopped || !this.isOwner()) return;
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
    if (!this.isOwner()) {
      throw new Error("Prompt queue service does not own the queue");
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

  isOwner(): boolean {
    return this.started && !this.stopped && !this.ownershipLost
      && this.store.isOwnershipCurrent(this.workerId);
  }

  // A graceful stop must still be able to record the terminal state of the
  // prompt it already finished running. Only losing the lease to another
  // owner fences writes, so this check deliberately ignores `stopped`.
  private canWriteTerminal(): boolean {
    return this.started && !this.ownershipLost
      && this.store.isOwnershipCurrent(this.workerId);
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
    if (!this.isOwner() || this.laneTails.has(laneKey)) return;
    const tail = Promise.resolve()
      .then(() => this.drainLane(laneKey))
      .catch((error) => this.onError?.(error));
    this.laneTails.set(laneKey, tail);
    void tail.finally(() => {
      if (this.laneTails.get(laneKey) === tail) {
        this.laneTails.delete(laneKey);
        if (this.isOwner() && this.store.listRecoverable().some((entry) => this.laneKey(entry) === laneKey)) {
          this.scheduleLane(laneKey);
        }
      }
    });
  }

  private async drainLane(laneKey: string): Promise<void> {
    while (this.isOwner()) {
      const next = this.store.listRecoverable().find((entry) => this.laneKey(entry) === laneKey);
      if (!next) return;
      const currentGeneration = this.resolveCurrentGeneration(next);
      if (currentGeneration !== next.laneGeneration) {
        if (this.store.markFailed(next.id, new Error("Lane generation changed before execution"), this.workerId)) {
          this.emitSnapshot(this.store.getByClientMessageId(next.clientMessageId) ?? next);
        }
        continue;
      }
      if (!this.store.markRunning(next.id, this.workerId)) {
        continue;
      }
      const running = this.store.getByClientMessageId(next.clientMessageId) ?? next;
      this.emitSnapshot(running);
      this.activeEntries.add(running);
      let terminalChanged = false;
      try {
        const reconciled = await this.reconcileBeforeRun?.(running);
        if (!this.canWriteTerminal()) return;
        const outcome = reconciled ?? await this.runPrompt(running);
        if (!this.canWriteTerminal()) return;
        if (outcome.ok) {
          terminalChanged = this.store.markCompleted(running.id, this.workerId);
        } else {
          terminalChanged = this.store.markFailed(
            running.id,
            new Error(outcome.error ?? "Prompt execution failed"),
            this.workerId,
          );
        }
      } catch (error) {
        if (this.canWriteTerminal()) {
          terminalChanged = this.store.markFailed(running.id, error, this.workerId);
          this.onError?.(error);
        }
      } finally {
        this.activeEntries.delete(running);
      }
      if (terminalChanged) {
        this.emitSnapshot(this.store.getByClientMessageId(running.clientMessageId) ?? running);
      }
    }
  }

  private async reconcileInterrupted(previousOwnerId: string | null): Promise<void> {
    for (const entry of this.store.listInterrupted(previousOwnerId)) {
      if (!this.isOwner()) return;
      let outcome: PromptQueueRunOutcome | null = null;
      let reconciliationError: unknown = null;
      try {
        outcome = await this.reconcileBeforeRun?.(entry) ?? null;
      } catch (error) {
        reconciliationError = error;
      }
      if (!this.canWriteTerminal()) return;
      const changed = outcome?.ok
        ? this.store.completeInterrupted(entry.id, this.workerId, previousOwnerId)
        : this.store.failInterrupted(
          entry.id,
          this.workerId,
          previousOwnerId,
          reconciliationError ?? new Error(outcome?.error ?? INTERRUPTED_PROMPT_ERROR),
        );
      if (reconciliationError) this.onError?.(reconciliationError);
      if (changed) {
        this.emitSnapshot(this.store.getByClientMessageId(entry.clientMessageId) ?? entry);
      }
    }
  }

  private loseOwnership(error: unknown): void {
    if (this.ownershipLost) return;
    this.ownershipLost = true;
    if (this.ownershipTimer) {
      clearInterval(this.ownershipTimer);
      this.ownershipTimer = null;
    }
    for (const entry of this.activeEntries) this.abortRun?.(entry);
    this.onError?.(error);
  }
}
