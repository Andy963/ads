import { describe, expect, it } from "vitest";
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";
import MainChatModelSelectors from "../components/MainChatModelSelectors.vue";
import { renderMarkdownToHtml } from "../lib/markdown";
import { readSfc } from "./readSfc";

const MarkdownContentStub = defineComponent({
  name: "MarkdownContent",
  props: {
    content: { type: String, required: true },
  },
  template: `<div class="md">{{ content }}</div>`,
});

const mainChatBaseProps = {
  queuedPrompts: [],
  pendingImages: [],
  connected: true,
  busy: false,
} as const;

function mainChatMountOptions(messages: unknown[]) {
  return {
    props: { messages, ...mainChatBaseProps },
    global: { stubs: { MarkdownContent: true } },
    attachTo: document.body,
  } as const;
}

function messageListProps(messages: unknown[]) {
  return {
    messages,
    copiedMessageId: null,
    formatMessageTs: () => "",
    liveStepExpanded: false,
    liveStepHasOverflow: false,
    liveStepCanToggleExpanded: false,
    liveStepOutlineItems: [],
    liveStepOutlineHiddenCount: 0,
    liveStepCollapsedTrivialOutline: false,
  } as const;
}

async function settleUi(wrapper: { vm: { $nextTick: () => Promise<void> } }): Promise<void> {
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  await wrapper.vm.$nextTick();
}

describe("MainChat draft persistence", () => {
  it("restores the parent-owned draft after the composer unmounts and remounts", async () => {
    const Host = defineComponent({
      components: { MainChat },
      setup() {
        const visible = ref(true);
        const draft = ref("initial worker draft");
        return { visible, draft };
      },
      template: `
        <button type="button" class="toggle" @click="visible = !visible">toggle</button>
        <MainChat
          v-if="visible"
          title="Worker"
          :messages="[]"
          :queued-prompts="[]"
          :pending-images="[]"
          :connected="true"
          :busy="false"
          :draft="draft"
          @update:draft="draft = $event"
        />
      `,
    });

    const wrapper = mount(Host, { global: { stubs: { MarkdownContent: true } } });

    const textarea = wrapper.get("textarea.composer-input");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("initial worker draft");

    await textarea.setValue("restored after remount");
    expect((wrapper.vm as { draft: string }).draft).toBe("restored after remount");

    await wrapper.get("button.toggle").trigger("click");
    expect(wrapper.find("textarea.composer-input").exists()).toBe(false);

    await wrapper.get("button.toggle").trigger("click");
    const remountedTextarea = wrapper.get("textarea.composer-input");
    expect((remountedTextarea.element as HTMLTextAreaElement).value).toBe("restored after remount");

    wrapper.unmount();
  });

  it("disables composer input while the lane is locked and renders fixed progress status", () => {
    const wrapper = mount(MainChat, {
      props: {
        title: "Worker",
        messages: [],
        ...mainChatBaseProps,
        inputLocked: true,
        draft: "wait",
        connectionStatusKind: "progress",
        connectionStatusMessage: "上一轮仍在执行，正在等待后端结果…",
      },
      global: { stubs: { MarkdownContent: true } },
    });

    expect(wrapper.get("textarea.composer-input").attributes("disabled")).toBeDefined();
    expect(wrapper.get("button.sendIcon").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='lane-connection-status']").text()).toContain("正在等待后端结果");

    wrapper.unmount();
  });
});

describe("main chat error style regression", () => {
  it("marks restored error history with the error kind hook, distinct from normal system messages", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: messageListProps([
        { id: "s-1", role: "system", kind: "text", content: "session restored", ts: 1 },
        { id: "e-1", role: "system", kind: "error", content: "turn failed: boom", ts: 2 },
      ]),
      global: { stubs: { MarkdownContent: MarkdownContentStub, ChatFilePreviewModal: true } },
    });

    const errorRow = wrapper.get('.msg[data-kind="error"]');
    expect(errorRow.attributes("data-id")).toBe("e-1");
    expect(errorRow.find(".bubble").exists()).toBe(true);
    expect(errorRow.text()).toContain("turn failed: boom");

    const normalRow = wrapper.get('.msg[data-id="s-1"]');
    expect(normalRow.attributes("data-kind")).toBe("text");

    wrapper.unmount();
  });
});

describe("main chat execution metadata", () => {
  it("does not render agent, model, or reasoning badges under user messages", async () => {
    const wrapper = mount(MainChatMessageList, {
      props: messageListProps([
        {
          id: "u-1",
          role: "user",
          kind: "text",
          content: "hello",
          execution: {
            agentId: "codex",
            model: "gpt-5.5",
            modelReasoningEffort: "high",
            effectiveAgentId: "codex",
            effectiveModel: "gpt-5.5",
            effectiveModelReasoningEffort: "high",
          },
        },
      ]),
      global: {
        stubs: {
          MarkdownContent: true,
          ChatFilePreviewModal: true,
        },
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.find(".msgExecutionMeta").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Agent:");
    expect(wrapper.text()).not.toContain("Model:");
    expect(wrapper.text()).not.toContain("Reasoning:");

    wrapper.unmount();
  });
});

describe("MainChat patch card", () => {
  it("folds one patch row per file into the assistant explanation and expands inline", async () => {
    const wrapper = mount(MainChat, mainChatMountOptions([
      {
        id: "patch-1",
        role: "system",
        kind: "patch",
        content: "diff --git a/tests/a.ts b/tests/a.ts\n+hello\n",
        patch: {
          files: [{ path: "tests/agents/codexAppServerAdapter.test.ts", added: 118, removed: 2 }],
          diff: "diff --git a/tests/agents/codexAppServerAdapter.test.ts b/tests/agents/codexAppServerAdapter.test.ts\n+hello\n",
          truncated: false,
        },
      },
      {
        id: "assistant-1",
        role: "assistant",
        kind: "text",
        content: "Updated the requested file.",
      },
    ]));

    await settleUi(wrapper);

    expect(wrapper.find(".foldedPatch").exists()).toBe(true);
    expect(wrapper.findAll(".patchCardRow")).toHaveLength(1);
    expect(wrapper.find(".patchCardTitle").text()).toContain("tests/agents/codexAppServerAdapter.test.ts");
    expect(wrapper.find(".patchCardMeta").text()).toContain("(+118 -2)");
    expect(wrapper.find(".patchCardMeta .patchCardStatAdd").exists()).toBe(true);
    expect(wrapper.find(".patchCardMeta .patchCardStatDel").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff").exists()).toBe(false);

    const toggle = wrapper.find('[data-testid="patch-toggle-assistant-1-0"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("展开");

    await toggle.trigger("click");
    await settleUi(wrapper);

    expect(wrapper.find(".patchCardDiff").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff").text()).toContain("diff --git a/tests/agents/codexAppServerAdapter.test.ts");
    expect(wrapper.find(".patchCardDiff .patchCardDiffLine--meta").exists()).toBe(true);
    expect(wrapper.find(".patchCardDiff .patchCardDiffLine--add").exists()).toBe(true);
    expect(wrapper.find('[data-testid="patch-toggle-assistant-1-0"]').text()).toContain("收起");

    wrapper.unmount();
  });

  it("folds multiple files as separate rows and expands only the target file diff", async () => {
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
          {
            id: "assistant-2",
            role: "assistant",
            kind: "text",
            content: "Updated both files.",
          },
        ],
        ...mainChatBaseProps,
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

    await wrapper.find('[data-testid="patch-toggle-assistant-2-1"]').trigger("click");
    await settleUi(wrapper);

    const diffs = wrapper.findAll(".patchCardDiff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.text()).toContain("diff --git a/b.ts b/b.ts");
    expect(diffs[0]!.text()).toContain("const b = 2");
    expect(diffs[0]!.text()).not.toContain("diff --git a/a.ts b/a.ts");

    wrapper.unmount();
  });
});

describe("MainChat pending image viewer", () => {
  it("renders thumbnail previews and opens a viewer on click", async () => {
    const images = [{ data: "data:image/png;base64,AA==" }, { data: "data:image/png;base64,BB==" }];

    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        ...mainChatBaseProps,
        pendingImages: images,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    expect(wrapper.find(".attachmentsViewer").exists()).toBe(false);
    const thumbs = wrapper.findAll(".attachmentsThumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.find("img.attachmentsThumbImg").attributes("src")).toBe(images[0]!.data);

    await thumbs[0]!.trigger("click");
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(true);

    const viewerImages = wrapper.findAll<HTMLImageElement>(".attachmentsViewerImg");
    expect(viewerImages).toHaveLength(2);
    expect(viewerImages[0]!.attributes("src")).toBe(images[0]!.data);
    expect(viewerImages[1]!.attributes("src")).toBe(images[1]!.data);

    await wrapper.find(".attachmentsViewerClose").trigger("click");
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(false);

    wrapper.unmount();
  });

  it("normalizes attachment id to backend raw URL for preview", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        ...mainChatBaseProps,
        pendingImages: [{ data: "att-preview-1" }],
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    const thumb = wrapper.find(".attachmentsThumbImg");
    expect(thumb.exists()).toBe(true);
    expect(thumb.attributes("src")).toBe("/api/attachments/att-preview-1/raw");

    wrapper.unmount();
  });

  it("does not open the viewer when clearing images", async () => {
    const images = [{ data: "data:image/png;base64,AA==" }];

    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        ...mainChatBaseProps,
        pendingImages: images,
      },
      global: {
        stubs: {
          MarkdownContent: true,
        },
      },
      attachTo: document.body,
    });

    await wrapper.find(".attachmentsRemoveBadge").trigger("click");
    expect(wrapper.emitted("clearImages")).toBeTruthy();
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(false);

    wrapper.unmount();
  });
});

describe("MainChat ready agents", () => {
  it("hides the agent selector and auto-switches when the active agent is not ready", async () => {
    const wrapper = mount(MainChatModelSelectors, {
      props: {
        connected: true,
        busy: false,
        agents: [
          { id: "codex", name: "Codex", ready: false, error: "missing api key" },
          { id: "claude", name: "Claude", ready: true },
        ],
        activeAgentId: "codex",
        models: [],
        modelId: "auto",
      },
    });

    await wrapper.vm.$nextTick();

    const agentSelect = wrapper.find('select[aria-label="Select agent"]');
    expect(agentSelect.exists()).toBe(false);

    expect(wrapper.emitted("switchAgent")?.[0]?.[0]).toBe("claude");
    expect(wrapper.emitted("switchAgent")?.length).toBe(1);

    wrapper.unmount();
  });
});

describe("chat bubble content structure", () => {
  it.each([
    { label: "short text", content: "a" },
    { label: "wrapped text", content: "A longer user message ".repeat(20) },
  ])("keeps copy and timestamp inside the user bubble for $label", async ({ content }) => {
    const wrapper = mount(MainChatMessageList, {
      props: {
        ...messageListProps([{ id: "user-message", role: "user", kind: "text", content, ts: 1 }]),
        formatMessageTs: () => "09:15",
      },
      global: { stubs: { MarkdownContent: true, ChatFilePreviewModal: true } },
    });
    const actions = wrapper.get('.msg[data-role="user"] .bubble > .msgActions');

    expect(actions.get(".msgTime").text()).toBe("09:15");
    await actions.get(".msgCopyBtn").trigger("click");
    expect(wrapper.emitted("copyMessage")?.[0]?.[0]).toMatchObject({ id: "user-message", role: "user", content });
    wrapper.unmount();
  });
});

describe("markdown diffstat", () => {
  it("renders (+A -B) with colored spans", () => {
    const html = renderMarkdownToHtml("- `client/src/app/featureFlags.ts` (+0 -1)");
    expect(html).toContain('class="md-diffstat"');
    expect(html).toContain('class="md-diffstat-add"');
    expect(html).toContain(">+0<");
    expect(html).toContain('class="md-diffstat-del"');
    expect(html).toContain(">-1<");
  });
});

describe("markdown GitHub theme regression", () => {
  it("renders fenced code blocks with highlight classes", () => {
    const html = renderMarkdownToHtml("```ts\nconst answer: number = 1;\n```");

    expect(html).toContain('class="md-codeblock"');
    expect(html).toContain('class="hljs language-typescript"');
    expect(html).toContain("hljs-keyword");
  });

  it("renders common markdown structures used by the chat UI", () => {
    const html = renderMarkdownToHtml("> quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---");

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<hr>");
  });

  it("keeps GitHub-like markdown styles for code and rich content", async () => {
    const css = await readSfc("../components/MarkdownContent.vue", import.meta.url);

    expect(css).toMatch(/\.md\s*:deep\(blockquote\)\s*\{[\s\S]*?border-left:\s*4px solid var\(--github-border-muted\)\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(table\)\s*\{[\s\S]*?overflow-x:\s*auto\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(\.hljs-keyword\)[\s\S]*?color:\s*#cf222e\s*;/);
    expect(css).toMatch(/\.md\s*:deep\(\.md-codeblock\)\s*\{[\s\S]*?background:\s*var\(--github-code-bg\)\s*;/);
  });
});
