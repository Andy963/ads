import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

const STORAGE_KEY = "ADS_WEB_LATEST_PROMPT:project-1:main";

function mountPromptTools(options?: { inputLocked?: boolean; latestPromptKey?: string }) {
  const Host = defineComponent({
    components: { MainChatComposerPanel },
    setup() {
      const draft = ref("");
      const sent = ref<string[]>([]);
      return { draft, sent };
    },
    template: `
      <MainChatComposerPanel
        :draft="draft"
        :queued-prompts="[]"
        :pending-images="[]"
        :connected="true"
        :busy="false"
        :input-locked="${options?.inputLocked === true ? "true" : "false"}"
        latest-prompt-key="${options?.latestPromptKey ?? "project-1:main"}"
        @update:draft="draft = $event"
        @send="sent.push($event)"
      />
    `,
  });
  return mount(Host, { global: { stubs: { MainChatPendingImageViewer: true } } });
}

describe("MainChat prompt tools", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the latest sent prompt and restores it into an empty composer", async () => {
    const wrapper = mountPromptTools();
    const textarea = wrapper.get("textarea.composer-input");

    await textarea.setValue("Retry this prompt");
    await wrapper.get("button.sendIcon").trigger("click");
    await nextTick();

    expect(localStorage.getItem(STORAGE_KEY)).toBe("Retry this prompt");
    expect((wrapper.vm as { sent: string[] }).sent).toEqual(["Retry this prompt"]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");

    const restore = wrapper.get("[data-testid='restore-latest-prompt']");
    expect(restore.attributes("disabled")).toBeUndefined();
    await restore.trigger("click");
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("Retry this prompt");
    expect((textarea.element as HTMLTextAreaElement).selectionStart).toBe("Retry this prompt".length);
    wrapper.unmount();
  });

  it("keeps latest prompts isolated by project and lane and does not overwrite a draft", async () => {
    localStorage.setItem(STORAGE_KEY, "Worker prompt");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:project-1:planner", "Planner prompt");

    const wrapper = mountPromptTools({ latestPromptKey: "project-1:planner" });
    const textarea = wrapper.get("textarea.composer-input");
    const restore = wrapper.get("[data-testid='restore-latest-prompt']");
    await textarea.setValue("Current draft");

    expect(restore.attributes("disabled")).toBeDefined();
    await textarea.setValue("");
    await restore.trigger("click");
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("Planner prompt");
    wrapper.unmount();
  });

  it("wraps only the selected text with triple quotes and preserves the selection", async () => {
    const wrapper = mountPromptTools();
    const textarea = wrapper.get("textarea.composer-input");
    await textarea.setValue("alpha beta");

    const element = textarea.element as HTMLTextAreaElement;
    element.focus();
    element.setSelectionRange(6, 10);
    await textarea.trigger("select");

    const quote = wrapper.get("[data-testid='wrap-triple-quotes']");
    expect(quote.attributes("disabled")).toBeUndefined();
    await quote.trigger("click");
    await nextTick();

    expect(element.value).toBe('alpha """beta"""');
    expect(element.selectionStart).toBe(9);
    expect(element.selectionEnd).toBe(13);
    wrapper.unmount();
  });

  it("places both tools in the bottom toolbar and disables them while input is locked", () => {
    localStorage.setItem(STORAGE_KEY, "Stored prompt");
    const wrapper = mountPromptTools({ inputLocked: true });
    const toolbarRight = wrapper.get(".inputToolbarRight").element;
    const restoreBtn = wrapper.get("[data-testid='restore-latest-prompt']").element;
    const quoteBtn = wrapper.get("[data-testid='wrap-triple-quotes']").element;
    const toolbarChildren = Array.from(toolbarRight.children);

    expect(toolbarChildren).toContain(restoreBtn);
    expect(toolbarChildren).toContain(quoteBtn);
    expect(wrapper.get("[data-testid='restore-latest-prompt']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[data-testid='wrap-triple-quotes']").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
