import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("execute block style regression", () => {
  it("keeps only a single ellipsized command line without output or actions", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    expect(css).not.toMatch(/\.execute-block\s*\{[^}]*height:\s*\d+px\s*;/);
    expect(css).not.toMatch(/height:\s*88px\s*;/);

    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-header\s*\{[\s\S]*?justify-content:\s*flex-start\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?display:\s*flex\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-left\s*\{[\s\S]*?flex:\s*1\s+1\s+auto\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-cmd\s*\{[\s\S]*?text-overflow:\s*ellipsis\s*;[\s\S]*?\}/);
    expect(css).toMatch(/\.execute-cmd\s*\{[^}]*white-space:\s*nowrap\s*;/);
    expect(css).toMatch(/\.execute-left\s+\.prompt-tag\s*\{[^}]*flex:\s*0 0 auto\s*;[^}]*white-space:\s*nowrap\s*;/);
    expect(css).toMatch(/\.executeSpinner\s*\{[^}]*flex:\s*0 0 auto\s*;/);
    expect(css).not.toMatch(/execute-output|execute-more|executeCopyBtn|execute-actions/);

    // Old stacked-underlay styling should not be present.
    expect(css).not.toMatch(/\.execute-underlay/);
    expect(css).not.toMatch(/\.execute-underlays/);
    expect(css).not.toMatch(/\.execute-stack\s*\{/);
  });
});
