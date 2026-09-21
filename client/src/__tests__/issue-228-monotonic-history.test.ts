import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import MainChat from "../components/MainChat.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import type { ChatMessage } from "../components/mainChat/types";

enableAutoUnmount(afterEach);

function messages(count: number, prefix = "m"): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: "assistant",
    kind: "text",
    content: `Message ${prefix}-${index}`,
  }));
}

function mountList(items: ChatMessage[], host?: HTMLElement) {
  return mount(MainChatMessageList, {
    props: {
      messages: items,
      copiedMessageId: null,
      formatMessageTs: () => "",
      liveStepExpanded: false,
      liveStepHasOverflow: false,
      liveStepCanToggleExpanded: false,
      liveStepOutlineItems: [],
      liveStepOutlineHiddenCount: 0,
      liveStepCollapsedTrivialOutline: false,
    },
    global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
    attachTo: host,
  });
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
  await nextTick();
}

describe("Issue #228 monotonic history window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("retains all initially loaded rows when tail messages arrive before the first expansion", async () => {
    const wrapper = mountList(messages(65));
    const initialRows = wrapper.findAll(".msg").map((row) => row.element);
    expect(initialRows).toHaveLength(30);

    await wrapper.setProps({ messages: messages(67) });
    expect(wrapper.findAll(".msg")).toHaveLength(32);
    initialRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index].element).toBe(row));
  });

  it("keeps the loaded boundary stable across backfill, replay, and content updates", async () => {
    const original = messages(100);
    const wrapper = mountList(original);
    const firstRow = wrapper.get('.msg[data-id="m-70"]').element;
    const backfilled = [...messages(20, "older"), ...original];

    await wrapper.setProps({ messages: backfilled });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.get('.msg[data-id="m-70"]').element).toBe(firstRow);

    await wrapper.setProps({ messages: backfilled.map((message) => ({ ...message, content: `${message.content}!` })) });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.get('.msg[data-id="m-70"]').element).toBe(firstRow);
  });

  it("preserves surviving loaded rows when a transient boundary row disappears", async () => {
    const original = messages(65);
    const wrapper = mountList(original);
    const survivingRows = wrapper.findAll(".msg").slice(1).map((row) => row.element);

    await wrapper.setProps({ messages: original.filter((message) => message.id !== "m-35") });
    expect(wrapper.findAll(".msg")).toHaveLength(survivingRows.length);
    survivingRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index].element).toBe(row));
  });

  it("resets the initial window only when the transcript is replaced or cleared", async () => {
    const wrapper = mountList(messages(65));
    await wrapper.vm.loadEarlierMessages();
    expect(wrapper.findAll(".msg")).toHaveLength(50);

    await wrapper.setProps({ messages: messages(80, "other") });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.findAll(".msg")[0].attributes("data-id")).toBe("other-50");

    await wrapper.setProps({ messages: [] });
    expect(wrapper.findAll(".msg")).toHaveLength(0);
    await wrapper.setProps({ messages: messages(90) });
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.findAll(".msg")[0].attributes("data-id")).toBe("m-60");
  });

  it("loads one page per intersection without rearming the observer or writing scrollTop", async () => {
    let callback: IntersectionObserverCallback = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    class Observer {
      constructor(onIntersection: IntersectionObserverCallback) {
        callback = onIntersection;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const host = document.createElement("div");
    host.className = "chat";
    document.body.append(host);
    const writeScrollTop = vi.fn();
    Object.defineProperty(host, "scrollTop", { get: () => 120, set: writeScrollTop });
    const wrapper = mountList(messages(85), host);
    const initialRows = wrapper.findAll(".msg").map((row) => row.element);
    const intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

    intersect();
    intersect();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(writeScrollTop).not.toHaveBeenCalled();
    initialRows.forEach((row, index) => expect(wrapper.findAll(".msg")[index + 20].element).toBe(row));

    intersect();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(70);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(writeScrollTop).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(disconnect).toHaveBeenCalled();
    intersect();
    expect(writeScrollTop).not.toHaveBeenCalled();
  });
});

describe("Issue #228 bottom-following intent", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mountChat() {
    const wrapper = mount(MainChat, {
      props: {
        messages: messages(65),
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
        readOnly: true,
      },
      global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
      attachTo: document.body,
    });
    const host = wrapper.get(".chat").element as HTMLElement;
    let top = 0;
    let height = 1000;
    const writeScrollTop = vi.fn((value: number) => { top = Math.max(0, Math.min(value, height - 200)); });
    Object.defineProperties(host, {
      clientHeight: { get: () => 200 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: writeScrollTop },
    });
    const scrollAway = () => {
      top = 400;
      host.dispatchEvent(new Event("scroll"));
    };
    return { wrapper, host, writeScrollTop, scrollAway, grow: (value: number) => { height = value; } };
  }

  it("cancels a pending initial bottom scroll before older rows are prepended", async () => {
    const { wrapper, writeScrollTop } = mountChat();
    await wrapper.getComponent(MainChatMessageList).vm.loadEarlierMessages();
    await settle();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(writeScrollTop).not.toHaveBeenCalled();
  });

  it("rechecks user intent after a tail update commits and before its queued scroll write", async () => {
    const { wrapper, host, writeScrollTop, scrollAway } = mountChat();
    await settle();
    expect(writeScrollTop).toHaveBeenCalledWith(1000);
    writeScrollTop.mockClear();

    const stopWatching = wrapper.vm.$watch("messages", scrollAway, { flush: "post" });
    await wrapper.setProps({ messages: messages(67) });
    await settle();
    stopWatching();
    expect(host.scrollTop).toBe(400);
    expect(writeScrollTop).not.toHaveBeenCalled();

    await wrapper.get(".scrollToBottom").trigger("click");
    await settle();
    expect(writeScrollTop).toHaveBeenCalledWith(1000);
  });

  it("settles an explicit jump after a delayed layout without disabling following (Issue #236)", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const tick = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const { wrapper, host, grow, scrollAway } = mountChat();
    await settle();
    scrollAway();
    await settle();
    const button = wrapper.get(".scrollToBottom");
    expect(button.element.parentElement).toBe(host.parentElement);
    await button.trigger("click");
    await settle();
    grow(1600);
    host.dispatchEvent(new Event("scroll"));
    for (let frame = 0; frame < 10; frame += 1) tick();
    await settle();
    expect(host.scrollTop).toBe(1400);
    expect(wrapper.find(".scrollToBottom").exists()).toBe(false);
    grow(1800);
    await wrapper.setProps({ messages: messages(67) });
    await settle();
    expect(host.scrollTop).toBe(1600);
    wrapper.unmount();
    expect(frames.size).toBe(0);
  });

  it("cancels pending bottom correction as soon as the user scrolls away", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const { wrapper, host, grow, scrollAway, writeScrollTop } = mountChat();
    await settle();
    scrollAway();
    await settle();
    await wrapper.get(".scrollToBottom").trigger("click");
    await settle();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    scrollAway();
    grow(1600);
    writeScrollTop.mockClear();
    [...frames.values()].forEach((callback) => callback(0));
    await settle();
    expect(host.scrollTop).toBe(400);
    expect(writeScrollTop).not.toHaveBeenCalled();
    expect(wrapper.find(".scrollToBottom").exists()).toBe(true);
  });
});
