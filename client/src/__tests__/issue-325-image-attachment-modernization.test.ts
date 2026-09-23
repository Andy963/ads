import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";
import MainChatMessageList from "../components/MainChatMessageList.vue";

describe("Issue #325: image attachment modernization", () => {
  it("renders 48x48 thumbnails with individual delete badges in composer and removes single image", async () => {
    const wrapper = mount(MainChatComposerPanel, {
      props: {
        queuedPrompts: [],
        pendingImages: [
          { data: "data:image/png;base64,image1" },
          { data: "data:image/png;base64,image2" },
        ],
        connected: true,
        busy: false,
        inputLocked: false,
      },
      global: {
        stubs: {
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);

    // Global clear button is removed
    expect(wrapper.find(".attachmentsClear").exists()).toBe(false);

    // Thumbnails have individual delete badges
    const thumbs = wrapper.findAll(".attachmentsThumbItem");
    expect(thumbs).toHaveLength(2);

    const deleteBadge0 = wrapper.find('[data-testid="attachment-remove-0"]');
    expect(deleteBadge0.exists()).toBe(true);
    const deleteBadge1 = wrapper.find('[data-testid="attachment-remove-1"]');
    expect(deleteBadge1.exists()).toBe(true);

    // Clicking remove badge 0 emits removeImage(0)
    await deleteBadge0.trigger("click");
    expect(wrapper.emitted("removeImage")?.[0]?.[0]).toBe(0);

    wrapper.unmount();
  });

  it("renders multiple user message images in compact 2-column gallery grid", async () => {
    const content = "Please inspect these screenshots:\n\n![attachment 1](/api/attachments/att-1/raw)\n![attachment 2](/api/attachments/att-2/raw)";
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "user-msg-1", role: "user", kind: "text", content, ts: 1000 }],
        copiedMessageId: null,
        formatMessageTs: () => "10:00",
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
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const grid = wrapper.find('[data-testid="msg-attachment-grid"]');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).not.toContain("msgAttachmentGrid--single");

    const thumbs = grid.findAll(".msgAttachmentThumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]?.find("img").attributes("src")).toBe("/api/attachments/att-1/raw");
    expect(thumbs[1]?.find("img").attributes("src")).toBe("/api/attachments/att-2/raw");

    // Clicking thumbnail triggers image viewer modal
    expect(wrapper.findComponent({ name: "MainChatPendingImageViewer" }).exists()).toBe(false);
    await thumbs[0]?.trigger("click");
    expect(wrapper.findComponent({ name: "MainChatPendingImageViewer" }).exists()).toBe(true);

    wrapper.unmount();
  });

  it("renders single user message image with single-image grid class", async () => {
    const content = "Single image:\n\n![attachment 1](/api/attachments/att-single/raw)";
    const wrapper = mount(MainChatMessageList, {
      props: {
        messages: [{ id: "user-msg-2", role: "user", kind: "text", content, ts: 2000 }],
        copiedMessageId: null,
        formatMessageTs: () => "10:05",
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
          MainChatPendingImageViewer: true,
        },
      },
      attachTo: document.body,
    });

    const grid = wrapper.find('[data-testid="msg-attachment-grid"]');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).toContain("msgAttachmentGrid--single");
    expect(grid.findAll(".msgAttachmentThumb")).toHaveLength(1);

    wrapper.unmount();
  });
});
