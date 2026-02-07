import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("markdown heading style regression", () => {
  it("clamps markdown heading font sizes inside MarkdownContent", () => {
    const sfc = readUtf8("../components/MarkdownContent.vue");

    // Prevent Markdown headings (e.g. pasted prompts) from rendering at giant browser defaults.
    expect(sfc).toMatch(/\.md\s*:deep\(h1\)\s*\{[\s\S]*?font-size:\s*15px\s*;/);
    expect(sfc).toMatch(/\.md\s*:deep\(h2\)\s*\{[\s\S]*?font-size:\s*14px\s*;/);

    // h3-h6 share the same font-size rule.
    expect(sfc).toMatch(/:deep\(h3\)[\s\S]*?\{[\s\S]*?font-size:\s*13px\s*;/);
    expect(sfc).toMatch(/:deep\(h6\)[\s\S]*?\{[\s\S]*?font-size:\s*13px\s*;/);
  });
});
