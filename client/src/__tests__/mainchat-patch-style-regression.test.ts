import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("main chat patch style regression", () => {
  it("keeps patch diff colors reachable from scoped styles", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatAdd\)\s*\{/);
    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatDel\)\s*\{/);
    expect(css).toMatch(/\.patchCardMeta\s*:deep\(\.patchCardStatBinary\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--add\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--del\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--meta\)\s*\{/);
    expect(css).toMatch(/\.patchCardDiff\s*:deep\(\.patchCardDiffLine--hunk\)\s*\{/);
  });
});
