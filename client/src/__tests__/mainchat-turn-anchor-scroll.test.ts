import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import MainChat from "../components/MainChat.vue";
import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import type { ChatMessage } from "../components/mainChat/types";

const LOCK_OFFSET = 12;

function msg(id: string, role: "user" | "assistant" | "system", content: string, streaming = false): ChatMessage {
  return { id, role, kind: "text", content, ts: 1, streaming };
}

function executeMsg(id: string, command: string, streaming = true): ChatMessage {
  return { id, role: "system", kind: "execute", content: command, command, ts: 1, streaming };
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

type ScrollState = { top: number; height: number; clientHeight?: number };

/**
 * jsdom performs no layout, so rect measurements are patched to emulate a
 * scroll container: each `.msg` row reports a fixed content offset, and the
 * host reports the viewport. Row tops move inversely with scrollTop.
 */
function installLayoutMocks(host: HTMLElement, state: ScrollState, rowOffsets: Record<string, number>) {
  const defaultClientHeight = state.clientHeight ?? 600;
  Object.defineProperties(host, {
    clientHeight: { configurable: true, get: () => state.clientHeight ?? 600 },
    scrollHeight: { configurable: true, get: () => state.height },
    scrollTop: {
      configurable: true,
      get: () => state.top,
      set: (value: number) => {
        state.top = Math.max(0, Math.min(value, Math.max(0, state.height - (state.clientHeight ?? 600))));
      },
    },
  });
  const originalRect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === host) return rect(0, state.clientHeight ?? defaultClientHeight);
    const id = this.getAttribute?.("data-id");
    if (id && id in rowOffsets) return rect(rowOffsets[id] - state.top);
    return originalRect.call(this);
  });
}

function touchEvent(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    touches: { configurable: true, value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
    changedTouches: { configurable: true, value: [{ clientX: x, clientY: y }] },
  });
  return event;
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

describe("MainChat two-phase reading viewport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps a newly sent user row above the mobile keyboard composer", async () => {
    const visualViewport = Object.assign(new EventTarget(), {
      height: 600,
      offsetTop: 0,
      width: 390,
      offsetLeft: 0,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    const state: ScrollState = { top: 0, height: 1000, clientHeight: 600 };
    const rowOffsets: Record<string, number> = { "a-1": 0 };
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    state.clientHeight = 300;
    visualViewport.height = 300;
    const composer = wrapper.get(".composer").element as HTMLElement;
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(300, 80));

    // The keyboard shrinks and pans the visual viewport. The resulting chat
    // scroll event is layout-induced and must not disable tail-following.
    state.top = 0;
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
    await wrapper.get(".chat").trigger("scroll");
    await settleUi(wrapper);
    await vi.waitFor(() => expect(state.top).toBe(700));
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // The browser then emits its final scroll correction well past the last
    // animation frame, 400ms into the animation. The host does not always
    // compensate scrollTop for the container shrink, so the distance check would
    // read this layout-induced scroll as the user leaving unless the guard
    // covers the whole animation.
    state.top = 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await wrapper.get(".chat").trigger("scroll");
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // A real wheel gesture still hands control back to the user.
    await wrapper.get(".chat").trigger("wheel", { deltaX: 0, deltaY: -240, deltaZ: 0 });
    state.top = 0;
    await wrapper.get(".chat").trigger("scroll");
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    rowOffsets["u-2"] = 1000;
    state.height = 1200;
    wrapper.getComponent(MainChatComposerPanel).vm.$emit("send", "question");
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question")],
    });
    await settleUi(wrapper);
    await vi.waitFor(() => expect(state.top).toBe(900));

    const currentHost = wrapper.get(".chat").element as HTMLElement;
    const currentComposer = wrapper.get(".composer").element as HTMLElement;
    const userRow = wrapper.get('.msg[data-id="u-2"]').element;
    Object.defineProperty(currentHost, "getBoundingClientRect", { configurable: true, value: () => rect(0, 300) });
    Object.defineProperty(userRow, "getBoundingClientRect", { configurable: true, value: () => rect(rowOffsets["u-2"] - state.top) });
    Object.defineProperty(currentComposer, "getBoundingClientRect", { configurable: true, value: () => rect(300, 80) });
    const userRect = userRow.getBoundingClientRect();
    const hostRect = currentHost.getBoundingClientRect();
    const composerRect = currentComposer.getBoundingClientRect();
    expect(userRect.top).toBeGreaterThanOrEqual(hostRect.top);
    expect(userRect.bottom).toBeLessThanOrEqual(composerRect.top);

    wrapper.unmount();
  });

  it("releases tail-following on an arrow key while the keyboard animation window is still open", async () => {
    const visualViewport = Object.assign(new EventTarget(), {
      height: 600,
      offsetTop: 0,
      width: 390,
      offsetLeft: 0,
    });
    vi.stubGlobal("visualViewport", visualViewport);
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = { "a-1": 0 };
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    // The guard is deliberately still open 400ms in. This asserts that a real
    // key gesture, not only wheel and touch, is what hands control back.
    visualViewport.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await wrapper.get(".chat").trigger("keydown", { key: "ArrowUp" });
    state.top = 0;
    await wrapper.get(".chat").trigger("scroll");
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("locks the answer top once the first content delta lands and never corrects again", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([
      msg("a-1", "assistant", "earlier"),
      msg("a-2", "assistant", "previous answer"),
    ]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400); // mounts on the bottom edge

    // The user submits a new prompt: the user message and the empty thinking
    // placeholder land together, mirroring flushQueuedPrompts. The placeholder
    // is not the answer: phase 1 keeps following the tail.
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
    expect(state.top).toBe(1700 - 600);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // The first content delta of the final answer triggers the one-shot lock:
    // the answer row top is pinned READING_LOCK_TOP_OFFSET_PX below the
    // viewport top and bottom-following pauses.
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "first line", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("none");

    // Burst growth: the viewport must not move, so line 1 of the reply stays
    // on screen instead of being pushed off the top by bottom-pinning.
    state.height = 4200;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "first line\n\nburst of streamed markdown", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // The stream finishes: the lock persists so the user can keep reading.
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("a-2", "assistant", "previous answer"),
        msg("u-2", "user", "new question"),
        msg("a-3", "assistant", "first line\n\nburst of streamed markdown"),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("follows the tail through intermediate execution and locks when the final answer starts", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    // Phase 1: the user prompt and the first command output arrive. The
    // viewport follows the active tail and native anchoring stays untouched.
    rowOffsets["u-2"] = 1000;
    rowOffsets["exec-1"] = 1040;
    state.height = 1800;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        executeMsg("exec-1", "rg --files", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1800 - 600);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("");
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // More intermediate output accumulates far beyond one viewport: the tail
    // keeps being followed so the command output stays visible.
    rowOffsets["exec-2"] = 2400;
    state.height = 3400;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        executeMsg("exec-1", "rg --files", false),
        executeMsg("exec-2", "npm test", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(3400 - 600);

    // Phase 2: the final answer starts streaming after the command blocks.
    rowOffsets["a-2"] = 2840;
    state.height = 3600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        executeMsg("exec-1", "rg --files", false),
        executeMsg("exec-2", "npm test", false),
        msg("a-2", "assistant", "burst response", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2840 - LOCK_OFFSET);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("none");
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("returns to tail-following when execution resumes below the locked answer", async () => {
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
        msg("a-2", "assistant", "intermediate note", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // The model starts another tool call below the narration: the locked text
    // was not the final answer, so the viewport follows the tail again and the
    // command row stays visible.
    rowOffsets["exec-9"] = 2400;
    state.height = 3400;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "intermediate note"),
        executeMsg("exec-9", "npm run build", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(3400 - 600);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("auto");

    // The real answer then locks normally.
    rowOffsets["a-3"] = 2840;
    state.height = 3600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "intermediate note"),
        executeMsg("exec-9", "npm run build", false),
        msg("a-3", "assistant", "final answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2840 - LOCK_OFFSET);

    wrapper.unmount();
  });

  it("locks an in-flight streaming answer after the chat is remounted", async () => {
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
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    first.wrapper.unmount();
    vi.restoreAllMocks();

    state.top = 0;
    const remounted = mountChat(messages);
    installLayoutMocks(remounted.host, state, rowOffsets);
    await settleUi(remounted.wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    remounted.wrapper.unmount();
  });

  it("does not lock while an initial transcript is hydrated", async () => {
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
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not lock when a cached transcript is replaced by the full history", async () => {
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
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps following the tail until the answer is tall enough to align, then locks once", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(400);

    // The first delta lands, but a one-line answer leaves no scroll range to
    // align its top into: the lock stays pending and the tail is followed.
    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1080;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "line 1", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1080 - 600);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("");
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);

    // Once the answer can fill the viewport, the deferred alignment runs once.
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "line 1\nline 2\nline 3", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("none");
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    // Growth after the lock must not move the reading position.
    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "line 1\nline 2\nline 3\nburst", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    wrapper.unmount();
  });

  it("does not correct the viewport for layout drift or burst growth while reading-locked", async () => {
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
        msg("a-2", "assistant", "answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // Native layout shifts (e.g. an execute block above finishing) move the
    // viewport: no per-frame correction pulls it back to the anchor.
    state.top += 18;
    rowOffsets["a-2"] += 24;
    state.height = 2600;
    host.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET + 18);
    // The lock still holds: bottom-following stays paused and the FAB remains.
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("requires a touch drag beyond 10px to release the reading lock", async () => {
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
        msg("a-2", "assistant", "answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // A 9px drag is below the takeover threshold: the lock survives growth.
    host.dispatchEvent(touchEvent("touchstart", 100, 200));
    host.dispatchEvent(touchEvent("touchmove", 100, 209));
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("none");

    // An 11px drag releases the lock: the user owns the scroll position now.
    host.dispatchEvent(touchEvent("touchstart", 100, 200));
    host.dispatchEvent(touchEvent("touchmove", 100, 211));
    state.top = 120;
    state.height = 3000;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(120);

    wrapper.unmount();
  });

  it("ignores zero-delta wheel noise while reading-locked", async () => {
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
        msg("a-2", "assistant", "answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    host.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 0, deltaZ: 0 }));
    state.height = 2600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    wrapper.unmount();
  });

  it("defers the lock while the answer fits, aligns once it outgrows the viewport, then holds", async () => {
    const state: ScrollState = { top: 0, height: 300 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);
    expect(state.top).toBe(0);

    rowOffsets["u-1"] = 0;
    rowOffsets["a-1"] = 40;
    state.height = 400;
    await wrapper.setProps({
      messages: [msg("u-1", "user", "first question"), msg("a-1", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    // The transcript still fits: there is no scroll range to align into, so
    // the viewport keeps following the (already visible) tail.
    expect(state.top).toBe(0);

    // The reply grows beyond one screen: now the one-shot alignment can run
    // and pins the answer top 12px below the viewport top.
    rowOffsets["a-1"] = 60;
    state.height = 2400;
    await wrapper.setProps({ messages: [msg("u-1", "user", "first question"), msg("a-1", "assistant", "long answer", true)] });
    await settleUi(wrapper);
    expect(state.top).toBe(60 - LOCK_OFFSET);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    // Further growth must not move the reading position again.
    state.height = 3000;
    await wrapper.setProps({ messages: [msg("u-1", "user", "first question"), msg("a-1", "assistant", "long answer\nburst", true)] });
    await settleUi(wrapper);
    expect(state.top).toBe(60 - LOCK_OFFSET);

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
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer\nmore", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

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
        msg("a-2", "assistant", "answer\nmore\nmore", true),
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
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer\nmore", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // The user scrolls up to re-read an earlier passage.
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
    state.top = 120;
    host.dispatchEvent(new Event("scroll"));
    await settleUi(wrapper);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    // Streaming deltas must not move the viewport back to the answer or bottom.
    state.height = 3000;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore\nmore", true),
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
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer\nmore", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);

    await wrapper.get(".scrollToBottom").trigger("click");
    await settleUi(wrapper);
    expect(state.top).toBe(2000);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("auto");

    // Following stays enabled for the rest of the turn.
    state.height = 3200;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "question"),
        msg("a-2", "assistant", "answer\nmore\nmore", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2600);

    wrapper.unmount();
  });

  it("moves the reading lock to a follow-up prompt's answer", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "first question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    state.height = 2600;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "first question"), msg("a-2", "assistant", "answer\nmore", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // A follow-up prompt arrives before the first reply finished reading: the
    // viewport follows the new turn and locks onto its answer.
    rowOffsets["u-3"] = 2400;
    rowOffsets["a-3"] = 2440;
    state.height = 3600;
    await wrapper.setProps({
      messages: [
        msg("a-1", "assistant", "earlier"),
        msg("u-2", "user", "first question"),
        msg("a-2", "assistant", "answer\nmore"),
        msg("u-3", "user", "second question"),
        msg("a-3", "assistant", "second answer", true),
      ],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(2440 - LOCK_OFFSET);

    wrapper.unmount();
  });

  it("releases the lock and follows the tail when the transcript is reset", async () => {
    const state: ScrollState = { top: 0, height: 1000 };
    const rowOffsets: Record<string, number> = {};
    const { wrapper, host } = mountChat([msg("a-1", "assistant", "earlier")]);
    installLayoutMocks(host, state, rowOffsets);
    await settleUi(wrapper);

    rowOffsets["u-2"] = 1000;
    rowOffsets["a-2"] = 1040;
    state.height = 1700;
    await wrapper.setProps({
      messages: [msg("a-1", "assistant", "earlier"), msg("u-2", "user", "question"), msg("a-2", "assistant", "answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(1040 - LOCK_OFFSET);

    // The conversation is cleared underneath the lock.
    state.height = 600;
    await wrapper.setProps({ messages: [] });
    await settleUi(wrapper);
    expect(host.style.getPropertyValue("overflow-anchor")).toBe("auto");

    // The next turn follows the tail again from a clean slate.
    rowOffsets["u-3"] = 600;
    rowOffsets["a-4"] = 640;
    state.height = 2000;
    await wrapper.setProps({
      messages: [msg("u-3", "user", "next question"), msg("a-4", "assistant", "fresh answer", true)],
    });
    await settleUi(wrapper);
    expect(state.top).toBe(640 - LOCK_OFFSET);

    wrapper.unmount();
  });
});
