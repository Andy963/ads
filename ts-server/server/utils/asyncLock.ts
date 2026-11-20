import { createAbortError } from "./abort.js";

export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  isBusy(): boolean {
    return this.pending > 0;
  }

  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw createAbortError("用户中断了请求");
    }

    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    let acquired = false;
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(createAbortError("用户中断了请求"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          previous.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      } else {
        await previous;
      }
      acquired = true;
      return await fn();
    } finally {
      if (acquired) {
        release();
      } else {
        void previous.then(release);
      }
      this.pending = Math.max(0, this.pending - 1);
    }
  }
}
