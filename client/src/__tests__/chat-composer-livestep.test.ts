import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref, type Ref } from "vue";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import MainChat from "../components/MainChat.vue";
import { createExecuteActions } from "../app/chatExecute";
import { createAppContext } from "../app/controller";
import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createStreamingActions } from "../app/chatStreaming";
import { loadMarkdown } from "../lib/markdown/loader";

// Preload the lazy markdown pipeline so outline assertions stay synchronous.
beforeAll(() => loadMarkdown().then(() => undefined));

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

function mountMainChat(messages: Array<Record<string, unknown>>) {
  return mount(MainChat, {
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
}

const ComposerHost = defineComponent({
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
  const wrapper = mount(ComposerHost, { attachTo: document.body });
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

/**
 * Adversarial stress test for the iOS-only composer crash
 * ("Maximum call stack size exceeded" / patchClass(el=null) at the wrap
 * boundary). Hammers MainChatComposerPanel with the exact concurrent signals
 * seen on device: per-keystroke draft echo, composerExpanded flips (via "\n"),
 * busy flips (stop/send button swap), runningTaskCount badge toggles,
 * connection status bar toggles, queue/attachment bar toggles — batched into
 * the same flush to reproduce the patch collision.
 *
 * jsdom has no layout engine, so the soft-wrap trigger is emulated by newlines
 * (autosizeTextarea returns true whenever the value contains "\n").
 */
type StressHostProps = {
  busy: Ref<boolean>;
  runningTaskCount: Ref<number>;
  connectionStatusMessage: Ref<string | null>;
  queuedCount: Ref<number>;
  pendingImages: Ref<Array<{ data: string }>>;
};

const StressHost = defineComponent({
  components: { MainChatComposerPanel },
  setup() {
    const draft = ref("");
    const busy = ref(false);
    const runningTaskCount = ref(0);
    const connectionStatusMessage = ref<string | null>(null);
    const queuedCount = ref(0);
    const pendingImages = ref<Array<{ data: string }>>([]);
    const sent = ref<string[]>([]);
    return {
      draft,
      busy,
      runningTaskCount,
      connectionStatusMessage,
      queuedCount,
      pendingImages,
      sent,
    };
  },
  template: `
    <div class="detail"><div class="chat"></div>
    <MainChatComposerPanel
      v-model:draft="draft"
      :queued-prompts="Array.from({ length: queuedCount }, (_, i) => ({ id: 'q' + i, text: 'queued ' + i, imagesCount: 0 }))"
      :pending-images="pendingImages"
      :connected="true"
      :busy="busy"
      :running-task-count="runningTaskCount"
      :connection-status-kind="connectionStatusMessage ? 'progress' : null"
      :connection-status-message="connectionStatusMessage"
      @send="sent.push($event)"
    />
    </div>
  `,
});

function typeText(el: HTMLTextAreaElement, text: string): void {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("composer wrap stress (iOS crash repro)", () => {
  it("survives concurrent draft/busy/status/queue churn across wrap boundaries", async () => {
    const errors: Array<{ message: string }> = [];
    const wrapper = mount(StressHost, {
      global: {
        config: {
          errorHandler: (err) => {
            errors.push({ message: err instanceof Error ? err.message : String(err) });
          },
        },
      },
      attachTo: document.body,
    });
    try {
      const textarea = wrapper.find("textarea");
      expect(textarea.exists()).toBe(true);
      const el = textarea.element as HTMLTextAreaElement;
      const vm = wrapper.vm as unknown as StressHostProps & { draft: string };

      let draft = "";
      for (let round = 0; round < 300; round += 1) {
        // Type a few characters per round; cross a "wrap" boundary every ~10 chars.
        for (let i = 0; i < 4; i += 1) {
          draft += round % 3 === 0 && i === 2 ? "\n" : "x";
          typeText(el, draft);
        }
        // Batch the signals that arrive over ws while the user types.
        vm.busy = !vm.busy;
        vm.runningTaskCount = vm.busy ? (round % 3) + 1 : 0;
        vm.connectionStatusMessage = round % 7 === 0 ? (vm.connectionStatusMessage ? null : "重连中…") : vm.connectionStatusMessage;
        vm.queuedCount = vm.busy ? round % 4 : 0;
        vm.pendingImages = round % 11 === 0 ? [{ data: "data:image/png;base64,AAAA" }] : vm.pendingImages;
        if (round % 11 === 5) vm.pendingImages = [];
        if (draft.length > 400) draft = draft.slice(-120);
        await nextTick();
        // Type again immediately after the flush, while post-watchers run.
        draft += "y";
        typeText(el, draft);
        await nextTick();
      }
      expect(errors).toEqual([]);
    } finally {
      wrapper.unmount();
    }
  }, 60000);
});

describe("ingestCommand deduping", () => {
  it("dedups by (id, command) so a reused id still counts distinct commands", () => {
    const rt = { seenCommandIds: new Set<string>() } as any;
    const pushRecentCommand = vi.fn();

    const actions = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: () => {},
      pushRecentCommand,
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
      findFirstLiveIndex: () => -1,
      findLastLiveIndex: () => -1,
    });

    actions.ingestCommand("cmd-1", rt, "c-1");
    actions.ingestCommand("cmd-1", rt, "c-1");
    actions.ingestCommand("cmd-2", rt, "c-1");
    actions.ingestCommand("cmd-2", rt, "c-1");

    expect(pushRecentCommand.mock.calls.map((c) => c[0])).toEqual(["cmd-1", "cmd-2"]);
  });

  it("does not dedup when id is missing", () => {
    const rt = { seenCommandIds: new Set<string>() } as any;
    const pushRecentCommand = vi.fn();

    const actions = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: () => {},
      pushRecentCommand,
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
      findFirstLiveIndex: () => -1,
      findLastLiveIndex: () => -1,
    });

    actions.ingestCommand("cmd", rt, null);
    actions.ingestCommand("cmd", rt, null);

    expect(pushRecentCommand).toHaveBeenCalledTimes(2);
  });
});

describe("live-step outline preview", () => {
  it("shows extracted outline when collapsed and hides it when expanded", async () => {
    const wrapper = mountMainChat([
      { id: "live-step", role: "assistant", kind: "text", content: "**Title A**\n\nBody", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
    ]);

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
    expect(toggle.text()).toContain("展开");

    await toggle.trigger("click");
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".liveStepOutline").exists()).toBe(false);
    expect(wrapper.find(".liveStepToggleBtn").text()).toContain("收起");

    wrapper.unmount();
  });

  it("hides expand toggle when there is only one title and no meaningful body", async () => {
    const wrapper = mountMainChat([
      { id: "live-step", role: "assistant", kind: "text", content: "**Title A**", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
    ]);

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

describe("live-step reasoning scroll style", () => {
  it("renders the live-step card with its scrollable markdown body", async () => {
    const wrapper = mountMainChat([
      { id: "live-step", role: "assistant", kind: "text", content: "line1\nline2\nline3\nline4\nline5\nline6", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
    ]);

    const live = wrapper.find('.msg[data-id="live-step"]');
    expect(live.exists()).toBe(true);
    expect(live.find(".bubble").exists()).toBe(true);
    expect(live.find(".liveStepBody").exists()).toBe(true);
    expect(live.find(".md").exists()).toBe(true);

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

    const wrapper = mountMainChat([
      { id: "live-step", role: "assistant", kind: "text", content: "start", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
    ]);

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

  it("keeps auto-scrolling when the live-step content is trimmed to a fixed length", async () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as unknown as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof globalThis.cancelAnimationFrame;

    const wrapper = mountMainChat([
      { id: "live-step", role: "assistant", kind: "text", content: "aaaaa", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "final answer" },
    ]);

    await wrapper.vm.$nextTick();

    const md = wrapper.find('.msg[data-id="live-step"] .md').element as HTMLElement;
    Object.defineProperty(md, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(md, "clientHeight", { configurable: true, get: () => 100 });

    md.scrollTop = 0;
    await wrapper.setProps({
      messages: [
        { id: "live-step", role: "assistant", kind: "text", content: "bbbbb", streaming: true }, // same length, different content
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

function createLegacyChatHarness(initial: ChatItem[]) {
  const ctx = createAppContext();
  const chat = createChatActions(ctx);
  const rt: ProjectRuntime = ctx.activeRuntime.value;
  rt.messages.value = initial;
  return { rt, chat };
}

describe("legacy live-step compatibility (thinking placeholder)", () => {
  it("keeps an already-persisted live-step card readable", () => {
    const { rt, chat } = createLegacyChatHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "live-step", role: "assistant", kind: "text", content: "Legacy progress", streaming: false, ts: 2 },
    ]);

    chat.upsertStreamingDelta("All checks pass.", rt);
    chat.clearStepLive(rt);

    expect(rt.messages.value.find((message) => message.id === "live-step")?.content).toBe("Legacy progress");
    expect(rt.messages.value.some((message) => message.id === "live-activity")).toBe(false);
    expect(rt.messages.value.some((message) => message.kind === "thought")).toBe(false);
    expect(rt.messages.value.some((message) => message.content === "All checks pass.")).toBe(true);
  });
});

describe("visible step cleanup (thought card persistence)", () => {
  it("preserves a legacy live step without creating a thought card", () => {
    const messages = ref<ChatItem[]>([
      { id: "u-1", role: "user", kind: "text", content: "hello" },
      { id: "live-step", role: "assistant", kind: "text", content: "Diagnosing repository layout and planning next action...", streaming: true },
      { id: "a-1", role: "assistant", kind: "text", content: "Here is the result", streaming: true },
    ]);

    const fakeRt: ProjectRuntime = {
      messages,
      liveActivity: { head: 0, tail: 0, size: 0, capacity: 10, totalRecorded: 0, buffer: [] },
      liveActivityTtlTimer: null,
    } as unknown as ProjectRuntime;

    const streaming = createStreamingActions({
      liveActivityId: "live-activity",
      runtimeOrActive: () => fakeRt,
      setMessages: (items) => {
        messages.value = items;
      },
      dropEmptyAssistantPlaceholder: () => {},
      findLastLiveIndex: (items) => items.findIndex((m) => m.id === "live-step"),
      isLiveMessageId: (id) => id === "live-step" || id === "live-activity",
      randomId: (prefix) => `${prefix}-1`,
    });

    streaming.clearStepLive(fakeRt);

    expect(messages.value.find((m) => m.id === "live-step")?.content).toBe("Diagnosing repository layout and planning next action...");
    expect(messages.value.filter((m) => m.kind === "thought")).toHaveLength(0);
    expect(messages.value.find((m) => m.id === "a-1")?.content).toBe("Here is the result");
  });

  it("keeps thought blocks internal and does not render standalone thought cards in MainChat", async () => {
    const wrapper = mountMainChat([
      { id: "u-1", role: "user", kind: "text", content: "check status" },
      { id: "th-1", role: "assistant", kind: "thought", content: "[analysis] Need to check git diff before making changes\nStep 2: run tests" },
      { id: "a-1", role: "assistant", kind: "text", content: "All checks passed." },
    ]);

    await wrapper.vm.$nextTick();

    // Thought blocks are internal and must NOT render as standalone cards
    expect(wrapper.find(".thoughtCard").exists()).toBe(false);
    expect(wrapper.findAll('.msg[data-kind="thought"]')).toHaveLength(0);
    // Visible blocks are user prompt and assistant explanation
    const renderedMsgs = wrapper.findAll(".msg");
    expect(renderedMsgs).toHaveLength(2);
    expect(renderedMsgs[0]!.attributes("data-role")).toBe("user");
    expect(renderedMsgs[1]!.attributes("data-role")).toBe("assistant");

    wrapper.unmount();
  });
});
