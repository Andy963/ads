import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("chat execute stacking and command collapse", () => {
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

  it("shows only the latest execute block when multiple execute messages are consecutive", async () => {
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

    const left = wrapper.find(".execute-left");
    expect(left.exists()).toBe(true);
    expect(left.find(".prompt-tag").exists()).toBe(true);
    expect(left.find(".execute-cmd").exists()).toBe(true);
    expect(left.find(".execute-cmd").text()).toContain("cmd-3");

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);
    expect(wrapper.find(".execute-stack-count").exists()).toBe(false);

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-3");
    expect(output.text()).not.toContain("out-1");
    expect(output.text()).not.toContain("out-2");

    wrapper.unmount();
  });

  it("shows only the latest execute block even when many execute messages are consecutive", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          { id: "u-1", role: "user", kind: "text", content: "hi" },
          { id: "e-1", role: "system", kind: "execute", content: "out-1", command: "cmd-1" },
          { id: "e-2", role: "system", kind: "execute", content: "out-2", command: "cmd-2" },
          { id: "e-3", role: "system", kind: "execute", content: "out-3", command: "cmd-3" },
          { id: "e-4", role: "system", kind: "execute", content: "out-4", command: "cmd-4" },
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

    const topCmd = wrapper.find(".execute-cmd");
    expect(topCmd.exists()).toBe(true);
    expect(topCmd.text()).toContain("cmd-4");

    expect(wrapper.findAll(".execute-underlay")).toHaveLength(0);

    wrapper.unmount();
  });

  it("does not render underlays even for large stacks", async () => {
    const execs = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return { id: `e-${n}`, role: "system", kind: "execute", content: `out-${n}`, command: `cmd-${n}` } as const;
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

    const topCmd = wrapper.find(".execute-cmd");
    expect(topCmd.exists()).toBe(true);
    expect(topCmd.text()).toContain("cmd-20");

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-20");
    expect(output.text()).not.toContain("out-1");

    wrapper.unmount();
  });

  it("collapses command trees by default and toggles via header and caret", async () => {
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

    expect(wrapper.find(".command-tree").exists()).toBe(false);
    const header = wrapper.find(".command-tree-header");
    expect(header.exists()).toBe(true);
    expect(header.attributes("aria-expanded")).toBe("false");

    const caret = wrapper.find(".command-caret");
    expect(caret.exists()).toBe(true);

    // Clicking the caret should toggle exactly once via bubbling to the header button.
    await caret.trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".command-tree").exists()).toBe(true);
    expect(wrapper.findAll(".command-tree-item")).toHaveLength(4);
    expect(wrapper.find(".command-tree-header").attributes("aria-expanded")).toBe("true");

    await wrapper.find(".command-caret").trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".command-tree").exists()).toBe(false);
    expect(wrapper.find(".command-tree-header").attributes("aria-expanded")).toBe("false");

    // Clicking anywhere on the header row should behave the same.
    await header.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".command-tree").exists()).toBe(true);

    await header.trigger("click");
    await settleUi(wrapper);
    expect(wrapper.find(".command-tree").exists()).toBe(false);

    wrapper.unmount();
  });
});
