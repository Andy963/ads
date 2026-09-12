import { describe, expect, it } from "vitest";

import { readSfc } from "./readSfc";

describe("PWA manifest navigation", () => {
  it("uses the deployment base as the stable app id, start URL, and scope", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);

    expect(config).toContain("id: base");
    expect(config).toContain("start_url: base");
    expect(config).toContain("scope: base");
  });

  it("activates updates even when the installed page has an older registration script", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);
    expect(config).toContain("injectRegister: false");
    expect(config).toContain("skipWaiting: true");
    expect(config).toContain("clientsClaim: true");
  });
});
