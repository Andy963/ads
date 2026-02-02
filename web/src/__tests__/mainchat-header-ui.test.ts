import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("MainChat header UI", () => {
  it("does not render a busy label in the header", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
    });

    expect(wrapper.text().toLowerCase()).not.toContain("busy");
    wrapper.unmount();
  });
});
