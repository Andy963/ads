import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";
import { readSfc } from "./readSfc";

describe("compact attachment UI", () => {
  it("MainChat renders thumbnail previews with clear action", async () => {
    const wrapper = mount(MainChat, {
      props: {
        messages: [],
        queuedPrompts: [],
        pendingImages: [{ data: "data:image/png;base64,AA==" }],
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

    const bar = wrapper.find(".attachmentsBar");
    expect(bar.exists()).toBe(true);
    const thumb = wrapper.find(".attachmentsThumb");
    expect(thumb.exists()).toBe(true);

    await wrapper.find(".attachmentsClear").trigger("click");
    expect(wrapper.emitted("clearImages")).toBeTruthy();

    const sfc = await readSfc("../components/MainChatComposerPanel.vue", import.meta.url);
    expect(sfc).toMatch(/\.attachmentsBar\s*\{[\s\S]*min-height:\s*28px\s*;/);
    expect(sfc).toMatch(/\.attachmentsThumb\s*\{[\s\S]*width:\s*36px\s*;[\s\S]*height:\s*24px\s*;/);
    expect(sfc).toMatch(/\.attachmentsClear\s*\{[\s\S]*width:\s*26px\s*;[\s\S]*height:\s*26px\s*;/);

    wrapper.unmount();
  });
});
