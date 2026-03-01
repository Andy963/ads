import { config } from "@vue/test-utils";
import { beforeAll } from "vitest";

// TaskBoard uses Element Plus <el-icon>; in unit tests we don't mount the ElementPlus plugin.
// Stub it globally to avoid noisy "Failed to resolve component" warnings.
config.global.stubs = {
  ...(config.global.stubs ?? {}),
  "el-icon": true,
};

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

