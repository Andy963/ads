import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatMessageList from "../components/MainChatMessageList.vue";
import { turnFailureCardId } from "../lib/turnFailure";
import { readSfc } from "./readSfc";

function messageListProps(messages: unknown[]) {
  return {
    messages,
    copiedMessageId: null,
    formatMessageTs: () => "2026-09-29 15:42",
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

function domOrder(row: Element, selectors: string[]): number[] {
  return selectors.map((selector) => {
    const el = row.querySelector(selector);
    expect(el, `expected ${selector} to exist`).not.toBeNull();
    return Array.prototype.indexOf.call(row.children, el);
  });
}

describe("message action row order", () => {
  it("renders the timestamp before the copy button", () => {
    const wrapper = mountMessageList([
      { id: "u-1", role: "user", kind: "text", content: "hello", ts: 1 },
    ]);

    const row = wrapper.get('.msg[data-role="user"] .msgActions').element;
    const [timeIndex, copyIndex] = domOrder(row, [".msgTime", ".msgCopyBtn"]);
    expect(timeIndex).toBeLessThan(copyIndex);

    wrapper.unmount();
  });

  it("keeps the retry button as the first interactive control while the timestamp leads the row", () => {
    const wrapper = mountMessageList([
      { id: "u-2", role: "user", kind: "text", content: "hello", ts: 1 },
      { id: turnFailureCardId("u-2"), role: "system", kind: "error", content: "turn failed", ts: 2 },
    ]);

    const row = wrapper.get('.msg[data-role="user"] .msgActions').element;
    const [timeIndex, retryIndex, copyIndex] = domOrder(row, [
      ".msgTime",
      '[data-testid="inline-turn-retry"]',
      ".msgCopyBtn",
    ]);
    expect(timeIndex).toBeLessThan(retryIndex);
    expect(timeIndex).toBeLessThan(copyIndex);

    const buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons[0]).toBe(row.querySelector('[data-testid="inline-turn-retry"]'));
    expect(retryIndex).toBeLessThan(copyIndex);

    wrapper.unmount();
  });

  it("renders the assistant timestamp before the copy button", () => {
    const wrapper = mountMessageList([
      { id: "a-1", role: "assistant", kind: "text", content: "answer", ts: 1 },
    ]);

    const row = wrapper.get('.msg[data-role="assistant"] .msgActions').element;
    const [timeIndex, copyIndex] = domOrder(row, [".msgTime", ".msgCopyBtn"]);
    expect(timeIndex).toBeLessThan(copyIndex);

    wrapper.unmount();
  });

  it("left-aligns the user action row in the stylesheet", async () => {
    const css = await readSfc("../components/MainChatMessageList.vue", import.meta.url);

    expect(css).toMatch(
      /\.msg\[data-role="user"\]\s+\.msgActions\s*\{[^}]*justify-content:\s*flex-start\s*;/,
    );
    expect(css).not.toMatch(
      /\.msg\[data-role="user"\]\s+\.msgActions\s*\{[^}]*justify-content:\s*flex-end\s*;/,
    );
  });
});
