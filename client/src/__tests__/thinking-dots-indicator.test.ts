import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { readSfc } from "./readSfc";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

function mountWithAssistantPlaceholder(streaming: boolean, content: string) {
  return mount(MainChatMessageList, {
    props: {
      messages: [{ id: "a-1", role: "assistant", kind: "text", content, streaming }],
      copiedMessageId: null,
      formatMessageTs: () => "",
      liveStepExpanded: false,
      liveStepHasOverflow: false,
      liveStepCanToggleExpanded: false,
      liveStepOutlineItems: [],
      liveStepOutlineHiddenCount: 0,
      liveStepCollapsedTrivialOutline: false,
    },
    global: {
      stubs: {
        MarkdownContent: true,
        ChatFilePreviewModal: true,
      },
    },
    attachTo: document.body,
  });
}

describe("thinking placeholder animated dots", () => {
  it("renders the label with three staggered dots for an empty streaming assistant message", async () => {
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);

    const typing = wrapper.get(".typing");
    expect(typing.attributes("aria-label")).toBe("AI is thinking");
    expect(typing.get(".thinkingLabel").text()).toBe("thinking");

    const dots = typing.get(".thinkingDots");
    expect(dots.attributes("aria-hidden")).toBe("true");
    expect(dots.findAll(".thinkingDot")).toHaveLength(3);
    expect(wrapper.find(".thinkingText").exists()).toBe(false);

    wrapper.unmount();
  });

  it("hides the placeholder once content arrives or streaming stops", async () => {
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);
    expect(wrapper.find(".thinkingDots").exists()).toBe(true);

    await wrapper.setProps({
      messages: [{ id: "a-1", role: "assistant", kind: "text", content: "Hello", streaming: true }],
    });
    await settleUi(wrapper);
    expect(wrapper.find(".thinkingDots").exists()).toBe(false);

    wrapper.unmount();
  });

  it("animates dots with GPU-friendly staggered pulse styles instead of width steps", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    expect(css).not.toContain(".thinkingText::after");
    expect(css).not.toContain("@keyframes thinkingDots");
    expect(css).toMatch(/\.thinkingDots\s*\{[^}]*display:\s*inline-flex\s*;/);
    expect(css).toMatch(/\.thinkingDot\s*\{[^}]*background:\s*currentColor\s*;[^}]*animation:\s*thinkingDotPulse[^;]*;/);
    expect(css).toMatch(/\.thinkingDot:nth-child\(2\)\s*\{[^}]*animation-delay:\s*0\.15s\s*;/);
    expect(css).toMatch(/\.thinkingDot:nth-child\(3\)\s*\{[^}]*animation-delay:\s*0\.3s\s*;/);
    const pulse = css.match(/@keyframes thinkingDotPulse\s*\{[\s\S]*?\n\}/)?.[0];
    expect(pulse).toContain("opacity:");
    expect(pulse).toContain("transform: scale(");
    expect(pulse).not.toContain("width:");
  });
});
