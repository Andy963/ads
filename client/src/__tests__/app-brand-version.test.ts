import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("App brand version display", () => {
  it("includes brand title and version badge in App.vue template and style", async () => {
    const content = await readSfc("../App.vue", import.meta.url);

    expect(content).toMatch(/class="brand"/);
    expect(content).toMatch(/class="brandVersion"/);
    expect(content).toContain("v{{ appVersion }}");
    expect(content).toMatch(/\.brandVersion\s*\{/);
  });
});
