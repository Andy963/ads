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
    expect(assistantBody).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.96\)/);
    expect(assistantBody).toMatch(/color:\s*#1e293b/);

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
    expect(css).toMatch(/\.bubble\s*\{[\s\S]*?padding:\s*4px 0 24px/);

    // Assistant bubble does NOT restrict width, padding, or border-radius
    const assistantMatch = css.match(/\.msg\[data-role="assistant"\]\s+\.bubble\s*\{([^}]+)\}/);
    expect(assistantMatch![1]).not.toMatch(/width:/);
    expect(assistantMatch![1]).not.toMatch(/max-width:/);
    expect(assistantMatch![1]).not.toMatch(/padding:/);
    expect(assistantMatch![1]).not.toMatch(/margin:/);
    expect(assistantMatch![1]).not.toMatch(/border-radius:/);
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
