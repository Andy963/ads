type Release = () => void;

type PendingAcquire = {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_PENDING = 32;

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function resolveLimits(): { maxConcurrency: number; maxPending: number } {
  return {
    maxConcurrency: Math.max(
      1,
      parseNonNegativeInteger(process.env.ADS_CLI_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
    ),
    maxPending: parseNonNegativeInteger(process.env.ADS_CLI_MAX_PENDING, DEFAULT_MAX_PENDING),
  };
}

class CliExecutionGovernor {
  private active = 0;
  private readonly pending: PendingAcquire[] = [];

  async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const limits = resolveLimits();
    if (this.active < limits.maxConcurrency) {
      this.active += 1;
      return this.createRelease();
    }
    if (this.pending.length >= limits.maxPending) {
      throw new Error(
        `CLI execution queue is full (${this.active} active, ${this.pending.length} pending)`,
      );
    }

    return await new Promise<Release>((resolve, reject) => {
      const entry: PendingAcquire = {
        resolve,
        reject: (error) => reject(error),
        signal,
      };
      if (signal) {
        entry.onAbort = () => {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.push(entry);
    });
  }

  private createRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    const { maxConcurrency } = resolveLimits();
    while (this.active < maxConcurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      if (entry.onAbort) {
        entry.signal?.removeEventListener("abort", entry.onAbort);
      }
      if (entry.signal?.aborted) {
        entry.reject(new DOMException("Aborted", "AbortError"));
        continue;
      }
      this.active += 1;
      entry.resolve(this.createRelease());
    }
  }
}

export const cliExecutionGovernor = new CliExecutionGovernor();
