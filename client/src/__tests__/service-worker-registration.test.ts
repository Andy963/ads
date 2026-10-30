import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";
import { readSfc } from "./readSfc";

describe("service worker registration", () => {
  it("registers inside the deployment base path", async () => {
    const source = await readSfc("../../public/registerSW.js", import.meta.url);
    let onLoad: (() => void) | undefined;
    const registration = { addEventListener: vi.fn(), update: vi.fn(async () => {}) };
    const register = vi.fn(() => Promise.resolve(registration));

    runInNewContext(source, {
      URL: globalThis.URL,
      navigator: {
        serviceWorker: {
          controller: null,
          addEventListener() {},
          register,
        },
      },
      window: {
        location: { reload() {} },
        addEventListener(type: string, listener: () => void) {
          if (type === "load") onLoad = listener;
        },
      },
      document: { currentScript: { src: "https://ads.example.test/nested/ads/registerSW.js" } },
    });

    onLoad?.();

    expect(register).toHaveBeenCalledWith("https://ads.example.test/nested/ads/sw.js", {
      scope: "/nested/ads/",
      updateViaCache: "none",
    });
  });
});
