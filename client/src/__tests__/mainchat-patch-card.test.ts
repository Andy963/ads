import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("MainChat patch card", () => {
  it("renders one patch row per file and expands inline", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          {
            id: "patch-1",
            role: "system",
            kind: "patch",
            content: "diff --git a/tests/a.ts b/tests/a.ts\n+hello\n",
            patch: {
              files: [{ path: "tests/agents/claudeCliAdapter.test.ts", added: 118, removed: 2 }],
              diff: "diff --git a/tests/agents/claudeCliAdapter.test.ts b/tests/agents/claudeCliAdapter.test.ts\n+hello\n",
              truncated: false,
            },
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

    expect(wrapper.find(".patchCard").exists()).toBe(true);
    expect(wrapper.findAll(".patchCardRow")).toHaveLength(1);
    expect(wrapper.find(".patchCardTitle").text()).toContain("tests/agents/claudeCliAdapter.test.ts");
    expect(wrapper.find(".patchCardMeta").text()).toContain("(+118 -2)");
    expect(wrapper.find(".patchCardMeta .patchCardStatAdd").exists()).toBe(true);
    expect(wrapper.find(".patchCardMeta .patchCardStatDel").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff").exists()).toBe(false);

    const toggle = wrapper.find('[data-testid="patch-toggle-patch-1-0"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("展开");

    await toggle.trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".patchCardDiff").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff").text()).toContain("diff --git a/tests/agents/claudeCliAdapter.test.ts");
    expect(wrapper.find(".patchCardDiff .patchCardDiffLine--meta").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff .patchCardDiffLine--add").exists()).toBe(true);
    expect(wrapper.find('[data-testid="patch-toggle-patch-1-0"]').text()).toContain("收起");

    wrapper.unmount();
  });

  it("renders multiple files as separate rows and expands only the target file diff", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [
          {
            id: "patch-2",
            role: "system",
            kind: "patch",
            content: "diff --git a/a.ts b/a.ts\n",
            patch: {
              files: [
                { path: "a.ts", added: 1, removed: 0 },
                { path: "b.ts", added: 2, removed: 1 },
              ],
              diff: [
                "diff --git a/a.ts b/a.ts",
                "index 1111111..2222222 100644",
                "--- a/a.ts",
                "+++ b/a.ts",
                "@@ -0,0 +1 @@",
                "+const a = 1;",
                "",
                "diff --git a/b.ts b/b.ts",
                "index 3333333..4444444 100644",
                "--- a/b.ts",
                "+++ b/b.ts",
                "@@ -1 +1 @@",
                "-const b = 0;",
                "+const b = 2;",
              ].join("\n"),
              truncated: false,
            },
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
    });

    await settleUi(wrapper);

    const titles = wrapper.findAll(".patchCardTitle").map((node) => node.text());
    expect(titles).toEqual(["a.ts", "b.ts"]);
    expect(wrapper.findAll(".patchCardRow")).toHaveLength(2);
    expect(wrapper.findAll(".patchCardDiff")).toHaveLength(0);

    await wrapper.find('[data-testid="patch-toggle-patch-2-1"]').trigger("click");
    await settleUi(wrapper);

    const diffs = wrapper.findAll(".patchCardDiff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.text()).toContain("diff --git a/b.ts b/b.ts");
    expect(diffs[0]!.text()).toContain("const b = 2");
    expect(diffs[0]!.text()).not.toContain("diff --git a/a.ts b/a.ts");

    wrapper.unmount();
  });
});
