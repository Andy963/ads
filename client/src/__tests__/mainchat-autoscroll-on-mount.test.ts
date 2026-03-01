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

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

function msg(id: string, role: "user" | "assistant", content: string) {
  return { id, role, kind: "text" as const, content, ts: Date.now() };
}

describe("MainChat auto-scroll on mount", () => {
  it("scrolls to bottom when mounting a project with existing history", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [msg("u-1", "user", "hello"), msg("a-1", "assistant", "world"), msg("a-2", "assistant", "latest")],
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

    const chat = wrapper.find(".chat").element as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => 900 });
    chat.scrollTop = 0;

    await settleUi(wrapper);
    expect(chat.scrollTop).toBe(900);

    wrapper.unmount();
  });

  it("keeps scrolling to bottom while the last message grows (streaming updates)", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [msg("u-1", "user", "hello"), msg("a-1", "assistant", "start")],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: true,
      },
      global: {
        stubs: {
          MarkdownContent: MarkdownContentStub,
        },
      },
      attachTo: document.body,
    });

    const chat = wrapper.find(".chat").element as HTMLElement;
    let height = 400;
    Object.defineProperty(chat, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    chat.scrollTop = 0;

    await settleUi(wrapper);
    expect(chat.scrollTop).toBe(400);

    height = 520;
    await wrapper.setProps({
      messages: [msg("u-1", "user", "hello"), { ...msg("a-1", "assistant", "start"), streaming: true, content: "start\nmore" }],
    });
    await settleUi(wrapper);
    expect(chat.scrollTop).toBe(520);

    wrapper.unmount();
  });

  it("scrolls to bottom when mounting a project with many messages", async () => {
    const messages = Array.from({ length: 120 }, (_, idx) =>
      msg(`m-${idx}`, idx % 2 === 0 ? "user" : "assistant", `line ${idx}`),
    );

    const wrapper = mount(MainChat, {
      props: {
        messages,
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

    const chat = wrapper.find(".chat").element as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => 3000 });
    chat.scrollTop = 0;

    await settleUi(wrapper);
    expect(chat.scrollTop).toBe(3000);

    wrapper.unmount();
  });

  it("does not crash when mounting an empty project and still aligns to the bottom edge", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
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

    const chat = wrapper.find(".chat").element as HTMLElement;
    Object.defineProperty(chat, "scrollHeight", { configurable: true, get: () => 120 });
    chat.scrollTop = 0;

    await settleUi(wrapper);
    expect(chat.scrollTop).toBe(120);

    wrapper.unmount();
  });
});
