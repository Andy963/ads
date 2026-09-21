import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

describe("main chat error style regression", () => {
  it("marks restored error history with the error kind hook, distinct from normal system messages", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "s-1", role: "system", kind: "text", content: "session restored", ts: 1 },
          { id: "e-1", role: "system", kind: "error", content: "turn failed: boom", ts: 2 },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: { stubs: { MarkdownContent: MarkdownContentStub, ChatFilePreviewModal: true } },
    });

    const errorRow = wrapper.get('.msg[data-kind="error"]');
    expect(errorRow.attributes("data-id")).toBe("e-1");
    expect(errorRow.find(".bubble").exists()).toBe(true);
    expect(errorRow.text()).toContain("turn failed: boom");

    const normalRow = wrapper.get('.msg[data-id="s-1"]');
    expect(normalRow.attributes("data-kind")).toBe("text");

    wrapper.unmount();
  });
});
