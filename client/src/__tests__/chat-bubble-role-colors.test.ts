import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { readSfc } from "./readSfc";

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
  it("defines distinct role-specific color selectors for user and assistant bubbles", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    const userMatch = css.match(/\.msg\[data-role="user"\]\s+\.bubble\s*\{([^}]+)\}/);
    expect(userMatch).not.toBeNull();
    const userBody = userMatch![1];
    expect(userBody).toMatch(/background:\s*rgba\(37,\s*99,\s*235,\s*0\.1\)/);
    expect(userBody).toMatch(/color:\s*#0f172a/);

    const assistantMatch = css.match(/\.msg\[data-role="assistant"\]\s+\.bubble\s*\{([^}]+)\}/);
    expect(assistantMatch).not.toBeNull();
    const assistantBody = assistantMatch![1];
    expect(assistantBody).toMatch(/background:\s*#FAF5FF/i);
    expect(assistantBody).toMatch(/color:\s*#581c87/i);
    expect(assistantBody).toMatch(/padding:\s*10px 16px 24px/);
    expect(assistantBody).toMatch(/border-radius:\s*18px/);
    expect(assistantBody).toMatch(/border:\s*1px solid rgba\(192,\s*132,\s*252,\s*0\.45\)/);
    expect(assistantBody).toMatch(/box-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.04\)/);

    // Distinct color variants across the palette
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\[data-tint="pink"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#FDF2F8;[\s\S]*?border:\s*1px solid rgba\(244,\s*114,\s*182,\s*0\.4\);[\s\S]*?color:\s*#831843;/i);
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\[data-tint="blue"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#F0F9FF;[\s\S]*?border:\s*1px solid rgba\(56,\s*189,\s*248,\s*0\.45\);[\s\S]*?color:\s*#0c4a6e;/i);
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\[data-tint="purple"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#FAF5FF;[\s\S]*?border:\s*1px solid rgba\(192,\s*132,\s*252,\s*0\.45\);[\s\S]*?color:\s*#581c87;/i);
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\[data-tint="green"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#F0FDF4;[\s\S]*?border:\s*1px solid rgba\(74,\s*222,\s*128,\s*0\.45\);[\s\S]*?color:\s*#14532d;/i);
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\[data-tint="amber"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#FFFBEB;[\s\S]*?border:\s*1px solid rgba\(251,\s*191,\s*36,\s*0\.45\);[\s\S]*?color:\s*#78350f;/i);

    // User and assistant color treatments must be distinct
    expect(userBody).not.toEqual(assistantBody);
  });

  it("guards the geometry contract: user bubble is narrower right-aligned and assistant is full-width", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    // Base .msg is full-width and left-aligned
    expect(css).toMatch(/\.msg\s*\{[\s\S]*?justify-content:\s*flex-start/);
    expect(css).toMatch(/\.msg\s*\{[\s\S]*?width:\s*100%/);

    // User row aligns right
    expect(css).toMatch(/\.msg\[data-role="user"\]\s*\{[\s\S]*?justify-content:\s*flex-end/);

    // User bubble has constrained width
    const userMatch = css.match(/\.msg\[data-role="user"\]\s+\.bubble\s*\{([^}]+)\}/);
    expect(userMatch![1]).toMatch(/width:\s*fit-content/);
    expect(userMatch![1]).toMatch(/max-width:\s*78%/);

    // Base .bubble is full-width
    expect(css).toMatch(/\.bubble\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/\.bubble\s*\{[\s\S]*?max-width:\s*100%/);

    // Assistant bubble stays full-width but provides protective padding and rounded corners
    const assistantMatch = css.match(/\.msg\[data-role="assistant"\]\s+\.bubble\s*\{([^}]+)\}/);
    expect(assistantMatch![1]).toMatch(/width:\s*100%/);
    expect(assistantMatch![1]).toMatch(/max-width:\s*100%/);
    expect(assistantMatch![1]).toMatch(/padding:\s*10px 16px 24px/);
    expect(assistantMatch![1]).toMatch(/border-radius:\s*18px/);
    expect(assistantMatch![1]).toMatch(/box-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.04\)/);

    // Assistant actions align with padding
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\s+\.msgActions\s*\{[^}]*left:\s*16px/);

    // Assistant markdown text inherits tint color
    expect(css).toMatch(/\.msg\[data-role="assistant"\]\s+\.bubble\s+:deep\(\.md\)\s*\{[\s\S]*?color:\s*inherit;/);

    // User bubble adopts matching 18px border-radius on mobile full-width rows
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.msg\[data-role="user"\]\s+\.bubble\s*\{[\s\S]*?border-radius:\s*18px\s*;/);

    // Live-step progress indicator stays transparent and unboxed
    expect(css).toMatch(/\.msg\[data-id="live-step"\]\s+\.bubble\s*\{[\s\S]*?background:\s*transparent;/);
    expect(css).toMatch(/\.msg\[data-id="live-step"\]\s+\.bubble\s*\{[\s\S]*?border:\s*none;/);
    expect(css).toMatch(/\.msg\[data-id="live-step"\]\s+\.bubble\s*\{[\s\S]*?box-shadow:\s*none;/);
    expect(css).toMatch(/\.msg\[data-id="live-step"\]\s+\.bubble\s+:deep\(\.md\)\s*\{[\s\S]*?color:\s*var\(--github-text\);/);
  });

  it("preserves independent styling for system, error, and execute bubbles", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    // System bubble retains border and background
    expect(css).toMatch(/\.msg\[data-role="system"\]\s+\.bubble\s*\{[\s\S]*?background:\s*rgba\(246,\s*248,\s*250,\s*0\.96\)/);

    // Error bubble retains distinct alert background and color
    expect(css).toMatch(/\.msg\[data-kind="error"\]\s+\.bubble\s*\{[\s\S]*?background:\s*rgba\(255,\s*247,\s*237,\s*0\.96\)/);
    expect(css).toMatch(/\.msg\[data-kind="error"\]\s+\.bubble\s*\{[\s\S]*?color:\s*#7c2d12/);

    // Execute block bubble retains code background
    expect(css).toMatch(/\.msg\[data-kind="execute"\]\s+\.bubble\s*\{[\s\S]*?background:\s*#f8fafc/);
  });

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
