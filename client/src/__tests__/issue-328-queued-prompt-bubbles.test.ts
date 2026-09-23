import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

describe("issue-328 queued prompt bubbles", () => {
  it("renders queued prompts with order badges and emits removeQueued on click", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        draft: "",
        queuedPrompts: [
          { id: "q-1", clientMessageId: "c-1", text: "First long prompt line 1\nline 2\nline 3\nline 4", imagesCount: 0, createdAt: 1 },
          { id: "q-2", clientMessageId: "c-2", text: "Second prompt", imagesCount: 2, createdAt: 2 },
        ],
        pendingImages: [],
        connected: true,
        busy: false,
      },
    });

    const queueItems = wrapper.findAll(".queue-item");
    expect(queueItems).toHaveLength(2);

    // Verify order badges
    expect(queueItems[0]?.find(".queue-badge").text()).toBe("#1");
    expect(queueItems[1]?.find(".queue-badge").text()).toBe("#2");

    // Verify text content
    expect(queueItems[0]?.find(".queue-text").text()).toContain("First long prompt");
    expect(queueItems[1]?.find(".queue-text").text()).toContain("Second prompt");
    expect(queueItems[1]?.find(".queue-sub").text()).toContain("图片 x2");

    // Verify deletion emit
    await queueItems[0]?.find(".queue-del").trigger("click");
    expect(wrapper.emitted("removeQueued")).toEqual([["q-1"]]);

    await queueItems[1]?.find(".queue-del").trigger("click");
    expect(wrapper.emitted("removeQueued")).toEqual([["q-1"], ["q-2"]]);
  });
});
