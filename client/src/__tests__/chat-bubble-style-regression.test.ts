import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("chat bubble and popover style regressions", () => {
  it("renders user bubbles with light blue background and bottom clearance for actions", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    // User bubbles must use light blue background
    expect(css).toMatch(/\.msg\[data-role="user"\]\s+\.bubble\s*\{[\s\S]*?background:\s*rgba\(221,\s*244,\s*255,\s*0\.88\)/);
    expect(css).toMatch(/\.msg\[data-role="user"\]\s+\.bubble\s*\{[\s\S]*?padding:\s*10px 16px 28px/);

    // Assistant bubbles must not stack unnecessary horizontal padding
    expect(css).toMatch(/\.bubble\s*\{[\s\S]*?padding:\s*4px 0 24px/);
  });

  it("renders reasoning effort options as a vertical list instead of horizontal wrap", async () => {
    const sfc = await readSfc("../components/MainChatModelPopover.vue", import.meta.url);

    // Must not use horizontal wrapping class
    expect(sfc).not.toContain("modelPopoverReasoningOption");
    expect(sfc).not.toMatch(/\.modelPopoverReasoning\s*\{[\s\S]*?flex-wrap:\s*wrap/);

    // Must use unified vertical options list
    expect(sfc).toMatch(/<div[^>]*class="modelPopoverOptions"[^>]*data-testid="chat-reasoning-effort"/);
  });
});
