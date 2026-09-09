import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relFromThisFile), "utf8");
}

describe("mobile typography", () => {
  it("allows the browser to zoom the PWA viewport", () => {
    const html = readUtf8("../../index.html");

    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    );
    expect(html).not.toMatch(/maximum-scale\s*=\s*1(?:\.0)?/);
    expect(html).not.toMatch(/user-scalable\s*=\s*no/);
  });

  it("keeps compact desktop Markdown styles and adds readable mobile sizes", () => {
    const sfc = readUtf8("../components/MarkdownContent.vue");

    expect(sfc).toMatch(/\.md\s*\{[\s\S]*?font-size:\s*13px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.md\s*\{[\s\S]*?font-size:\s*16px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.md\s*:deep\(h1\)\s*\{[\s\S]*?font-size:\s*19px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.md\s*:deep\(h2\)\s*\{[\s\S]*?font-size:\s*17px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.md\s*:deep\(h3\)[\s\S]*?font-size:\s*16px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.md\s*:deep\(\.md-codeblock pre > code\)[\s\S]*?font-size:\s*14px\s*;/);
  });

  it("enlarges mobile command output and metadata", () => {
    const sfc = readUtf8("../components/MainChatMessageList.vue");

    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.execute-output[\s\S]*?font-size:\s*14px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.patchCardDiff[\s\S]*?font-size:\s*14px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.msgTime[\s\S]*?font-size:\s*12px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.retryBadge[\s\S]*?font-size:\s*12px\s*;/);
  });

  it("raises mobile App chrome microcopy to the minimum readable size", () => {
    const css = readUtf8("../App.css");

    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.brandVersion,[\s\S]*?font-size:\s*12px\s*;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.projectBranch,[\s\S]*?font-size:\s*12px\s*;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.mobileContextActionHint[\s\S]*?font-size:\s*12px\s*;/);
  });
});
