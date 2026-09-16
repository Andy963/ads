import { describe, expect, it } from "vitest";

import { readSfc } from "./readSfc";

describe("PWA manifest navigation", () => {
  it("uses the deployment base as the stable app id, start URL, and scope", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);

    expect(config).toContain("id: base");
    expect(config).toContain("start_url: base");
    expect(config).toContain("scope: base");
  });

  it("applies pending updates on cold start and defers mid-session updates to a user prompt", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);
    expect(config).toContain("injectRegister: false");
    expect(config).toContain("clientsClaim: true");

    const script = await readSfc("../../public/registerSW.js", import.meta.url);
    // The service worker must not self-activate mid-session; the page decides.
    expect(config).not.toContain("skipWaiting: true");
    // Cold start: a waiting worker is activated immediately so the reload happens
    // before the app becomes interactive.
    expect(script).toContain('.getRegistration("/")');
    expect(script).toContain('postMessage({ type: "SKIP_WAITING" })');
    // Mid-session: show a user-controlled update toast instead of force-reloading.
    expect(script).toContain("新版本已就绪");
    expect(script).toContain("立即更新");
  });
});
