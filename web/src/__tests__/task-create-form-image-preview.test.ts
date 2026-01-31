import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("TaskCreateForm image preview", () => {
  it("renders a compact strip preview instead of large square tiles", async () => {
    const sfc = await readSfc("../components/TaskCreateForm.vue", import.meta.url);

    expect(sfc).toMatch(/\.thumbGrid\s*\{[\s\S]*display:\s*flex\s*;/);
    expect(sfc).toMatch(/\.thumbGrid\s*\{[\s\S]*overflow-x:\s*auto\s*;/);
    expect(sfc).toMatch(/\.thumbCard\s*\{[\s\S]*width:\s*80px\s*;/);
    expect(sfc).toMatch(/\.thumbWrap\s*\{[\s\S]*height:\s*24px\s*;/);
    expect(sfc).toMatch(/\.thumbImg\s*\{[\s\S]*object-fit:\s*cover\s*;/);

    // Mobile overrides keep the strip compact.
    expect(sfc).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*\.thumbCard\s*\{[\s\S]*width:\s*44px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*\.thumbWrap\s*\{[\s\S]*height:\s*32px\s*;/);
  });
});
