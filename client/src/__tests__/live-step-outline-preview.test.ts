import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

describe("live-step outline preview", () => {
  it("shows extracted outline when collapsed and hides it when expanded", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "live-step", role: "assistant", kind: "text", content: "**Title A**\n\nBody", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: MarkdownContentStub,
        },
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    const md = wrapper.find('.msg[data-id="live-step"] .md').element as HTMLElement;
    Object.defineProperty(md, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(md, "clientHeight", { configurable: true, get: () => 100 });

    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "**Title A**\n\nBody\n\n**Title B**\n\nMore", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
      ],
    });

    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".liveStepOutline").exists()).toBe(true);
    expect(wrapper.findAll(".liveStepOutlineItem").map((n) => n.text())).toEqual(["•Title A", "•Title B"]);

    const toggle = wrapper.find(".liveStepToggleBtn");
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("Expand");

    await toggle.trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".liveStepOutline").exists()).toBe(false);
    expect(wrapper.find(".liveStepToggleBtn").text()).toContain("Collapse");

    wrapper.unmount();
  });

  it("hides expand toggle when there is only one title and no meaningful body", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "live-step", role: "assistant", kind: "text", content: "**Title A**", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: MarkdownContentStub,
        },
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    const md = wrapper.find('.msg[data-id="live-step"] .md').element as HTMLElement;
    Object.defineProperty(md, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(md, "clientHeight", { configurable: true, get: () => 100 });

    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "**Title A**\n", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
      ],
    });

    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".liveStepOutline").exists()).toBe(true);
    expect(wrapper.findAll(".liveStepOutlineItem").map((n) => n.text())).toEqual(["•Title A"]);
    expect(wrapper.find(".liveStepToggleBtn").exists()).toBe(false);

    wrapper.unmount();
  });
});
