import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("MainChat header UI", () => {
  it("renders thread warnings inside the chat pane", () => {
    const warning = "上下文线程已重置（预期=thread-old，实际=thread-new）。";
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        threadWarning: warning,
      },
      global: { stubs: { MarkdownContent: true } },
    });

    const headerWarning = wrapper.find('[data-testid="main-chat-thread-warning"]');
    expect(headerWarning.exists()).toBe(true);
    expect(headerWarning.text()).toContain(warning);
    expect(wrapper.find(".threadWarningBanner").exists()).toBe(true);
    wrapper.unmount();
  });
});
