import { describe, expect, it } from "vitest";

import { readSfc } from "./readSfc";

describe("PWA manifest navigation", () => {
  it("uses the deployment base as the stable app id, start URL, and scope", async () => {
    const config = await readSfc("../../vite.config.ts", import.meta.url);

    expect(config).toContain("id: base");
    expect(config).toContain("start_url: base");
    expect(config).toContain("scope: base");
  });
});
