import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";

describe("chat bubble content structure", () => {
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
});
