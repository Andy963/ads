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
  it("keeps a fixed execute block height and consistent stack spacing", () => {
    const css = readUtf8("../components/MainChat.css");

    expect(css).toMatch(/\.execute-block\s*\{[\s\S]*?height:\s*100px\s*;[\s\S]*?\}/);

    // "Real" stacking: underlays peek above the top edge and are clipped at the bottom.
    expect(css).toMatch(/execute-stack-peek:\s*24px\s*;/);
    expect(css).toMatch(/\.execute-stack\s*\{[\s\S]*?overflow:\s*hidden\s*;[\s\S]*?padding-top:\s*calc\(var\(--execute-stack-peek\)\s*\*\s*var\(--execute-stack-underlays\)\)\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlays\s*\{[\s\S]*?top:\s*0\s*;[\s\S]*?bottom:\s*0\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlay\s*\{[\s\S]*?bottom:\s*0\s*;[\s\S]*?\}/);

    // Underlays use a per-element CSS variable so the stack can grow beyond 2 layers.
    expect(css).toMatch(/--execute-underlay-layer:\s*1\s*;/);
    expect(css).toMatch(
      /transform:\s*translate\(0,\s*calc\(-1\s*\*\s*var\(--execute-stack-peek\)\s*\*\s*var\(--execute-underlay-layer\)\)\)\s*;/,
    );

    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?justify-content:\s*flex-start\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?display:\s*flex\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?flex:\s*1\s+1\s+auto\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-cmd\s*\{[\s\S]*?text-overflow:\s*ellipsis\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?overflow:\s*hidden\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?white-space:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?text-overflow:\s*ellipsis\s*;[\s\S]*?\}/);
  });
});
