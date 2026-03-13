import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("MainChat patch card", () => {
  it("renders a single patch header and expands inline", async () => {
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
    expect(wrapper.find(".patchCardTitle").text()).toContain("tests/agents/claudeCliAdapter.test.ts");
    expect(wrapper.find(".patchCardMeta").text()).toContain("(+118 -2)");
    expect(wrapper.find(".patchCardDiff").exists()).toBe(false);

    const toggle = wrapper.find('[data-testid="patch-toggle-patch-1"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("展开");

    await toggle.trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".patchCardDiff").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff").text()).toContain("diff --git a/tests/agents/claudeCliAdapter.test.ts");
    expect(wrapper.find('[data-testid="patch-toggle-patch-1"]').text()).toContain("收起");

    wrapper.unmount();
  });

  it("shows hidden file count in the compact header", async () => {
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
              diff: "diff --git a/a.ts b/a.ts\n",
              truncated: true,
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

    expect(wrapper.find(".patchCardMeta").text()).toContain("另 1 个文件");

    await wrapper.find('[data-testid="patch-toggle-patch-2"]').trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".patchCardNote").text()).toContain("Diff 已截断");

    wrapper.unmount();
  });
});
