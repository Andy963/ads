import { describe, expect, it } from "vitest";
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import { createStreamingActions } from "../app/chatStreaming";
import type { ChatItem, ProjectRuntime } from "../app/controller";

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

describe("thought card persistence", () => {
  it("converts completed live-step reasoning into a persistent thought card on clearStepLive", () => {
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
      liveStepId: "live-step",
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

    expect(messages.value.find((m) => m.id === "live-step")).toBeUndefined();
    const thought = messages.value.find((m) => m.kind === "thought");
    expect(thought).toBeDefined();
    expect(thought?.content).toBe("Diagnosing repository layout and planning next action...");
    expect(thought?.role).toBe("assistant");
    expect(thought?.streaming).toBe(false);

    // Thought card is positioned before the assistant response
    const thoughtIndex = messages.value.findIndex((m) => m.kind === "thought");
    const assistantIndex = messages.value.findIndex((m) => m.id === "a-1");
    expect(thoughtIndex).toBeLessThan(assistantIndex);
  });

  it("keeps thought blocks internal and does not render standalone thought cards in MainChat", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "check status" },
          { id: "th-1", role: "assistant", kind: "thought", content: "[analysis] Need to check git diff before making changes\nStep 2: run tests" },
          { id: "a-1", role: "assistant", kind: "text", content: "All checks passed." },
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
