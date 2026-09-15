import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

const Host = defineComponent({
  components: { MainChatComposerPanel },
  setup() {
    return { draft: ref("") };
  },
  template: `
    <div class="detail">
      <div class="chat"></div>
      <MainChatComposerPanel
        v-model:draft="draft"
        :queued-prompts="[]"
        :pending-images="[]"
        :connected="true"
        :busy="false"
        connection-status-message="Connected"
      />
    </div>
  `,
});

function mountComposer() {
  const wrapper = mount(Host, { attachTo: document.body });
  const row = wrapper.get(".composerMainRow").element;
  vi.spyOn(row, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(wrapper.get(".composerMainRowLeft").element, "offsetWidth", "get").mockReturnValue(32);
  vi.spyOn(wrapper.get(".composerMainRowRight").element, "offsetWidth", "get").mockReturnValue(74);
  return wrapper;
}

describe("composer layout feedback", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      boxSizing: "border-box",
      lineHeight: "24px",
      fontSize: "16px",
      paddingTop: "5px",
      paddingBottom: "5px",
      paddingLeft: "0px",
      paddingRight: "0px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
      columnGap: "0px",
    } as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not feed the expanded input's changing scroll height back into its layout", async () => {
    let liveReads = 0;
    let measureReads = 0;
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      if (!this.value) return 34;
      if (this.hasAttribute("data-composer-measure")) {
        measureReads += 1;
        return this.value === "Short" ? 34 : 58;
      }
      liveReads += 1;
      // Bound the old implementation's feedback so a regression fails without
      // overflowing Vitest's own scheduler or hanging the test process.
      if (liveReads > 40) return 58;
      return this.closest(".composerMainRow--expanded") ? 34 : 58;
    });

    const wrapper = mountComposer();
    try {
      const textarea = wrapper.get("textarea.composer-input");
      await textarea.setValue("A draft near the soft wrap boundary");
      await nextTick();

      expect(wrapper.get(".composerMainRow").classes()).toContain("composerMainRow--expanded");
      expect(liveReads).toBeLessThan(10);
      expect(measureReads).toBeGreaterThan(0);
      expect(measureReads).toBeLessThan(5);
      expect((textarea.element as HTMLTextAreaElement).style.width).toBe("");

      await textarea.setValue("Short");
      expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");
    } finally {
      wrapper.unmount();
    }
    expect(document.querySelector("[data-composer-measure]")).toBeNull();
  });

  it("remeasures wrapping for external width changes, not its own height and input width changes", async () => {
    let notify: ResizeObserverCallback | undefined;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    let measureReads = 0;
    let measuredHeight = 58;
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      if (this.hasAttribute("data-composer-measure")) measureReads += 1;
      return this.value ? measuredHeight : 34;
    });

    const wrapper = mountComposer();
    try {
      const textarea = wrapper.get("textarea.composer-input");
      await textarea.setValue("A wrapped draft");
      await nextTick();
      const measurementsAfterInput = measureReads;
      expect(measurementsAfterInput).toBeGreaterThan(0);

      const deliverResize = (target: Element, width: number, height: number): void => {
        notify?.([{ target, contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
        const pending = [...frames.values()];
        frames.clear();
        for (const frame of pending) frame(0);
      };
      deliverResize(textarea.element, 300, 58);
      deliverResize(wrapper.get(".composer").element, 300, 120);
      deliverResize(textarea.element, 194, 34);
      await nextTick();
      expect(measureReads).toBe(measurementsAfterInput);

      measuredHeight = 34;
      deliverResize(wrapper.get(".composerMainRow").element, 480, 70);
      await nextTick();
      expect(measureReads).toBeGreaterThan(measurementsAfterInput);
      expect(wrapper.get(".composerMainRow").classes()).not.toContain("composerMainRow--expanded");
    } finally {
      wrapper.unmount();
    }
  });
});
