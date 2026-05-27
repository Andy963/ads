import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("main chat error style regression", () => {
  it("keeps restored error history visually distinct from normal system messages", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    expect(css).toMatch(/\.msg\[data-kind="error"\]\s+\.bubble\s*\{/);
    expect(css).toMatch(/\.msg\[data-kind="error"\]\s+\.bubble\s*\{[\s\S]*?border-color:\s*rgba\(251,\s*146,\s*60,\s*0\.55\)\s*;[\s\S]*?\}/);
  });
});
