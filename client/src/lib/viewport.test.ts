import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSfc } from "../__tests__/readSfc";

type ListenerRegistration = {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
};

describe("chat visual viewport anchoring", () => {
  let viewport: EventTarget & { height: number; offsetTop: number };
  let input: HTMLTextAreaElement;
  let originalRootStyle: string | null;
  const listeners: ListenerRegistration[] = [];

  function trackListeners(target: EventTarget): void {
    const addEventListener = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      if (listener) listeners.push({ target, type, listener, options });
      addEventListener(type, listener, options);
    });
  }

  function cssVariable(name: string): string {
    return document.documentElement.style.getPropertyValue(name);
  }

  function updateViewport(height: number, offsetTop: number, eventType = "resize"): void {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event(eventType));
    vi.advanceTimersByTime(32);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    originalRootStyle = document.documentElement.getAttribute("style");
    viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    trackListeners(window);
    trackListeners(document);
    input = document.createElement("textarea");
    document.body.appendChild(input);
  });

  afterEach(() => {
    for (const { target, type, listener, options } of listeners.splice(0)) {
      target.removeEventListener(type, listener, options);
    }
    input.remove();
    if (originalRootStyle === null) document.documentElement.removeAttribute("style");
    else document.documentElement.setAttribute("style", originalRootStyle);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("anchors the fixed chat page to the reported visual viewport top and height", async () => {
    const app = await readSfc("../App.vue", import.meta.url);
    const rule = app.match(/\.app\s*\{[^}]*\}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/position:\s*fixed\s*;/);
    expect(rule).toMatch(/top:\s*var\(--app-top,\s*0px\)\s*;/);
    expect(rule).toMatch(/height:\s*var\(--ads-visual-viewport-height,\s*100dvh\)\s*;/);
  });

  it("tracks keyboard panning even when only a viewport scroll event fires", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    input.focus();
    updateViewport(440, 0);
    updateViewport(440, 120, "scroll");

    expect(cssVariable("--app-top")).toBe("120px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("440px");
    expect(cssVariable("--safe-bottom-multiplier")).toBe("0");
  });

  it("preserves the viewport offset after blur until the keyboard finishes closing", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    input.focus();
    updateViewport(440, 120);
    input.blur();
    vi.advanceTimersByTime(32);

    expect(cssVariable("--app-top")).toBe("120px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("440px");

    updateViewport(844, 0);
    expect(cssVariable("--app-top")).toBe("0px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");
    expect(cssVariable("--safe-bottom-multiplier")).toBe("1");
  });

  it("recovers after keyboard dismissal without a resize event while input remains focused", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    input.focus();
    updateViewport(440, 120);
    vi.advanceTimersByTime(2000);

    viewport.height = 844;
    viewport.offsetTop = 0;
    vi.advanceTimersByTime(250);
    expect(cssVariable("--app-top")).toBe("0px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");
  });

  it("uses the layout viewport when the visual viewport API is unavailable", async () => {
    vi.stubGlobal("visualViewport", undefined);
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    expect(cssVariable("--app-top")).toBe("0px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");

    vi.stubGlobal("innerHeight", 440);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(32);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("440px");
  });
});
