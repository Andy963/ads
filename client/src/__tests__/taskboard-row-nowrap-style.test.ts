import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("TaskBoard row layout", () => {
  it("keeps the task row from wrapping actions onto a second line", () => {
    const css = readUtf8("../components/TaskBoard.css");
    expect(css).toMatch(/\.row\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.row-actions\s*\{[\s\S]*?flex:\s*0\s+0\s+auto\s*;[\s\S]*?\}/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*?\.row\s*\{[\s\S]*?flex-direction:\s*column\s*;/);
  });
});
