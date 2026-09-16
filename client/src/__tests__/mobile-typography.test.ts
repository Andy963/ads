import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, relFromThisFile), "utf8");
}

describe("mobile typography", () => {
  it("disables page zoom in the PWA viewport and keeps mobile form controls at 16px", () => {
    const html = readUtf8("../../index.html");

    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />',
    );

    // iOS Safari auto-zooms when focusing form controls below 16px.
    const css = readUtf8("../global.css");
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?textarea\s*\{[\s\S]*?font-size:\s*16px\s*;/);
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

  it("enlarges mobile command text and metadata", () => {
    const sfc = readUtf8("../components/MainChatMessageList.vue");

    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.execute-cmd[\s\S]*?font-size:\s*14px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.patchCardDiff[\s\S]*?font-size:\s*14px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.msgTime[\s\S]*?font-size:\s*12px\s*;/);
    expect(sfc).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.retryBadge[\s\S]*?font-size:\s*12px\s*;/);
  });

  it("raises mobile App chrome microcopy to the minimum readable size", () => {
    const css = readUtf8("../App.css");

    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.drawerBrandVersion,[\s\S]*?font-size:\s*12px\s*;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.projectBranch,[\s\S]*?font-size:\s*12px\s*;/);
  });

  it("keeps mobile context actions compact without inline hint text", () => {
    const css = readUtf8("../App.css");
    const mobileCss = css.slice(css.indexOf("@media (max-width: 900px)"));
    const menu = mobileCss.match(/\.mobileContextMenu\s*\{[^}]*\}/)?.[0];
    const action = mobileCss.match(/\.mobileContextAction\s*\{[^}]*\}/)?.[0];
    const disabled = mobileCss.match(/\.mobileContextAction:disabled\s*\{[^}]*\}/)?.[0];

    expect(menu).toMatch(/width:\s*max-content\s*;/);
    expect(menu).toMatch(/min-width:\s*140px\s*;/);
    expect(menu).toMatch(/max-width:\s*calc\(100vw - 24px\)\s*;/);
    expect(action).toMatch(/align-items:\s*center\s*;/);
    expect(action).toMatch(/min-height:\s*44px\s*;/);
    expect(disabled).toMatch(/opacity:\s*0\.72\s*;/);
    expect(disabled).toMatch(/cursor:\s*not-allowed\s*;/);
    expect(css).not.toMatch(/\.mobileContextMenuTitle\s*\{/);
    expect(css).not.toMatch(/\.mobileContextActionHint\s*\{/);
  });
});
