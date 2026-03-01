export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  isBusy(): boolean {
    return this.pending > 0;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
      this.pending = Math.max(0, this.pending - 1);
    }
  }
}
