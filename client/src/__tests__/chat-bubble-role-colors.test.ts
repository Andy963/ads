import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";

function messageListProps(messages: unknown[]) {
  return {
    messages,
    copiedMessageId: null,
    formatMessageTs: () => "2026-10-13 11:00",
    liveStepExpanded: false,
    liveStepHasOverflow: false,
    liveStepCanToggleExpanded: false,
    liveStepOutlineItems: [],
    liveStepOutlineHiddenCount: 0,
    liveStepCollapsedTrivialOutline: false,
  } as const;
}

function mountMessageList(messages: unknown[]) {
  return mount(MainChatMessageList, {
    props: messageListProps(messages),
    global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
  });
}

describe("chat bubble role colors and geometry contract", () => {
  it("renders user and assistant messages with semantic data-role attributes and bubble classes", () => {
    const messages = [
      { id: "u-1", role: "user", kind: "text", content: "Write a poem", ts: 100 },
      { id: "a-1", role: "assistant", kind: "text", content: "Roses are red...", ts: 101 },
      { id: "s-1", role: "system", kind: "text", content: "System notice", ts: 102 },
      { id: "e-1", role: "system", kind: "error", content: "Something went wrong", ts: 103 },
      { id: "ex-1", role: "system", kind: "execute", content: "output", command: "ls", ts: 104 },
    ];

    const wrapper = mountMessageList(messages);

    const userMsg = wrapper.find('.msg[data-role="user"][data-id="u-1"]');
    expect(userMsg.exists()).toBe(true);
    expect(userMsg.find(".bubble").exists()).toBe(true);

    const assistantMsg = wrapper.find('.msg[data-role="assistant"][data-id="a-1"]');
    expect(assistantMsg.exists()).toBe(true);
    expect(assistantMsg.find(".bubble").exists()).toBe(true);

    const systemMsg = wrapper.find('.msg[data-role="system"][data-id="s-1"]');
    expect(systemMsg.exists()).toBe(true);
    expect(systemMsg.find(".bubble").exists()).toBe(true);

    const errorMsg = wrapper.find('.msg[data-kind="error"][data-id="e-1"]');
    expect(errorMsg.exists()).toBe(true);
    expect(errorMsg.find(".bubble").exists()).toBe(true);

    const execMsg = wrapper.find('.msg[data-kind="execute"][data-id="ex-1"]');
    expect(execMsg.exists()).toBe(true);
    expect(execMsg.find(".bubble.execute-block").exists()).toBe(true);

    wrapper.unmount();
  });

  it("keeps assistant tints stable when earlier history is prepended", async () => {
    const initialMessages = [
      { id: "u-1", role: "user", kind: "text", content: "Prompt 1", ts: 100 },
      { id: "a-1", role: "assistant", kind: "text", content: "Answer 1", ts: 101 },
      { id: "a-2", role: "assistant", kind: "text", content: "Answer 2", ts: 102 },
      { id: "a-3", role: "assistant", kind: "text", content: "Answer 3", ts: 103 },
    ];

    const wrapper = mountMessageList(initialMessages);
    const existingAssistantIds = ["a-1", "a-2", "a-3"];
    const initialTints = new Map(
      existingAssistantIds.map((id) => [id, wrapper.find(`.msg[data-id="${id}"]`).attributes("data-tint")]),
    );

    await wrapper.setProps({
      messages: [
        { id: "history-user", role: "user", kind: "text", content: "Earlier prompt", ts: 90 },
        { id: "history-assistant", role: "assistant", kind: "text", content: "Earlier answer", ts: 91 },
        ...initialMessages,
      ],
    });

    for (const id of existingAssistantIds) {
      expect(wrapper.find(`.msg[data-id="${id}"]`).attributes("data-tint")).toBe(initialTints.get(id));
    }

    wrapper.unmount();
  });

  it("renders streaming assistant message without disrupting role and bubble hierarchy", () => {
    const messages = [
      { id: "a-stream", role: "assistant", kind: "text", content: "", streaming: true, ts: 200 },
    ];

    const wrapper = mountMessageList(messages);

    const streamingMsg = wrapper.find('.msg[data-role="assistant"][data-id="a-stream"]');
    expect(streamingMsg.exists()).toBe(true);
    const bubble = streamingMsg.find(".bubble");
    expect(bubble.exists()).toBe(true);
    expect(bubble.find(".typing").exists()).toBe(true);

    wrapper.unmount();
  });
});
