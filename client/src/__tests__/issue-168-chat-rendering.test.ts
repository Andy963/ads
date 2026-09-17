import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createChatActions } from "../app/chat";
import { createStreamingActions } from "../app/chatStreaming";
import MarkdownContent from "../components/MarkdownContent.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import type { ChatMessage } from "../components/mainChat/types";
import { readSfc } from "./readSfc";

function message(id: string, content = `message ${id}`): ChatMessage {
  return {
    id,
    role: "assistant",
    kind: "text",
    content,
  };
}

function messageListProps(messages: ChatMessage[]) {
  return {
    messages,
    copiedMessageId: null,
    formatMessageTs: () => "",
    liveStepExpanded: false,
    liveStepHasOverflow: false,
    liveStepCanToggleExpanded: false,
    liveStepOutlineItems: [],
    liveStepOutlineHiddenCount: 0,
    liveStepCollapsedTrivialOutline: false,
  };
}

describe("Issue #168 chat rendering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("loads recent history first and appends earlier rows without shrinking the window", async () => {
    const messages = Array.from({ length: 65 }, (_, index) => message(`m-${index}`));
    const host = document.createElement("div");
    host.className = "chat";
    document.body.appendChild(host);

    const wrapper = mount(MainChatMessageList, {
      props: messageListProps(messages),
      attachTo: host,
    });

    const height = 10;
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(host, "scrollHeight", {
      configurable: true,
      get: () => wrapper.findAll(".msg").length * height + 1,
    });
    host.scrollTop = 40;

    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.find('.msg[data-id="m-35"]').exists()).toBe(true);
    expect(wrapper.find('.msg[data-id="m-34"]').exists()).toBe(false);
    expect(wrapper.find('.msg[data-id="m-64"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="load-earlier-sentinel"]').exists()).toBe(true);
    expect(host.scrollTop).toBe(40);

    host.scrollTop = 0;
    await (wrapper.vm as unknown as { loadEarlierMessages: () => Promise<void> }).loadEarlierMessages();
    expect(wrapper.findAll(".msg")).toHaveLength(50);
    expect(wrapper.find('.msg[data-id="m-15"]').exists()).toBe(true);
    expect(wrapper.find('.msg[data-id="m-14"]').exists()).toBe(false);

    host.scrollTop = 2000;
    await wrapper.setProps({
      messages: [...messages, message("m-65"), message("m-66")],
    });
    await nextTick();
    expect(wrapper.findAll(".msg")).toHaveLength(52);
    expect(wrapper.find('.msg[data-id="m-15"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("keeps the complete message history in application state while rendering a bounded initial window", async () => {
    const chat = createChatActions(createAppContext());
    const stateItems = Array.from({ length: 240 }, (_, index) => ({
      id: `m-${index}`,
      role: "assistant" as const,
      kind: "text" as const,
      content: `message ${index}`,
    }));
    expect(chat.trimChatItems(stateItems)).toHaveLength(240);

    const messages = Array.from({ length: 100 }, (_, index) => message(`m-${index}`));
    const wrapper = mount(MainChatMessageList, {
      props: messageListProps(messages),
    });

    await nextTick();
    expect(messages).toHaveLength(100);
    expect(wrapper.find('[data-total-messages="100"]').exists()).toBe(true);
    expect(wrapper.findAll(".msg")).toHaveLength(30);
    expect(wrapper.find('.msg[data-id="m-70"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("clamps long ordinary code blocks and toggles their full content", async () => {
    const code = Array.from({ length: 31 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const wrapper = mount(MarkdownContent, {
      props: { content: `\`\`\`ts\n${code}\n\`\`\`` },
    });

    const block = wrapper.find(".md-codeblock");
    expect(block.classes()).toContain("md-codeblock--clamped");
    expect(block.attributes("data-expanded")).toBe("false");
    expect(block.find(".md-code-toggle").text()).toBe("Show full code");

    await block.find(".md-code-toggle").trigger("click");

    expect(block.classes()).toContain("md-codeblock--expanded");
    expect(block.classes()).not.toContain("md-codeblock--clamped");
    expect(block.attributes("data-expanded")).toBe("true");
    expect(block.find(".md-code-toggle").text()).toBe("Collapse");

    wrapper.unmount();
  });

  it("batches streaming deltas into one animation-frame commit", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    let callback: FrameRequestCallback | null = null;
    let commitCount = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      callback = cb;
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const messages = ref<ChatItem[]>([]);
      const runtime = {
        messages,
        liveActivity: { head: 0, tail: 0, size: 0, capacity: 10, totalRecorded: 0, buffer: [] },
        liveActivityTtlTimer: null,
      } as unknown as ProjectRuntime;
      const streaming = createStreamingActions({
        liveStepId: "live-step",
        liveActivityId: "live-activity",
        runtimeOrActive: () => runtime,
        setMessages: (items) => {
          commitCount += 1;
          messages.value = items;
        },
        dropEmptyAssistantPlaceholder: () => {},
        isLiveMessageId: (id) => id === "live-step" || id === "live-activity",
        randomId: (prefix) => `${prefix}-1`,
      });

      streaming.upsertStreamingDelta("first ", runtime);
      streaming.upsertStreamingDelta("second", runtime);

      expect(messages.value[0]?.content).toBe("first second");
      expect(commitCount).toBe(0);
      expect(callback).not.toBeNull();

      callback?.(0);

      expect(commitCount).toBe(1);
      expect(messages.value[0]?.content).toBe("first second");
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it("keeps real row geometry for browser-native history anchoring", async () => {
    const source = await readSfc("../components/MainChatMessageList.vue", import.meta.url);
    expect(source).not.toMatch(/content-visibility:\s*auto\s*;/);
    expect(source).not.toMatch(/contain-intrinsic-size:/);
  });
});
