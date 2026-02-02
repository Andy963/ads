import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { mount } from "@vue/test-utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import MainChat from "../components/MainChat.vue";

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

function readUtf8(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, relFromThisFile);
  return fs.readFileSync(p, "utf8");
}

describe("live-step reasoning scroll style", () => {
  it("renders a stable hook and keeps the scroll constraint in CSS", () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "live-step", role: "assistant", kind: "text", content: "line1\nline2\nline3\nline4\nline5\nline6", streaming: true },
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

    const live = wrapper.find('.msg[data-id="live-step"]');
    expect(live.exists()).toBe(true);
    expect(live.find(".bubble").exists()).toBe(true);
    expect(live.find(".md").exists()).toBe(true);

    const css = readUtf8("../components/MainChat.css");
    expect(css).toMatch(/\.msg\[data-id="live-step"\]\s+\.bubble\s+:deep\(\.md\)\s*\{[\s\S]*?\}/);
    expect(css).toMatch(/max-height:\s*3lh\s*;/);
    expect(css).toMatch(/overflow-y:\s*auto\s*;/);

    wrapper.unmount();
  });

  it("auto-scrolls the live-step markdown while pinned to the bottom", async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as unknown as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof globalThis.cancelAnimationFrame;

    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "live-step", role: "assistant", kind: "text", content: "start", streaming: true },
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

    md.scrollTop = 0;
    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "start\nmore\nmore\nmore", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
      ],
    });
    await wrapper.vm.$nextTick();
    expect(md.scrollTop).toBe(1000);

    md.scrollTop = 0;
    md.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "start\nmore\nmore\nmore\nmore2", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
      ],
    });
    await wrapper.vm.$nextTick();
    expect(md.scrollTop).toBe(0);

    md.scrollTop = 900;
    md.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "start\nmore\nmore\nmore\nmore2\nmore3", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
      ],
    });
    await wrapper.vm.$nextTick();
    expect(md.scrollTop).toBe(1000);

    wrapper.unmount();

    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  });
});
