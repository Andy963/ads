import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("chat execute stacking and command collapse", () => {
  it("stacks consecutive execute blocks and shows only the latest content", async () => {
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

    const underlays = wrapper.findAll(".execute-underlay");
    expect(underlays).toHaveLength(2);

    const count = wrapper.find(".execute-stack-count");
    expect(count.exists()).toBe(true);
    expect(count.text()).toContain("3");

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-3");
    expect(output.text()).not.toContain("out-1");
    expect(output.text()).not.toContain("out-2");

    wrapper.unmount();
  });

  it("keeps a stable execute stack structure even for large stacks", async () => {
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
    expect(wrapper.findAll(".execute-underlay")).toHaveLength(2);

    const count = wrapper.find(".execute-stack-count");
    expect(count.exists()).toBe(true);
    expect(count.text()).toContain("20");

    const output = wrapper.find(".execute-output");
    expect(output.exists()).toBe(true);
    expect(output.text()).toContain("out-20");
    expect(output.text()).not.toContain("out-1");

    wrapper.unmount();
  });

  it("collapses command trees longer than 3 by default and toggles via caret", async () => {
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
    const caret = wrapper.find(".command-caret");
    expect(caret.exists()).toBe(true);
    expect(caret.attributes("aria-expanded")).toBe("false");

    await caret.trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".command-tree").exists()).toBe(true);
    expect(wrapper.findAll(".command-tree-item")).toHaveLength(4);
    expect(wrapper.find(".command-caret").attributes("aria-expanded")).toBe("true");

    await wrapper.find(".command-caret").trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".command-tree").exists()).toBe(false);

    wrapper.unmount();
  });
});
