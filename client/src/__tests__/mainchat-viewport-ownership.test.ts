import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import type { TranscriptViewport } from "../app/transcriptCache";

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

function messages(prefix: string, count = 65) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`, role: index === 0 ? "user" as const : "assistant" as const,
    kind: "text" as const, content: `Message ${index}`, ts: index + 1,
  }));
}

function viewport(prefix: string, firstLoadedId = `${prefix}-35`): TranscriptViewport {
  return {
    following: false, firstLoadedId, anchorId: "missing-anchor", anchorOffset: 0,
    scrollTop: 180, userControlled: true, scopeKey: prefix, tailMessageId: `${prefix}-64`,
  };
}

function mountChat(options: { viewport?: TranscriptViewport; count?: number; hidden?: boolean; scope?: string; busy?: boolean } = {}) {
  const scope = options.scope ?? "a";
  const transcript = messages(scope, options.count);
  const wrapper = mount(MainChat, {
    props: {
      messages: transcript.map((message, index) => options.busy && index === transcript.length - 1
        ? { ...message, streaming: true } : message), viewport: options.viewport,
      transcriptScopeKey: scope, transcriptAuthoritative: false, transcriptAuthoritativeSeq: 0,
      transcriptResetSeq: 0, transcriptAlignSeq: 0,
      queuedPrompts: [], pendingImages: [], connected: true, busy: options.busy ?? false,
    },
    global: { stubs: { MarkdownContent: { props: ["content"], template: '<div class="md">{{ content }}</div>' } } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  const chat = wrapper.get(".chat").element as HTMLElement;
  const layout = { height: options.hidden ? 0 : 900 };
  Object.defineProperties(chat, {
    scrollHeight: { configurable: true, get: () => layout.height },
    clientHeight: { configurable: true, get: () => layout.height ? 300 : 0 },
  });
  return { wrapper, chat, layout };
}

async function settle(wrapper: ReturnType<typeof mount>) {
  for (let index = 0; index < 5; index += 1) await wrapper.vm.$nextTick();
}

async function scrollUp(wrapper: ReturnType<typeof mount>, chat: HTMLElement) {
  await wrapper.get(".chat").trigger("wheel", { deltaY: -80 });
  chat.scrollTop = 120;
  await wrapper.get(".chat").trigger("scroll");
}

describe("transcript viewport ownership", () => {
  it.each(["actions", "acopilot"])("preserves an explicit older-page position on in-flight %s mount and remount", async (scope) => {
    const saved = { ...viewport(scope, `${scope}-0`), anchorId: `${scope}-5`, anchorOffset: 20 };
    for (let pass = 0; pass < 2; pass += 1) {
      const { wrapper, chat, layout } = mountChat({ viewport: saved, scope, busy: true });
      layout.height = 5000;
      const anchor = wrapper.get(`[data-id="${scope}-5"]`).element as HTMLElement;
      anchor.getBoundingClientRect = () => ({ top: 500 - chat.scrollTop, bottom: 600 - chat.scrollTop } as DOMRect);
      const answer = wrapper.get(`[data-id="${scope}-64"]`).element as HTMLElement;
      answer.getBoundingClientRect = () => ({ top: 4000 - chat.scrollTop, bottom: 4100 - chat.scrollTop } as DOMRect);
      await settle(wrapper);
      expect(chat.scrollTop).toBe(480);
      expect(chat.style.overflowAnchor).not.toBe("none");
      await wrapper.setProps({ transcriptAuthoritative: true, transcriptAuthoritativeSeq: 1 });
      await settle(wrapper);
      expect(chat.scrollTop).toBe(480);
      wrapper.unmount();
      wrappers.splice(wrappers.indexOf(wrapper), 1);
    }
  });

  it.each([false, true])("keeps explicit input above a hydration snapshot and alignment pass (hidden=%s)", async (hidden) => {
    const { wrapper, chat, layout } = mountChat({ count: 1, hidden });
    await settle(wrapper);
    layout.height = 900;
    await scrollUp(wrapper, chat);
    await wrapper.setProps({
      messages: messages("a", 8), transcriptAuthoritative: true,
      transcriptAuthoritativeSeq: 1, transcriptAlignSeq: 1,
    });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(120);
    await wrapper.setProps({ connected: false });
    await wrapper.setProps({ connected: true, transcriptAlignSeq: 2 });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(120);
  });

  it("cancels a queued tail alignment on physical intent before the scroll event", async () => {
    const { wrapper, chat } = mountChat({ count: 1 });
    await settle(wrapper);
    const update = wrapper.setProps({ messages: messages("a", 2) });
    chat.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
    chat.scrollTop = 120;
    await update;
    await settle(wrapper);
    expect(chat.scrollTop).toBe(120);
  });

  it("restores the destination scope's valid viewport before a panel remount", async () => {
    const { wrapper, chat } = mountChat({ viewport: viewport("a") });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(180);
    await wrapper.setProps({ messages: messages("b"), transcriptScopeKey: "b", viewport: viewport("b") });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(180);
    await wrapper.setProps({ transcriptAuthoritative: true, transcriptAuthoritativeSeq: 1 });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(180);
  });

  it("restores an explicit reading anchor older than the newest message window", async () => {
    const saved = { ...viewport("a", "a-0"), anchorId: "a-5", anchorOffset: 20 };
    const { wrapper, chat } = mountChat({ viewport: saved });
    const row = wrapper.get('[data-id="a-5"]').element as HTMLElement;
    row.getBoundingClientRect = () => ({ top: 500 - chat.scrollTop, bottom: 600 - chat.scrollTop } as DOMRect);
    await settle(wrapper);
    expect(chat.scrollTop).toBe(480);
    expect(wrapper.findAll(".messageList > .msg")).toHaveLength(65);
    await wrapper.setProps({ transcriptAuthoritative: true, transcriptAuthoritativeSeq: 1 });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(480);
  });

  it("retires manual reading state on a generation reset with an unchanged scope key", async () => {
    const { wrapper, chat, layout } = mountChat();
    await settle(wrapper);
    await scrollUp(wrapper, chat);
    layout.height = 1400;
    await wrapper.setProps({
      messages: messages("generation-two", 2), viewport: null,
      transcriptResetSeq: 1, transcriptAuthoritative: true, transcriptAuthoritativeSeq: 1,
    });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(1400);
    await scrollUp(wrapper, chat);
    await wrapper.setProps({ transcriptAuthoritativeSeq: 2, transcriptAlignSeq: 2 });
    await settle(wrapper);
    expect(chat.scrollTop).toBe(120);
  });
});
