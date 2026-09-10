import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import { readSfc } from "./readSfc";

const ComposerHost = defineComponent({
  components: { MainChatComposerPanel },
  props: { initialDraft: { type: String, default: "" } },
  setup(props) {
    const draft = ref(props.initialDraft);
    return { draft };
  },
  template: `
    <MainChatComposerPanel
      v-model:draft="draft"
      :queued-prompts="[]"
      :pending-images="[]"
      :connected="true"
      :busy="false"
    />
  `,
});

describe("MainChat compact composer layout", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      boxSizing: "border-box",
      lineHeight: "24px",
      fontSize: "16px",
      paddingTop: "5px",
      paddingBottom: "5px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("places the single-line input between the action and send controls", () => {
    const wrapper = mount(ComposerHost);
    const row = wrapper.get(".composerMainRow");
    const textarea = row.get("textarea.composer-input");

    expect((textarea.element as HTMLTextAreaElement).rows).toBe(1);
    expect(Array.from(row.element.children).map((element) => element.className)).toEqual([
      "composerMainRowLeft",
      "composer-input",
      "composerMainRowRight",
    ]);
    expect(row.get('[data-testid="composer-actions-toggle"]').exists()).toBe(true);
    expect(row.get(".micIcon").exists()).toBe(true);
    expect(row.get(".sendIcon").exists()).toBe(true);
    expect(textarea.attributes("title")).toContain("Shift+Enter");
    wrapper.unmount();
  });

  it("grows with content and returns to one line after sending or clearing", async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return this.value.split("\n").length * 24 + 10;
    });

    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea.composer-input");
    const element = textarea.element as HTMLTextAreaElement;
    const longDraft = Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n");

    expect(element.style.height).toBe("34px");
    expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");
    await textarea.setValue("First line\nSecond line");
    expect(element.style.height).toBe("58px");
    expect(element.style.overflowY).toBe("hidden");
    expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");

    await textarea.setValue(longDraft);
    expect(element.style.height).toBe("202px");
    expect(element.style.overflowY).toBe("auto");

    await wrapper.get(".sendIcon").trigger("click");
    expect(wrapper.getComponent(MainChatComposerPanel).emitted("send")).toEqual([[longDraft]]);
    expect(element.value).toBe("");
    expect(element.style.height).toBe("34px");
    expect(element.style.overflowY).toBe("hidden");
    expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");

    await textarea.setValue(longDraft);
    await textarea.setValue("");
    expect(element.style.height).toBe("34px");
    expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");
    wrapper.unmount();
  });

  it.each(["", "Short draft"])("starts with one input row for draft %j", async (initialDraft) => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(34);
    const wrapper = mount(ComposerHost, { props: { initialDraft } });
    await nextTick();

    const textarea = wrapper.get("textarea.composer-input").element as HTMLTextAreaElement;
    expect(textarea.value).toBe(initialDraft);
    expect(textarea.rows).toBe(1);
    expect(textarea.style.height).toBe("34px");
    expect(wrapper.get(".composerMainRow").classes()).toEqual(["composerMainRow"]);
    wrapper.unmount();
  });

  it("shrinks wrapped content without reserving a separate controls row", async () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(34);
    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea.composer-input");

    scrollHeight.mockReturnValue(58);
    await textarea.setValue("A draft that wraps beside the action buttons");
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe("58px");
    expect(wrapper.get(".composerMainRow").classes()).toEqual(["composerMainRow"]);

    scrollHeight.mockReturnValue(34);
    await textarea.setValue("Short draft");
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe("34px");
    expect(wrapper.get(".composerMainRow").classes()).toEqual(["composerMainRow"]);

    scrollHeight.mockReturnValue(58);
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe("58px");
    expect(wrapper.get(".composerMainRow").classes()).toEqual(["composerMainRow"]);

    scrollHeight.mockReturnValue(34);
    await textarea.setValue("");
    expect((textarea.element as HTMLTextAreaElement).style.height).toBe("34px");
    wrapper.unmount();
  });

  it("resizes wrapped drafts when a hidden lane becomes visible without a height feedback loop", async () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(34);
    const observers: Array<{ callback: ResizeObserverCallback; observer: ResizeObserver }> = [];
    const observe = vi.fn();
    const disconnect = vi.fn();
    const animationFrames: FrameRequestCallback[] = [];
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return ++nextFrameId;
    }));
    const cancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    vi.stubGlobal("ResizeObserver", class {
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, observer: this });
      }
    });

    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea.composer-input");
    const element = textarea.element as HTMLTextAreaElement;
    const notifyWidth = (width: number, flushFrames = true): void => {
      const { callback, observer } = observers[0]!;
      callback([{ target: element, contentRect: { width } } as ResizeObserverEntry], observer);
      if (flushFrames) {
        for (const frame of animationFrames.splice(0)) frame(0);
      }
    };
    await nextTick();
    expect(observe).toHaveBeenCalledWith(element);
    notifyWidth(240);
    scrollHeight.mockReturnValue(298);
    await textarea.setValue("Wrapped draft content ".repeat(150));
    expect(element.style.height).toBe("202px");

    notifyWidth(0);
    scrollHeight.mockReturnValue(0);
    window.dispatchEvent(new Event("resize"));
    scrollHeight.mockReturnValue(298);
    notifyWidth(240);
    expect(element.style.height).toBe("202px");
    expect(element.style.overflowY).toBe("auto");

    scrollHeight.mockClear();
    notifyWidth(240);
    expect(scrollHeight).not.toHaveBeenCalled();
    notifyWidth(320, false);
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenLastCalledWith(nextFrameId);
  });

  it("keeps controls compact and the composer in the bottom flex flow", async () => {
    const composer = await readSfc("../components/MainChatComposerPanel.vue", import.meta.url);
    const chat = await readSfc("../components/MainChat.vue", import.meta.url);

    expect(composer).toMatch(/\.composerMainRow\s*\{[^}]*align-items:\s*flex-end\s*;/);
    expect(composer).toMatch(/\.composerMainRowLeft,\s*\.composerMainRowRight\s*\{[^}]*flex:\s*0 0 auto\s*;/);
    expect(composer).toMatch(/\.composer-input\s*\{[^}]*flex:\s*1 1 auto\s*;[^}]*min-width:\s*0\s*;/);
    expect(composer).toMatch(/\.composer\s*\{[^}]*flex-shrink:\s*0\s*;/);
    expect(composer).not.toMatch(/\.composer\s*\{[^}]*position:\s*(absolute|fixed)\s*;/);
    expect(chat).toMatch(/\.detail\s*\{[^}]*display:\s*flex\s*;[^}]*flex-direction:\s*column\s*;/);
    expect(chat).toMatch(/\.chat\s*\{[^}]*flex:\s*1 1 auto\s*;/);
  });

  it("keeps safe-area protection in the bottom dock, outside the single-row input", async () => {
    const composer = await readSfc("../components/MainChatComposerPanel.vue", import.meta.url);
    const composerRule = composer.match(/\.composer\s*\{[^}]*\}/)?.[0];
    const inputWrapRule = composer.match(/\.inputWrap\s*\{[^}]*\}/)?.[0];

    expect(composerRule).toContain("padding: 8px 16px calc(env(safe-area-inset-bottom, 0px) * var(--safe-bottom-multiplier, 1));");
    expect(inputWrapRule).not.toContain("safe-area-inset-bottom");
    expect(inputWrapRule).not.toContain("padding-bottom");
    expect(composer).not.toMatch(/padding-bottom:\s*calc\(12px\s*\+/);
  });

  it("keeps the textarea and actions in one grid row as content grows", async () => {
    const composer = await readSfc("../components/MainChatComposerPanel.vue", import.meta.url);

    expect(composer).toMatch(/\.composerMainRow\s*\{[^}]*display:\s*grid\s*;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto\s*;[^}]*grid-template-areas:\s*"left input right"\s*;/);
    expect(composer).toMatch(/\.composer-input\s*\{[^}]*width:\s*100%\s*;/);
    expect(composer).not.toContain("composerMainRow--expanded");
  });
});
