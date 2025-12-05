type Task<T> = {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export interface RateLimiterConfig {
  concurrency: number;
  rps: number;
}

export class RateLimiter {
  private readonly queue: Array<Task<unknown>> = [];
  private readonly timestamps: number[] = [];
  private active = 0;

  constructor(private readonly config: RateLimiterConfig) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (value: unknown) => void, reject });
      this.drain();
    });
  }

  private drain(): void {
    // Clean old timestamps (older than 1s)
    const now = Date.now();
    while (this.timestamps.length > 0 && now - this.timestamps[0] >= 1000) {
      this.timestamps.shift();
    }

    if (this.active >= this.config.concurrency) {
      return;
    }

    if (this.timestamps.length >= this.config.rps) {
      const delay = 1000 - (now - this.timestamps[0]);
      setTimeout(() => this.drain(), Math.max(0, delay));
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.active += 1;
    this.timestamps.push(now);
    task
      .fn()
      .then(task.resolve)
      .catch(task.reject)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }
}
