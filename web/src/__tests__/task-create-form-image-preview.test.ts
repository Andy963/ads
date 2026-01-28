import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

async function readSfc(relativeToThisTest: string): Promise<string> {
  const url = new URL(relativeToThisTest, import.meta.url);
  return readFile(url, "utf8");
}

describe("TaskCreateForm image preview", () => {
  it("renders a compact strip preview instead of large square tiles", async () => {
    const sfc = await readSfc("../components/TaskCreateForm.vue");

    expect(sfc).toMatch(/\.thumbGrid\s*\{[\s\S]*display:\s*flex\s*;/);
    expect(sfc).toMatch(/\.thumbGrid\s*\{[\s\S]*overflow-x:\s*auto\s*;/);
    expect(sfc).toMatch(/\.thumbCard\s*\{[\s\S]*width:\s*160px\s*;/);
    expect(sfc).toMatch(/\.thumbWrap\s*\{[\s\S]*height:\s*56px\s*;/);
    expect(sfc).toMatch(/\.thumbImg\s*\{[\s\S]*object-fit:\s*cover\s*;/);

    // Mobile overrides keep the strip compact.
    expect(sfc).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*\.thumbCard\s*\{[\s\S]*width:\s*140px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*\.thumbWrap\s*\{[\s\S]*height:\s*52px\s*;/);
  });
});

