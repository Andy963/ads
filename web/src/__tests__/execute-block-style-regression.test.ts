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
    expect(css).toMatch(/\.execute-stack\s*\{[\s\S]*?padding-bottom:\s*12px\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlays\s*\{[\s\S]*?bottom:\s*12px\s*;[\s\S]*?bottom:\s*var\(--execute-stack-padding-bottom\)\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlay\s*\{[\s\S]*?bottom:\s*12px\s*;[\s\S]*?bottom:\s*var\(--execute-stack-padding-bottom\)\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlay\[data-layer="1"\]\s*\{[\s\S]*?transform:\s*translate\(0,\s*6px\)\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-underlay\[data-layer="2"\]\s*\{[\s\S]*?transform:\s*translate\(0,\s*12px\)\s*;[\s\S]*?\}/);

    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-cmd\s*\{[\s\S]*?text-overflow:\s*ellipsis\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-output\s*\{[\s\S]*?overflow:\s*auto\s*;[\s\S]*?\}/);
  });
});
