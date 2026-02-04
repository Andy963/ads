import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("execute block style regression", () => {
  it("does not force a fixed execute block height and clamps output to 3 lines", () => {
    const css = readUtf8("../components/MainChat.css");

    // Execute cards should size to content (up to the output clamp) and not enforce a fixed height.
    expect(css).not.toMatch(/\.execute-block\s*\{[^}]*height:\s*\d+px\s*;/);
    expect(css).not.toMatch(/height:\s*88px\s*;/);

    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?justify-content:\s*flex-start\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?display:\s*flex\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?flex:\s*1\s+1\s+auto\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-cmd\s*\{[\s\S]*?text-overflow:\s*ellipsis\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?overflow:\s*hidden\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?white-space:\s*pre-wrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?-webkit-line-clamp:\s*3\s*;[\s\S]*?\}/);

    // Old stacked-underlay styling should not be present.
    expect(css).not.toMatch(/\.execute-underlay/);
    expect(css).not.toMatch(/\.execute-underlays/);
    expect(css).not.toMatch(/\.execute-stack\s*\{/);
  });
});
