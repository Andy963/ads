import { describe, expect, it } from "vitest";
import { defineComponent, ref } from "vue";
import { mount } from "@vue/test-utils";

import MainChat from "../components/MainChat.vue";

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
});
