export interface KeyInfo {
  key: string;
  index: number;
}

export class ApiKeyManager {
  private currentIndex = 0;

  constructor(private readonly keys: string[]) {}

  size(): number {
    return this.keys.length;
  }

  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  getCurrent(): KeyInfo | null {
    if (!this.hasKeys()) {
      return null;
    }
    return { key: this.keys[this.currentIndex], index: this.currentIndex };
  }

  moveToNext(): KeyInfo | null {
    if (!this.hasKeys()) {
      return null;
    }
    if (this.currentIndex + 1 >= this.keys.length) {
      return null;
    }
    this.currentIndex += 1;
    return { key: this.keys[this.currentIndex], index: this.currentIndex };
  }

  reset(): void {
    this.currentIndex = 0;
  }
}
