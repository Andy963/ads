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
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
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

  it("gives the root sole ownership of visual viewport geometry and remaining safe area", async () => {
    const app = await readSfc("../App.vue", import.meta.url);
    const html = await readSfc("../../index.html", import.meta.url);
    const global = await readSfc("../global.css", import.meta.url);
    const rule = app.match(/\.app\s*\{[^}]*\}/)?.[0];
    const root = html.match(/#app\s*\{[^}]*\}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toMatch(/height:\s*100%\s*;/);
    expect(rule).not.toContain("--app-top");
    expect(root).toMatch(/position:\s*fixed\s*;/);
    expect(root).toMatch(/top:\s*var\(--app-top,\s*0px\)\s*;/);
    expect(root).toMatch(/height:\s*var\(--ads-visual-viewport-height,\s*100dvh\)\s*;/);
    expect(root).toContain("max(0px, calc(env(safe-area-inset-bottom, 0px) - var(--app-bottom, 0px)))");
    expect(global).not.toMatch(/#app\s*\{[^}]*height:/);
  });

  it("tracks keyboard panning even when only a viewport scroll event fires", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    input.focus();
    updateViewport(440, 0);
    updateViewport(440, 120, "scroll");

    expect(cssVariable("--app-top")).toBe("120px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("440px");
    expect(cssVariable("--app-bottom")).toBe("284px");
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
    expect(cssVariable("--app-bottom")).toBe("284px");

    updateViewport(844, 0);
    expect(cssVariable("--app-top")).toBe("0px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");
    expect(cssVariable("--app-bottom")).toBe("0px");
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

  it("recovers after blur when the keyboard closes after the event burst without a resize event", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    input.focus();
    updateViewport(440, 120);
    input.blur();
    vi.advanceTimersByTime(2500);

    viewport.height = 844;
    viewport.offsetTop = 0;
    vi.advanceTimersByTime(250);

    expect(document.activeElement).not.toBe(input);
    expect(cssVariable("--app-top")).toBe("0px");
    expect(cssVariable("--app-bottom")).toBe("0px");
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");
    expect(cssVariable("--app-bottom")).toBe("0px");
  });

  it("tracks silent browser viewport changes when no input is focused", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();

    viewport.height = 780;
    vi.advanceTimersByTime(250);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("780px");

    viewport.height = 844;
    vi.advanceTimersByTime(250);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");
  });

  it("does not rewrite layout styles when fallback polling reads unchanged metrics", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();
    const setProperty = vi.spyOn(document.documentElement.style, "setProperty");

    vi.advanceTimersByTime(1000);
    expect(setProperty).not.toHaveBeenCalled();
  });

  it("suspends fallback polling in the background and refreshes when the page becomes visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();

    viewport.height = 780;
    vi.advanceTimersByTime(1000);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("844px");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(32);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("780px");
  });

  it("refreshes immediately when a page is restored from the back-forward cache", async () => {
    const { installViewportCssVars } = await import("./viewport");
    installViewportCssVars();

    viewport.height = 780;
    window.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(32);
    expect(cssVariable("--ads-visual-viewport-height")).toBe("780px");
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
