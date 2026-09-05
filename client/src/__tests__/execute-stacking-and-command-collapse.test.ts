import { describe, expect, it } from "vitest";
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

  it("emits copy events from execute blocks", async () => {
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
    await wrapper.find(".executeCopyBtn").trigger("click");

    expect(wrapper.emitted("copyMessage")?.[0]?.[0]).toMatchObject({
      id: "e-1",
      kind: "execute",
      command: "cmd-1",
      content: "out-1",
    });

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

  it("expands replayed execute blocks with retained full output", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [
          {
            id: "e-1",
            role: "system",
            kind: "execute",
            content: "line 1\nline 2\nline 3",
            fullContent: "line 1\nline 2\nline 3\nline 4\nline 5",
            command: "npm test",
            hiddenLineCount: 2,
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

    expect(wrapper.find(".execute-output").text()).not.toContain("line 5");
    const toggle = wrapper.find(".execute-more--button");
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("还有 2 行");

    await toggle.trigger("click");

    expect(wrapper.find(".execute-output").text()).toContain("line 5");
    expect(wrapper.find(".execute-more--button").text()).toContain("收起输出");

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

  it("shows all finalized execute history blocks in arrival order", async () => {
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
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.find(".execute-cmd").text())).toEqual(["cmd-1", "cmd-2", "cmd-3"]);
    expect(blocks.map((block) => block.find(".execute-output").text())).toEqual(["out-1", "out-2", "out-3"]);

    wrapper.unmount();
  });

  it("shows every transient execute preview when multiple previews are consecutive", async () => {
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
    expect(blocks).toHaveLength(3);

    const left = wrapper.find(".execute-left");
    expect(left.exists()).toBe(true);
    expect(left.find(".prompt-tag").exists()).toBe(true);
    expect(left.find(".execute-cmd").exists()).toBe(true);
    expect(left.find(".execute-cmd").text()).toContain("cmd-1");

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-stack-count").exists()).toBe(false);

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-1");
    expect(wrapper.findAll(".execute-output").map((node) => node.text())).toEqual(["out-1", "out-2", "out-3"]);

    wrapper.unmount();
  });

  it("shows every transient execute preview even when many previews are consecutive", async () => {
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

    expect(wrapper.findAll(".execute-block")).toHaveLength(4);

    const commands = wrapper.findAll(".execute-cmd");
    expect(commands).toHaveLength(4);
    expect(commands.map((node) => node.text())).toEqual(["cmd-1", "cmd-2", "cmd-3", "cmd-4"]);

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });

  it("renders all blocks without underlays even for large stacks", async () => {
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

    expect(wrapper.findAll(".execute-block")).toHaveLength(20);
    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-stack-count").exists()).toBe(false);

    const commands = wrapper.findAll(".execute-cmd");
    expect(commands).toHaveLength(20);
    expect(commands.at(-1)?.text()).toContain("cmd-20");

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-1");
    expect(wrapper.findAll(".execute-output").at(-1)?.text()).toContain("out-20");

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
