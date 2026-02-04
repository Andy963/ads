import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

describe("MainChat pending image viewer", () => {
  it("opens a viewer when clicking the attachments pill and allows navigation", async () => {
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

    await wrapper.find(".attachmentsPill").trigger("click");
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(true);

    const img = wrapper.find<HTMLImageElement>(".attachmentsViewerImg");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe(images[0]!.data);

    await wrapper.find(".attachmentsViewerNext").trigger("click");
    expect(wrapper.find(".attachmentsViewerImg").attributes("src")).toBe(images[1]!.data);

    await wrapper.find(".attachmentsViewerPrev").trigger("click");
    expect(wrapper.find(".attachmentsViewerImg").attributes("src")).toBe(images[0]!.data);

    await wrapper.find(".attachmentsViewerClose").trigger("click");
    expect(wrapper.find(".attachmentsViewer").exists()).toBe(false);

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

