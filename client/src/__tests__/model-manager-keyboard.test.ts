import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import ModelManager from "../components/ModelManager.vue";
import { readSfc } from "./readSfc";

describe("Role prompt keyboard layout", () => {
  let viewport: EventTarget & { height: number; scale: number };
  let media: EventTarget & { matches: boolean };
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("innerHeight", 844);
    viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
    media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("matchMedia", () => media);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  async function mountPanel() {
    wrapper = mount(ModelManager, {
      attachTo: document.body,
      props: {
        api: { get: vi.fn().mockResolvedValue([]) } as any,
        initialTab: "lane-prompts",
        showHeader: false,
      },
    });
    await flushPromises();
    return {
      panel: wrapper.get('[data-testid="lane-prompt-panel"]'),
      editor: wrapper.get<HTMLTextAreaElement>('[data-testid="lane-prompt-editor"]').element,
    };
  }

  async function resize(height: number) {
    viewport.height = height;
    viewport.dispatchEvent(new Event("resize"));
    await nextTick();
  }

  it("requires both editor focus and a keyboard-sized shrink, then restores on close or blur", async () => {
    const { panel, editor } = await mountPanel();
    await resize(475);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    editor.focus();
    await nextTick();
    expect(panel.classes()).toContain("lanePromptPanel--keyboard-open");

    await resize(844);
    expect(document.activeElement).toBe(editor);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    await resize(744);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    await resize(475);
    expect(panel.classes()).toContain("lanePromptPanel--keyboard-open");

    editor.blur();
    await nextTick();
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    await resize(474);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
  });

  it("reacts when viewport shrink follows focus, but ignores pinch zoom and desktop widths", async () => {
    const { panel, editor } = await mountPanel();
    editor.focus();
    await nextTick();
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    viewport.scale = 2;
    await resize(422);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    await resize(237.5);
    expect(panel.classes()).toContain("lanePromptPanel--keyboard-open");
    viewport.scale = 1;
    viewport.height = 475;
    viewport.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(panel.classes()).toContain("lanePromptPanel--keyboard-open");

    media.matches = false;
    media.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    await nextTick();
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
    await resize(400);
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
  });

  it("keeps the full layout without the visualViewport API", async () => {
    vi.stubGlobal("visualViewport", undefined);
    const { panel, editor } = await mountPanel();
    editor.focus();
    await nextTick();
    expect(panel.classes()).not.toContain("lanePromptPanel--keyboard-open");
  });

  it("reveals the editor using only panel scrolling after the final viewport event", async () => {
    const { panel, editor } = await mountPanel();
    const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    vi.spyOn(panel.element, "getBoundingClientRect").mockReturnValue(rect(87, 475));
    vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(rect(160, 430));
    vi.spyOn(wrapper!.get(".lanePromptActions").element, "getBoundingClientRect").mockReturnValue(rect(410, 475));
    const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    editor.focus();
    await resize(500);
    vi.advanceTimersByTime(200);
    await resize(475);
    vi.advanceTimersByTime(299);
    expect(panel.element.scrollTop).toBe(0);
    vi.advanceTimersByTime(1);
    expect(panel.element.scrollTop).toBe(20);
    expect(windowScroll).not.toHaveBeenCalled();

    await resize(470);
    editor.blur();
    vi.advanceTimersByTime(300);
    expect(panel.element.scrollTop).toBe(20);
  });

  it("clears pending work on tab changes and removes viewport listeners on unmount", async () => {
    const removeListener = vi.spyOn(viewport, "removeEventListener");
    const schedule = vi.spyOn(window, "setTimeout");
    const cancel = vi.spyOn(window, "clearTimeout");
    const { panel, editor } = await mountPanel();
    editor.focus();
    await resize(475);
    const revealTimer = schedule.mock.results.at(-1)!.value;
    await wrapper!.get('[data-testid="settings-tab-models"]').trigger("click");
    await wrapper!.get('[data-testid="settings-tab-prompts"]').trigger("click");
    expect(wrapper!.get('[data-testid="lane-prompt-panel"]').classes()).not.toContain("lanePromptPanel--keyboard-open");
    expect(cancel).toHaveBeenCalledWith(revealTimer);

    wrapper!.get<HTMLTextAreaElement>('[data-testid="lane-prompt-editor"]').element.focus();
    await resize(470);
    const nextRevealTimer = schedule.mock.results.at(-1)!.value;
    wrapper!.unmount();
    wrapper = undefined;
    expect(cancel).toHaveBeenCalledWith(nextRevealTimer);
    expect(removeListener.mock.calls.map(([event]) => event).sort()).toEqual(["resize", "scroll"]);
    viewport.dispatchEvent(new Event("resize"));
    expect(panel.element.scrollTop).toBe(0);
  });

  it("scopes shrinkable editor and non-overlapping actions to the mobile keyboard state", async () => {
    const css = await readSfc("../components/ModelManager.vue", import.meta.url);
    const mobileCss = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(mobileCss).toMatch(/\.lanePromptPanel--keyboard-open \.lanePromptTextarea\s*\{\s*flex: 1 1 auto;\s*min-height: 0;/);
    expect(mobileCss).toMatch(/\.lanePromptPanel--keyboard-open \.lanePromptActions\s*\{\s*bottom: 0;\s*margin: 6px 0 0;/);
  });
});
