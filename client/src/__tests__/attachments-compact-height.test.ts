import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("compact attachment UI", () => {
  it("MainChat renders thumbnail previews with clear action", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [{ data: "data:image/png;base64,AA==" }],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);
    const thumb = wrapper.find(".attachmentsThumb");
    expect(thumb.exists()).toBe(true);

    await wrapper.find(".attachmentsRemoveBadge").trigger("click");
    expect(wrapper.emitted("removeImage")?.[0]?.[0]).toBe(0);
    expect(wrapper.emitted("clearImages")).toBeTruthy();

    wrapper.unmount();
  });
});
