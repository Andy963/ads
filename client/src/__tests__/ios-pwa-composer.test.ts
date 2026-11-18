import { defineComponent, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

const ComposerHost = defineComponent({
  components: { MainChatComposerPanel },
  setup() {
    return { draft: ref(""), locked: ref(false), sent: ref<string[]>([]) };
  },
  template: `
    <MainChatComposerPanel
      v-model:draft="draft"
      :queued-prompts="[]"
      :pending-images="[]"
      :connected="true"
      :busy="false"
      :input-locked="locked"
      @send="sent.push($event)"
    />
  `,
});

describe("iOS PWA composer input and activation", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      boxSizing: "border-box",
      lineHeight: "24px",
      fontSize: "16px",
      paddingTop: "5px",
      paddingBottom: "5px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
    } as CSSStyleDeclaration);
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return this.value.split("\n").length * 24 + 10;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the draft and send control current during native composition", async () => {
    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea");
    const element = textarea.element as HTMLTextAreaElement;

    await textarea.trigger("compositionstart");
    element.value = "Composed draft";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
    await nextTick();

    expect(wrapper.vm.draft).toBe("Composed draft");
    expect((wrapper.get(".sendIcon").element as HTMLButtonElement).disabled).toBe(false);
    await textarea.trigger("keydown", { key: "Enter", keyCode: 229 });
    expect(wrapper.vm.sent).toEqual([]);
    await textarea.trigger("compositionend");
    expect(wrapper.vm.draft).toBe("Composed draft");
    wrapper.unmount();
  });

  it("sends the native draft once on touch release without waiting for click", async () => {
    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea");
    const element = textarea.element as HTMLTextAreaElement;
    await textarea.setValue("Committed prefix");
    await textarea.trigger("compositionstart");
    element.value = "Committed prefix and composition";
    element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
    await nextTick();
    const send = wrapper.get(".sendIcon");
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true };

    await send.trigger("pointerdown", pointer);
    await send.trigger("pointerup", pointer);
    expect(wrapper.vm.sent).toEqual(["Committed prefix and composition"]);
    send.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    await nextTick();
    await textarea.trigger("compositionend");

    expect(wrapper.vm.sent).toEqual(["Committed prefix and composition"]);
    expect(wrapper.vm.draft).toBe("");
    expect(element.value).toBe("");
    expect(element.style.height).toBe("34px");
    wrapper.unmount();
  });

  it("does not submit a cancelled touch gesture", async () => {
    const wrapper = mount(ComposerHost);
    await wrapper.get("textarea").setValue("Keep this draft");
    const send = wrapper.get(".sendIcon");
    const pointer = { pointerId: 2, pointerType: "touch", isPrimary: true };
    await send.trigger("pointerdown", pointer);
    await send.trigger("pointercancel", pointer);
    await send.trigger("pointerup", pointer);
    expect(wrapper.vm.sent).toEqual([]);
    expect(wrapper.vm.draft).toBe("Keep this draft");
    wrapper.unmount();
  });

  it("reaches five full rows before scrolling and shrinks after deletion", async () => {
    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea");
    const element = textarea.element as HTMLTextAreaElement;
    for (let rows = 1; rows <= 5; rows += 1) {
      await textarea.setValue(Array.from({ length: rows }, (_, index) => `Line ${index + 1}`).join("\n"));
      expect(element.style.height).toBe(`${rows * 24 + 10}px`);
      expect(element.style.overflowY).toBe("hidden");
    }
    await textarea.setValue("Line\n".repeat(10));
    expect(element.style.height).toBe("130px");
    expect(element.style.overflowY).toBe("auto");
    await textarea.setValue("Short");
    expect(element.style.height).toBe("34px");
    wrapper.unmount();
  });

  it("preserves the draft if input becomes locked before touch release", async () => {
    const wrapper = mount(ComposerHost);
    await wrapper.get("textarea").setValue("Do not lose this draft");
    const send = wrapper.get(".sendIcon");
    const pointer = { pointerId: 3, pointerType: "touch", isPrimary: true };
    await send.trigger("pointerdown", pointer);
    wrapper.vm.locked = true;
    await nextTick();
    await send.trigger("pointerup", pointer);
    expect(wrapper.vm.sent).toEqual([]);
    expect(wrapper.vm.draft).toBe("Do not lose this draft");
    wrapper.unmount();
  });

  it("does not erase a new draft when a previous composition ends after sending", async () => {
    const wrapper = mount(ComposerHost);
    const textarea = wrapper.get("textarea");
    await textarea.setValue("First prompt");
    await textarea.trigger("compositionstart");
    await wrapper.get(".sendIcon").trigger("click");
    await textarea.setValue("Next draft");
    await textarea.trigger("compositionend");
    expect(wrapper.vm.sent).toEqual(["First prompt"]);
    expect(wrapper.vm.draft).toBe("Next draft");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("Next draft");
    wrapper.unmount();
  });
});
