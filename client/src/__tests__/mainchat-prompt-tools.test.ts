import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";
import { DOMWrapper, mount } from "@vue/test-utils";

import MainChatComposerPanel from "../components/MainChatComposerPanel.vue";

const STORAGE_KEY = "ADS_WEB_LATEST_PROMPT:project-1:main";

function mountPromptTools(options?: { inputLocked?: boolean; latestPromptKey?: string }) {
  const Host = defineComponent({
    components: { MainChatComposerPanel },
    props: { inputLocked: { type: Boolean, default: options?.inputLocked === true } },
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
        :input-locked="inputLocked"
        latest-prompt-key="${options?.latestPromptKey ?? "project-1:main"}"
        @update:draft="draft = $event"
        @send="sent.push($event)"
      />
    `,
  });
  return mount(Host, { attachTo: document.body, global: { stubs: { MainChatPendingImageViewer: true } } });
}

function action(selector: string): DOMWrapper<Element> {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing action: ${selector}`);
  return new DOMWrapper(element);
}

function dispatchCompatibilityClick(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

async function openActionSheet(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('[data-testid="composer-actions-toggle"]').trigger("click");
  await nextTick();
}

describe("MainChat prompt tools", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 240, 32, 32));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
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

    await openActionSheet(wrapper);
    const restore = action("[data-testid='restore-latest-prompt']");
    expect(restore.attributes("disabled")).toBeUndefined();
    await restore.trigger("click");
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe("Retry this prompt");
    expect((textarea.element as HTMLTextAreaElement).selectionStart).toBe("Retry this prompt".length);
    wrapper.unmount();
  });

  it("still dispatches and clears the composer when latest-prompt storage fails", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const wrapper = mountPromptTools();
    const textarea = wrapper.get("textarea.composer-input");

    await textarea.setValue("Prompt without storage");
    await textarea.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect((wrapper.vm as { sent: string[] }).sent).toEqual(["Prompt without storage"]);
    expect((textarea.element as HTMLTextAreaElement).value).toBe("");
    wrapper.unmount();
  });

  it("keeps latest prompts isolated by project and lane and does not overwrite a draft", async () => {
    localStorage.setItem(STORAGE_KEY, "Worker prompt");
    localStorage.setItem("ADS_WEB_LATEST_PROMPT:project-1:planner", "Planner prompt");

    const wrapper = mountPromptTools({ latestPromptKey: "project-1:planner" });
    const textarea = wrapper.get("textarea.composer-input");
    await textarea.setValue("Current draft");
    await openActionSheet(wrapper);
    const restore = action("[data-testid='restore-latest-prompt']");

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

    await openActionSheet(wrapper);
    const quote = action("[data-testid='wrap-triple-quotes']");
    expect(quote.attributes("disabled")).toBeUndefined();
    await quote.trigger("click");
    await nextTick();

    expect(element.value).toBe('alpha """beta"""');
    expect(element.selectionStart).toBe(9);
    expect(element.selectionEnd).toBe(13);
    wrapper.unmount();
  });

  it("keeps secondary actions behind the plus button and disables the trigger while input is locked", () => {
    localStorage.setItem(STORAGE_KEY, "Stored prompt");
    const wrapper = mountPromptTools({ inputLocked: true });
    expect(wrapper.find(".inputToolbarRight").exists()).toBe(false);
    expect(wrapper.get('[data-testid="composer-actions-toggle"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="composer-action-sheet"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps portal actions alive through pointerdown and invokes the file picker synchronously", async () => {
    const wrapper = mountPromptTools();
    const fileInput = wrapper.get('input[type="file"]').element as HTMLInputElement;
    const picker = vi.spyOn(fileInput, "click").mockImplementation(() => {});
    await openActionSheet(wrapper);
    const menu = action('[data-testid="composer-action-sheet"]');
    expect(document.body.contains(menu.element)).toBe(true);
    expect(wrapper.element.contains(menu.element)).toBe(false);

    const attach = action('[data-testid="action-attach-image"]');
    await attach.trigger("pointerdown");
    expect(document.body.contains(attach.element)).toBe(true);
    attach.element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(picker).toHaveBeenCalledOnce();
    await nextTick();
    expect(document.querySelector('[data-testid="composer-action-sheet"]')).toBeNull();
    wrapper.unmount();
  });

  it("toggles on pointer release or click, dismisses outside and on Escape, and closes when locked", async () => {
    const wrapper = mountPromptTools();
    const toggle = wrapper.get('[data-testid="composer-actions-toggle"]');
    await toggle.trigger("pointerdown", { pointerType: "touch" });
    await toggle.trigger("pointerup", { pointerType: "touch" });
    expect(toggle.attributes("aria-expanded")).toBe("true");
    dispatchCompatibilityClick(toggle.element);
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("true");
    await toggle.trigger("pointerdown", { pointerType: "touch" });
    await toggle.trigger("pointerup", { pointerType: "touch" });
    dispatchCompatibilityClick(toggle.element);
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("false");

    await openActionSheet(wrapper);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await openActionSheet(wrapper);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await openActionSheet(wrapper);
    await wrapper.setProps({ inputLocked: true });
    expect(toggle.attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("opens on a pointer release when no click follows and suppresses the compatibility click", async () => {
    const wrapper = mountPromptTools();
    const toggle = wrapper.get('[data-testid="composer-actions-toggle"]');

    await toggle.trigger("pointerdown", { pointerId: 1 });
    await toggle.trigger("pointerup", { pointerId: 1 });
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("true");

    dispatchCompatibilityClick(toggle.element);
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("true");

    await toggle.trigger("pointerdown", { pointerId: 2 });
    await toggle.trigger("pointerup", { pointerId: 2 });
    dispatchCompatibilityClick(toggle.element);
    await nextTick();
    await nextTick();
    expect(toggle.attributes("aria-expanded")).toBe("false");
    wrapper.unmount();
  });

  it("preserves a selected range when touch activation blurs the textarea", async () => {
    const wrapper = mountPromptTools();
    const textarea = wrapper.get("textarea.composer-input");
    const element = textarea.element as HTMLTextAreaElement;
    await textarea.setValue("alpha beta");
    element.focus();
    element.setSelectionRange(6, 10);
    await textarea.trigger("select");

    const toggle = wrapper.get('[data-testid="composer-actions-toggle"]');
    await toggle.trigger("pointerdown", { pointerId: 1 });
    await textarea.trigger("blur");
    await toggle.trigger("pointerup", { pointerId: 1 });
    await nextTick();

    const quote = action("[data-testid='wrap-triple-quotes']");
    expect(quote.attributes("disabled")).toBeUndefined();
    await quote.trigger("click");
    await nextTick();
    expect(element.value).toBe('alpha """beta"""');
    wrapper.unmount();
  });

  it("anchors the portal to the trigger and bounds its height inside the visual viewport", async () => {
    vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { height: 300, offsetTop: 0, width: 320, offsetLeft: 0 }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(24, 248, 32, 32));
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(124);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(126);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(124);
    const wrapper = mountPromptTools();
    await openActionSheet(wrapper);
    await nextTick();
    const menu = action('[data-testid="composer-action-sheet"]').element as HTMLElement;
    expect(menu.style.top).toBe("114px");
    expect(menu.style.left).toBe("24px");
    expect(menu.style.maxHeight).toBe("232px");
    expect(menu.style.visibility).toBe("visible");
    expect(wrapper.get('[data-testid="composer-actions-toggle"]').attributes("aria-controls")).toBe(menu.id);
    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it("reduces menu height on viewport-only changes even before the trigger finishes moving", async () => {
    vi.useFakeTimers();
    const viewport = Object.assign(new EventTarget(), { height: 300, offsetTop: 0, width: 320, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(124);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(126);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(124);
    const wrapper = mountPromptTools();
    await openActionSheet(wrapper);
    await nextTick();
    const menu = action('[data-testid="composer-action-sheet"]').element as HTMLElement;
    viewport.height = 110;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(32);
    await nextTick();
    expect(menu.style.top).toBe("8px");
    expect(menu.style.maxHeight).toBe("94px");
    expect(menu.style.visibility).toBe("visible");
    wrapper.unmount();
  });
});
