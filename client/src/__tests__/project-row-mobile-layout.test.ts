import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

async function readText(relativeToThisTest: string): Promise<string> {
  const url = new URL(relativeToThisTest, import.meta.url);
  return readFile(url, "utf8");
}

describe("project row layout", () => {
  it("stacks project name and branch on mobile", async () => {
    const css = await readText("../App.css");

    expect(css).toMatch(/\.projectText\s*\{[\s\S]*flex-direction:\s*column\s*;/);
    expect(css).toMatch(/\.projectBranch\s*\{[\s\S]*display:\s*block\s*;/);

    expect(css).not.toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*\.projectText\s*\{[\s\S]*flex-direction:\s*row\s*;/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*\.projectBranch\s*\{[\s\S]*display:\s*inline\s*;/);
  });
});

