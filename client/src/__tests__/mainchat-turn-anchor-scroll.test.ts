import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import MainChat from "../components/MainChat.vue";
import type { ChatMessage } from "../components/mainChat/types";

function msg(id: string, role: "user" | "assistant", content: string, streaming = false): ChatMessage {
  return { id, role, kind: "text", content, ts: 1, streaming };
}

function rect(top: number, height = 40): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    height,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

type ScrollState = { top: number; height: number };

/**
 * jsdom performs no layout, so rect measurements are patched to emulate a
 * scroll container: each `.msg` row reports a fixed content offset, and the
 * host reports the viewport. Row tops move inversely with scrollTop.
 */
function installLayoutMocks(host: HTMLElement, state: ScrollState, rowOffsets: Record<string, number>) {
  Object.defineProperties(host, {
    clientHeight: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => state.height },
    scrollTop: {
      configurable: true,
      get: () => state.top,
      set: (value: number) => {
        state.top = Math.max(0, Math.min(value, state.height - 600));
      },
    },
  });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === host) return rect(0, 600);
    const id = this.getAttribute?.("data-id");
    if (id && id in rowOffsets) return rect(rowOffsets[id] - state.top);
    return originalRect.call(this);
  });
}

function mountChat(messages: ChatMessage[]) {
  const wrapper = mount(MainChat, {
    props: {
      messages,
      queuedPrompts: [],
      pendingImages: [],
      connected: true,
      busy: true,
    },
    global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
    attachTo: document.body,
  });
  const host = wrapper.get(".chat").element as HTMLElement;
  return { wrapper, host };
}

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();
}

describe("MainChat top-anchored reading viewport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("anchors the start of the streaming assistant response when the turn arrives together", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([
      msg("a-1", "assistant", "earlier"),
      msg("a-2", "assistant", "previous answer"),
    ]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400); // mounts on the bottom edge

    // The user submits a new prompt: the user message lands at content
    // offset 1000 and the transcript grows past the bottom edge.
    rowOffsets["u-2"] = 1000;
    rowOffsets["a-3"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "", true),
      ],
    });
    await settleUi(wrapper);

    // Bottom-following would be 1700 - 600 = 1100; the assistant response
    // start is held 8px below the viewport top instead.
    expect(state.top).toBe(1040 - 8);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    // The assistant reply streams in below the anchor: the viewport must not
    // move, so line 1 of the reply stays on screen.
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "streaming answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    // Streaming continues growing the reply far beyond one screen.
    state.height = 4200;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "streaming answer\nwith more content", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    wrapper.unmount();
  });

  it("waits for the assistant row when the user and streaming placeholder arrive separately", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([
      msg("a-1", "assistant", "earlier"),
      msg("a-2", "assistant", "previous answer"),
    ]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    rowOffsets["u-2"] = 1000;
    state.height = 1700;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    rowOffsets["a-3"] = 1040;
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    wrapper.unmount();
  });

  it("anchors an existing streaming assistant after the chat is remounted", async () => {
    const state: ScrollState = { top: 0, height: 2600 };
    const rowOffsets: Record<string, number> = { "a-2": 1040 };
    const messages = [
      msg("a-1", "assistant", "earlier"),
      msg("u-2", "user", "question"),
      msg("a-2", "assistant", "streaming answer", true),
    ];

    const first = mountChat(messages);
    installLayoutMocks(first.host, state, rowOffsets);
    await settleUi(first.wrapper);
    expect(state.top).toBe(1040 - 8);
    first.wrapper.unmount();
    vi.restoreAllMocks();

    state.top = 0;
    const remounted = mountChat(messages);
    installLayoutMocks(remounted.host, state, rowOffsets);
    await settleUi(remounted.wrapper);
    expect(state.top).toBe(1040 - 8);

    remounted.wrapper.unmount();
  });

  it("does not anchor while an initial transcript is hydrated", async () => {
    const state: ScrollState = { top: 0, height: 2000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    const messages = Array.from({ length: 40 }, (_, index) =>
      msg(`history-${index}`, index % 2 === 0 ? "user" : "assistant", `history ${index}`),
    );
    await wrapper.setProps({ messages });
    await settleUi(wrapper);

    expect(wrapper.get(".messageList").attributes("data-loaded-messages")).toBe("30");
    wrapper.unmount();
  });

  it("does not anchor when a cached transcript is replaced by the full history", async () => {
    const state: ScrollState = { top: 0, height: 2000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    const cachedMessages = [
      msg("cached-user", "user", "cached prompt"),
      msg("cached-assistant", "assistant", "cached reply"),
    ];
    await wrapper.setProps({ messages: cachedMessages });
    await settleUi(wrapper);

    const messages = [
      ...cachedMessages,
      ...Array.from({ length: 38 }, (_, index) =>
        msg(`history-${index}`, index % 2 === 0 ? "user" : "assistant", `history ${index}`),
      ),
    ];
    await wrapper.setProps({ messages });
    await settleUi(wrapper);

    expect(wrapper.get(".messageList").attributes("data-loaded-messages")).toBe("30");
    wrapper.unmount();
  });

  it("ignores subpixel scroll drift while maintaining the turn anchor", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    state.top += 1.5;
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    wrapper.unmount();
  });

  it("does not clear the turn anchor on touchstart before a scroll gesture", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    host.dispatchEvent(new Event("touchstart", { bubbles: true }));
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    wrapper.unmount();
  });

  it("keeps the first-turn anchor when the transcript still fits on one screen", async () => {
    const state: ScrollState = { top: 0, height: 300 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(0);

    rowOffsets["u-1"] = 0;
    state.height = 400;
    await wrapper.setProps({ messages: [msg("u-1", "user", "first question")] });
    await settleUi(wrapper);
    expect(state.top).toBe(0);

    // The reply grows several screens long; the reply start stays at the top
    // instead of being kicked off-screen by bottom-pinning.
    rowOffsets["a-1"] = 60;
    state.height = 2400;
    await wrapper.setProps({ messages: [msg("u-1", "user", "first question"), msg("a-1", "assistant", "long answer", true)] });
    await settleUi(wrapper);
    expect(state.top).toBe(60 - 8);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("resumes bottom-following after the user scrolls down near the bottom", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    // The user scrolls down toward the bottom of the transcript.
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: 400 }));
    state.top = 2600 - 600 - 40;
    host.dispatchEvent(new Event("scroll"));
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // New deltas re-pin the tail to the bottom edge.
    state.height = 3000;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2400);

    wrapper.unmount();
  });

  it("hands the viewport back to the user after a scroll-away without re-pinning deltas", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "", true)],
    });
    await settleUi(wrapper);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    // The user scrolls up to re-read an earlier passage.
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    state.top = 120;
    host.dispatchEvent(new Event("scroll"));
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    // Streaming deltas must not move the viewport back to the anchor or bottom.
    state.height = 3000;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(120);

    wrapper.unmount();
  });

  it("does not pull a new reply into view while the user is reading history", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    state.top = 120;
    host.dispatchEvent(new Event("scroll"));

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "streaming answer", true),
      ],
    });
    await settleUi(wrapper);

    expect(state.top).toBe(120);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("restores bottom-following when the floating scroll-to-bottom button is clicked", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "", true)],
    });
    await settleUi(wrapper);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    await wrapper.get(".scrollToBottom").trigger("click");
    await settleUi(wrapper);
    expect(state.top).toBe(2000);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // Following stays enabled for the rest of the turn.
    state.height = 3200;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2600);

    wrapper.unmount();
  });

  it("anchors each newly submitted turn while a previous turn is still anchored", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "first question"), msg("a-2", "assistant", "", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "first question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - 8);

    // A follow-up prompt arrives before the first reply finished reading:
    // the reading viewport moves to the new assistant response.
    rowOffsets["u-3"] = 2400;
    rowOffsets["a-3"] = 2440;
    state.height = 3600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "first question"),
        msg("a-2", "assistant", "answer", true),
        msg("u-3", "user", "second question"),
        msg("a-3", "assistant", "", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2440 - 8);

    wrapper.unmount();
  });
});
