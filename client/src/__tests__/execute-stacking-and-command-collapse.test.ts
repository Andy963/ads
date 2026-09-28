import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("chat execute stacking and command collapse", () => {
  it("renders the live process card before an arrival-ordered execute block", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "run checks" },
          { id: "exec:1", role: "system", kind: "execute", content: "output", command: "npm test", streaming: true },
          { id: "live-step", role: "assistant", kind: "text", content: "[tool] Inspecting", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    const ids = wrapper.findAll(".msg").map((item) => item.attributes("data-id"));
    expect(ids).toEqual(["u-1", "live-step", "exec:1", "a-1"]);

    wrapper.unmount();
  });

  it("renders the command without any copy button or output", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "e-1", role: "system", kind: "execute", content: "out-1", command: "cmd-1" }],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);
    expect(wrapper.get(".execute-cmd").text()).toBe("cmd-1");
    expect(wrapper.get(".execute-cmd").attributes("title")).toBe("cmd-1");
    expect(wrapper.findAll(".execute-cmd-copy")).toHaveLength(1);
    expect(wrapper.get(".execute-block").findAll("button")).toHaveLength(0);
    expect(wrapper.find(".execute-output").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("out-1");
    expect(wrapper.emitted("copyMessage")).toBeUndefined();

    wrapper.unmount();
  });

  it("renders retry count badge on coalesced transient errors", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "transient-retry-notice",
            role: "system",
            kind: "error",
            content: "We're currently experiencing high demand, which may cause temporary errors.",
            retryCount: 3,
            transient: true,
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.find(".retryBadge").text()).toBe("x3");

    wrapper.unmount();
  });

  it("detects clipped text from its scroll width even after the command completes", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "e-done", role: "system", kind: "execute", content: "out", command: "completed long command" },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    const commands = wrapper.findAll(".execute-cmd");
    expect(commands).toHaveLength(1);
    expect(wrapper.get(".execute-block").classes()).not.toContain("execute-block--running");
    Object.defineProperty(commands[0].element, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(commands[0].get(".execute-cmd-copy").element, "scrollWidth", { configurable: true, value: 200 });
    vi.spyOn(commands[0].get(".execute-cmd-copy").element, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);

    await settleUi(wrapper);

    expect(commands[0].classes()).toContain("execute-cmd--overflowing");
    expect(wrapper.findAll(".execute-cmd-copy")).toHaveLength(2);

    wrapper.unmount();
  });

  it("does not mark a completed command that fits", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "e-done", role: "system", kind: "execute", content: "out", command: "short" },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    const commands = wrapper.findAll(".execute-cmd");
    Object.defineProperty(commands[0].element, "clientWidth", { configurable: true, value: 100 });
    vi.spyOn(commands[0].get(".execute-cmd-copy").element, "getBoundingClientRect").mockReturnValue({
      width: 80,
    } as DOMRect);

    await settleUi(wrapper);

    expect(commands[0].classes()).not.toContain("execute-cmd--overflowing");

    wrapper.unmount();
  });

  it("does not remeasure the running command while assistant text streams", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          { id: "e-long", role: "system", kind: "execute", content: "out", command: "long command", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "partial", streaming: true },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    const command = wrapper.get(".execute-cmd");
    Object.defineProperty(command.element, "clientWidth", { configurable: true, value: 100 });
    const measure = vi
      .spyOn(command.get(".execute-cmd-copy").element, "getBoundingClientRect")
      .mockReturnValue({ width: 200 } as DOMRect);

    await settleUi(wrapper);
    const callsAfterMount = measure.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    await wrapper.setProps({
      messages: [
        { id: "e-long", role: "system", kind: "execute", content: "out", command: "long command", streaming: true },
        { id: "a-1", role: "assistant", kind: "text", content: "partial answer with more tokens", streaming: true },
      ],
    });
    await settleUi(wrapper);

    expect(measure.mock.calls.length).toBe(callsAfterMount);
    expect(command.classes()).toContain("execute-cmd--overflowing");

    wrapper.unmount();
  });

  it("preserves the scrolling track on completion but replaces it when the command changes", async () => {
    const message = { id: "exec:latest", role: "system" as const, kind: "execute" as const, content: "", command: "first long command", streaming: true };
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [message],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      attachTo: document.body,
    });
    try {
      const command = wrapper.get(".execute-cmd");
      Object.defineProperty(command.element, "clientWidth", { configurable: true, value: 100 });
      vi.spyOn(command.get(".execute-cmd-copy").element, "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);
      await settleUi(wrapper);
      const runningTrack = command.get(".execute-cmd-track").element;
      expect(command.classes()).toContain("execute-cmd--overflowing");

      await wrapper.setProps({ messages: [{ ...message, streaming: false }] });
      await settleUi(wrapper);
      expect(command.get(".execute-cmd-track").element).toBe(runningTrack);
      expect(command.classes()).toContain("execute-cmd--overflowing");

      await wrapper.setProps({ messages: [{ ...message, command: "next long command" }] });
      expect(command.get(".execute-cmd-track").element).not.toBe(runningTrack);
      expect(command.attributes("title")).toBe("next long command");
    } finally {
      wrapper.unmount();
    }
  });

  it("never renders legacy full output or output expansion controls", async () => {
    const fullOutput = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "e-1",
            role: "system",
            kind: "execute",
            content: "line 1\nline 2\nline 3",
            fullContent: fullOutput,
            command: "npm test",
            hiddenLineCount: 2497,
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.get(".execute-cmd").text()).toBe("npm test");
    expect(wrapper.find(".execute-output").exists()).toBe(false);
    expect(wrapper.find(".execute-more").exists()).toBe(false);
    expect(wrapper.find(".executeCopyBtn").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("line 1");
    expect(wrapper.text()).not.toContain("2497");

    wrapper.unmount();
  });

  it("keeps output hidden through running and completed command updates", async () => {
    const longOutput = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join("\n");
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "e-long",
            role: "system",
            kind: "execute",
            content: longOutput,
            command: "git log",
            streaming: true,
          },
        ],
        copiedMessageId: null,
        formatMessageTs: () => "",
        liveStepExpanded: false,
        liveStepHasOverflow: false,
        liveStepCanToggleExpanded: false,
        liveStepOutlineItems: [],
        liveStepOutlineHiddenCount: 0,
        liveStepCollapsedTrivialOutline: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.get(".execute-cmd").text()).toBe("git log");
    expect(wrapper.find(".executeLoadingDots").exists()).toBe(true);
    expect(wrapper.find(".execute-output").exists()).toBe(false);
    expect(wrapper.find(".execute-more").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("line 1");

    await wrapper.setProps({ messages: [{ id: "e-long", role: "system", kind: "execute", content: `${longOutput}\nlast line`, command: "git log", streaming: false }] });
    await settleUi(wrapper);
    expect(wrapper.get(".execute-cmd").text()).toBe("git log");
    expect(wrapper.find(".executeLoadingDots").exists()).toBe(false);
    expect(wrapper.find(".execute-output").exists()).toBe(false);
    expect(wrapper.find(".execute-more").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("last line");

    wrapper.unmount();
  });

  it("renders no execute stack when there are no execute messages", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.findAll(".execute-block")).toHaveLength(0);
    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });

  it("renders a single execute block without underlays when there is only one execute message", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "e-1", role: "system", kind: "execute", content: "out-1", command: "cmd-1" },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.findAll(".execute-block")).toHaveLength(1);
    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-cmd").text()).toContain("cmd-1");

    wrapper.unmount();
  });

  it("keeps only the latest finalized command visible", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "e-1", role: "system", kind: "execute", content: "out-1", command: "cmd-1" },
          { id: "e-2", role: "system", kind: "execute", content: "out-2", command: "cmd-2" },
          { id: "e-3", role: "system", kind: "execute", content: "out-3", command: "cmd-3" },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    const blocks = wrapper.findAll(".execute-block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].find(".execute-cmd").text()).toBe("cmd-3");
    expect(wrapper.findAll(".execute-output")).toHaveLength(0);
    expect(blocks.every((block) => !block.text().includes("out-"))).toBe(true);

    wrapper.unmount();
  });

  it("keeps only the latest streaming command when previews are consecutive", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "exec:1", role: "system", kind: "execute", content: "out-1", command: "cmd-1", streaming: true },
          { id: "exec:2", role: "system", kind: "execute", content: "out-2", command: "cmd-2", streaming: true },
          { id: "exec:3", role: "system", kind: "execute", content: "out-3", command: "cmd-3", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    const blocks = wrapper.findAll(".execute-block");
    expect(blocks).toHaveLength(1);

    const left = wrapper.find(".execute-left");
    expect(left.exists()).toBe(true);
    expect(left.find(".prompt-tag").exists()).toBe(true);
    expect(left.find(".execute-cmd").exists()).toBe(true);
    expect(left.find(".execute-cmd").text()).toContain("cmd-3");

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-stack-count").exists()).toBe(false);

    expect(wrapper.findAll(".execute-output")).toHaveLength(0);
    expect(wrapper.findAll(".execute-cmd").map((node) => node.text())).toEqual(["cmd-3"]);
    expect(wrapper.text()).not.toContain("out-1");

    wrapper.unmount();
  });

  it("keeps only the latest streaming command when many previews are consecutive", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "exec:1", role: "system", kind: "execute", content: "out-1", command: "cmd-1", streaming: true },
          { id: "exec:2", role: "system", kind: "execute", content: "out-2", command: "cmd-2", streaming: true },
          { id: "exec:3", role: "system", kind: "execute", content: "out-3", command: "cmd-3", streaming: true },
          { id: "exec:4", role: "system", kind: "execute", content: "out-4", command: "cmd-4", streaming: true },
          { id: "a-1", role: "assistant", kind: "text", content: "done" },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.findAll(".execute-block")).toHaveLength(1);

    const commands = wrapper.findAll(".execute-cmd");
    expect(commands).toHaveLength(1);
    expect(commands.map((node) => node.text())).toEqual(["cmd-4"]);

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });

  it("renders a single block without underlays even for large stacks", async () => {
    const execs = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return {
        id: `exec:${n}`,
        role: "system",
        kind: "execute",
        content: `out-${n}`,
        command: `cmd-${n}`,
        streaming: true,
      } as const;
    });

    const wrapper = mount(MainChat, {
      props: {
        messages: [{ id: "u-1", role: "user", kind: "text", content: "hi" }, ...execs, { id: "a-1", role: "assistant", kind: "text", content: "done" }],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.findAll(".execute-block")).toHaveLength(1);
    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-stack-count").exists()).toBe(false);

    const commands = wrapper.findAll(".execute-cmd");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.text()).toContain("cmd-20");

    expect(wrapper.findAll(".execute-output")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("out-1");
    expect(wrapper.text()).not.toContain("out-20");

    wrapper.unmount();
  });

  it("does not render finalized command trees in the chat UI", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          {
            id: "c-1",
            role: "system",
            kind: "command",
            content: ["$ one", "$ two", "$ three", "$ four"].join("\n"),
          },
        ],
        queuedPrompts: [],
        pendingImages: [],
        connected: true,
        busy: false,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await settleUi(wrapper);

    expect(wrapper.find(".command-block").exists()).toBe(false);
    expect(wrapper.find(".command-tree-header").exists()).toBe(false);
    expect(wrapper.find(".command-tree").exists()).toBe(false);

    wrapper.unmount();
  });
});
