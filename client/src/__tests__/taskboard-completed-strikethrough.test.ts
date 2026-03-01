import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("TaskBoard completed style", () => {
  it("renders completed task titles with a strikethrough", () => {
    const css = readUtf8("../components/TaskBoard.css");
    expect(css).toMatch(
      /\.item\[data-status="completed"\]\s+\.row-title\s*\{[\s\S]*?text-decoration:\s*line-through\s*;[\s\S]*?\}/,
    );
  });
});

