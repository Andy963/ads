import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { readSfc } from "./readSfc";

describe("chat bubble and popover style regressions", () => {
  it("keeps user messages full width without a visual bubble", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);
    const userBubble = css.match(/\.msg\[data-role="user"\]\s+\.bubble\s*\{[^}]*\}/)?.[0];
    const userActions = css.match(/\.msg\[data-role="user"\]\s+\.msgActions\s*\{[^}]*\}/)?.[0];

    expect(userBubble).toMatch(/\n\s+width:\s*100%\s*;/);
    expect(userBubble).toMatch(/max-width:\s*100%\s*;/);
    expect(userBubble).toMatch(/background:\s*transparent\s*;/);
    expect(userBubble).toMatch(/border:\s*none\s*;/);
    expect(userBubble).toMatch(/border-radius:\s*0\s*;/);
    expect(userBubble).toMatch(/padding:\s*4px 0 8px\s*;/);
    expect(userActions).toMatch(/position:\s*static\s*;/);
    expect(userActions).toMatch(/display:\s*flex\s*;/);
    expect(userActions).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(userActions).toMatch(/justify-content:\s*flex-end\s*;/);
    expect(userActions).not.toMatch(/(?:left|right|bottom):/);

    // Assistant bubbles must not stack unnecessary horizontal padding
    expect(css).toMatch(/\.bubble\s*\{[\s\S]*?padding:\s*4px 0 24px/);
  });

  it.each([
    { label: "short text", content: "a" },
    { label: "wrapped text", content: "A longer user message ".repeat(20) },
  ])("keeps copy and timestamp inside the user bubble for $label", async ({ content }) => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "user-message", role: "user", kind: "text", content, ts: 1 }],
        copiedMessageId: null,
        formatMessageTs: () => "09:15",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
    });
    const actions = wrapper.get('.msg[data-role="user"] .bubble > .msgActions');

    expect(actions.get(".msgTime").text()).toBe("09:15");
    await actions.get(".msgCopyBtn").trigger("click");
    expect(wrapper.emitted("copyMessage")?.[0]?.[0]).toMatchObject({ id: "user-message", role: "user", content });
    wrapper.unmount();
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
