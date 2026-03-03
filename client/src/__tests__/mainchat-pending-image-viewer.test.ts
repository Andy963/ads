import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("MainChat pending image viewer", () => {
  it("renders thumbnail previews and opens a viewer on click", async () => {
    const images = [{ data: "data:image/png;base64,AA==" }, { data: "data:image/png;base64,BB==" }];

    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: images,
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
        queuedPrompts: [],
        pendingImages: [{ data: "att-preview-1" }],
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
        queuedPrompts: [],
        pendingImages: images,
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

    await wrapper.find(".attachmentsClear").trigger("click");
    expect(wrapper.emitted("clearImages")).toBeTruthy();
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(false);

    wrapper.unmount();
  });
});
