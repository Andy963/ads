import { describe, expect, it } from "vitest";

import { readSfc } from "./readSfc";

describe("PWA manifest navigation", () => {
  it("uses the deployment base as the stable app id, start URL, and scope", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);

    expect(config).toContain("id: base");
    expect(config).toContain("start_url: base");
    expect(config).toContain("scope: base");
  });

  it("shields the initial claim from reloading and defers updates to a user prompt", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);
    expect(config).toContain("injectRegister: false");
    expect(config).toContain("clientsClaim: true");

    const script = await readSfc("../../public/registerSW.js", import.meta.url);
    // The service worker must not self-activate mid-session; the page decides.
    expect(config).not.toContain("skipWaiting: true");
    // The initial clientsClaim must not reload the page: only reload when a
    // controller already existed before this page load.
    expect(script).toContain("hadController");
    expect(script).toContain("if (refreshing || !hadController) return;");
    // No silent cold-start activation racing the app boot; updates are applied
    // only after explicit user confirmation via the toast.
    expect(script).not.toContain('.getRegistration("/")');
    expect(script).not.toContain("applyWaitingWorker(registration);");
    expect(script).toContain('postMessage({ type: "SKIP_WAITING" })');
    // Mid-session: show a user-controlled update toast instead of force-reloading.
    expect(script).toContain("新版本已就绪");
    expect(script).toContain("立即更新");
  });
});
