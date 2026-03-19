import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("main chat patch style regression", () => {
  it("keeps patch diff colors reachable from scoped styles", () => {
    const css = readUtf8("../components/MainChat.css");

    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatAdd\)\s*\{/);
    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatDel\)\s*\{/);
    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatBinary\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--add\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--del\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--meta\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--hunk\)\s*\{/);
  });
});
