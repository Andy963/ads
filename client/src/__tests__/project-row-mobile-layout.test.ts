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
    expect(css).toMatch(/\.projectNode\.active\s+\.projectRowActions\s*\{[\s\S]*opacity:\s*1\s*[;\s][\s\S]*pointer-events:\s*auto\s*;/);
  });

  it("locks project item dimensions and configures mobile drawer project tree scrolling (Issue #338)", async () => {
    const css = await readText("../App.css");

    // Base .projectNode rules
    expect(css).toMatch(/\.projectNode\s*\{[^}]*flex-shrink:\s*0\s*;/);
    expect(css).toMatch(/\.projectNode\s*\{[^}]*min-height:\s*46px\s*;/);

    // Mobile media query rules
    const mobileStart = css.indexOf("@media (max-width: 900px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileCss = css.slice(mobileStart);

    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*flex:\s*1 1 0\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overflow-y:\s*auto\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overflow-x:\s*hidden\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*padding:\s*8px 8px 24px\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*-webkit-overflow-scrolling:\s*touch\s*;/);
    expect(mobileCss).toMatch(/\.projectTree\s*\{[^}]*overscroll-behavior:\s*contain\s*;/);

    // Redundant title hidden and header aligned compactly
    expect(mobileCss).toMatch(/\.projectTreeTitle\s*\{[^}]*display:\s*none\s*;/);
    expect(mobileCss).toMatch(/\.projectTreeHeader\s*\{[^}]*justify-content:\s*flex-end\s*;/);

    // Short display (iPhone SE) navigation spacing
    expect(css).toMatch(/@media\s*\(max-height:\s*600px\)[\s\S]*?\.mobileDrawerNavItem\s*\{[^}]*min-height:\s*38px\s*;/);
    expect(css).toMatch(/@media\s*\(max-height:\s*600px\)[\s\S]*?\.mobileDrawerNavItem\s*\{[^}]*padding:\s*6px 10px\s*;/);
  });
});
