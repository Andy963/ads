import { beforeAll } from "vitest";

beforeAll(() => {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (!g.crypto) {
    // Vitest jsdom should provide crypto, but keep tests resilient.
    g.crypto = { getRandomValues: (arr: Uint8Array) => arr } as unknown as Crypto;
  }

  const cryptoAny = g.crypto as unknown as { randomUUID?: () => string };
  if (!cryptoAny.randomUUID) {
    cryptoAny.randomUUID = () => `uuid-${Date.now()}`;
  }
});

