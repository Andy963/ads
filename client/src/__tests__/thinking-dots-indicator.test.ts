import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { readSfc } from "./readSfc";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

function mountWithAssistantPlaceholder(streaming: boolean, content: string) {
  return mount(MainChatMessageList, {
    props: {
      messages: [{ id: "a-1", role: "assistant", kind: "text", content, streaming }],
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
}

describe("thinking placeholder animated dots", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders the label with exactly three dots for an empty streaming assistant message", async () => {
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);

    const typing = wrapper.get(".typing");
    expect(typing.attributes("aria-label")).toBe("AI is thinking");
    expect(typing.get(".thinkingLabel").text()).toBe("thinking");

    const dots = typing.get(".thinkingDots");
    expect(dots.attributes("aria-hidden")).toBe("true");
    expect(dots.findAll(".thinkingDot")).toHaveLength(3);
    expect(wrapper.find(".thinkingText").exists()).toBe(false);

    wrapper.unmount();
  });

  it.each([
    { content: "Hello", streaming: true },
    { content: "", streaming: false },
  ])("stops the timer when the placeholder disappears: %j", async ({ content, streaming }) => {
    vi.useFakeTimers();
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);
    expect(wrapper.find(".thinkingDots").exists()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await wrapper.setProps({
      messages: [{ id: "a-1", role: "assistant", kind: "text", content, streaming }],
    });
    await settleUi(wrapper);
    expect(wrapper.find(".thinkingDots").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    wrapper.unmount();
  });

  it("advances one active dot at a time while the placeholder is visible", async () => {
    vi.useFakeTimers();
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);

    expect(wrapper.findAll(".thinkingDot--active")).toHaveLength(1);
    expect(wrapper.findAll(".thinkingDot--active")[0].element).toBe(wrapper.findAll(".thinkingDot")[0].element);

    const dots = wrapper.findAll(".thinkingDot").map((dot) => dot.element);
    for (const activeIndex of [1, 2, 0]) {
      vi.advanceTimersByTime(180);
      await settleUi(wrapper);
      expect(wrapper.findAll(".thinkingDot--active")).toHaveLength(1);
      expect(wrapper.get(".thinkingDot--active").element).toBe(dots[activeIndex]);
    }

    await wrapper.setProps({
      messages: [{ id: "a-1", role: "assistant", kind: "text", content: "Hello", streaming: true }],
    });
    await settleUi(wrapper);
    expect(wrapper.find(".thinkingDots").exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    wrapper.unmount();
  });

  it("stops the timer and visibility listener when unmounted during thinking", async () => {
    vi.useFakeTimers();
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);
    const visibilityListener = addListener.mock.calls.find(([event]) => event === "visibilitychange")?.[1];
    expect(visibilityListener).toBeTypeOf("function");
    expect(vi.getTimerCount()).toBe(1);

    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
  });

  it("runs only one phase timer while the document is in the foreground", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const wrapper = mountWithAssistantPlaceholder(true, "");
    await settleUi(wrapper);
    expect(vi.getTimerCount()).toBe(0);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(180);
    await settleUi(wrapper);
    const activeDot = wrapper.get(".thinkingDot--active").element;
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(180);
    await settleUi(wrapper);
    expect(wrapper.get(".thinkingDot--active").element).toBe(activeDot);

    wrapper.unmount();
  });

  it("uses transform and opacity state changes instead of CSS keyframe animation", async () => {
    const css = await readSfc("../components/mainChat/ThinkingDots.vue", import.meta.url);

    expect(css).not.toContain(".thinkingText::after");
    expect(css).not.toContain("@keyframes thinkingDots");
    expect(css).toMatch(/\.thinkingDots\s*\{[^}]*display:\s*inline-flex\s*;/);
    expect(css).toMatch(/\.thinkingDot\s*\{[^}]*opacity:\s*0\.3\s*;/);
    expect(css).toMatch(/\.thinkingDot\s*\{[^}]*transform:\s*translate3d\(0, 0, 0\) scale\(0\.85\)\s*;/);
    expect(css).toMatch(/\.thinkingDot--active\s*\{[^}]*opacity:\s*1\s*;/);
    expect(css).toMatch(/\.thinkingDot--active\s*\{[^}]*transform:\s*translate3d\(0, -2px, 0\) scale\(1\.15\)\s*;/);
  });
});
