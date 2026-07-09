import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";

describe("main chat execution metadata", () => {
  it("does not render agent, model, or reasoning badges under user messages", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "u-1",
            role: "user",
            kind: "text",
            content: "hello",
            execution: {
              agentId: "codex",
              model: "gpt-5.5",
              modelReasoningEffort: "high",
              effectiveAgentId: "codex",
              effectiveModel: "gpt-5.5",
              effectiveModelReasoningEffort: "high",
            },
          },
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
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.find(".msgExecutionMeta").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Agent:");
    expect(wrapper.text()).not.toContain("Model:");
    expect(wrapper.text()).not.toContain("Reasoning:");

    wrapper.unmount();
  });
});
