import { describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { noticeSpace, useNoticeSpace } from "../composables/app/useNoticeSpace";

describe("notice space reservation", () => {
  it("caps long notices without using the controls' reserved space", () => {
    expect(noticeSpace(500, 844, 19.5, 2)).toEqual({ height: 211, margin: 6, padding: 8 });
  });
  it("compacts spacing before clipping a text line on a short viewport", () => {
    const result = noticeSpace(30, 320, 19.5, 2);
    expect(result).toEqual({ height: 21.5, margin: 4.25, padding: 0 });
    expect(result.height + result.margin * 2).toBe(30);
  });
  it("shrinks when a connection status or multiline composer grows", () => {
    for (const available of [160, 70, 45, 25]) {
      const result = noticeSpace(available, 360, 19.5, 2);
      expect(result.height + result.margin * 2).toBeLessThanOrEqual(available);
      expect(result.height - result.padding * 2 - 2).toBeGreaterThanOrEqual(19.5);
    }
    expect(noticeSpace(-20, 320, 19.5, 2).height).toBe(0);
  });

  it("compacts an already single-row editor without oscillation and releases constraints", async () => {
    const app = document.createElement("div");
    app.innerHTML = `
      <header class="topbar" data-height="70"></header>
      <div class="noticeToast" style="line-height:19.5px;border:1px solid"></div>
      <div class="laneTabs" data-height="36"></div>
      <section class="lanePanel">
        <div class="actionsJobBanner" data-height="76"></div>
        <div class="composer">
          <div class="composerMainRow composerMainRow--expanded" style="row-gap:2px">
            <div class="composerMainRowLeft" data-height="34"></div>
            <textarea class="composer-input" style="height:36px;min-height:34px;line-height:24px;padding:6px 4px;border:0"></textarea>
            <div class="composerMainRowRight" data-height="34"></div>
          </div>
        </div>
      </section>`;
    document.body.appendChild(app);
    let viewportHeight = 320;
    Object.defineProperty(app, "clientHeight", { get: () => viewportHeight });
    const input = app.querySelector("textarea")!;
    const row = app.querySelector<HTMLElement>(".composerMainRow")!;
    input.value = "First line\nSecond line";
    input.setSelectionRange(3, 7);
    for (const node of app.querySelectorAll<HTMLElement>("*")) {
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => {
        const height = node.classList.contains("composer") ? (row.dataset.noticeConstrained ? 100 : 136)
          : node === input ? 36 : Number(node.dataset.height ?? 0);
        return new DOMRect(0, 0, 320, height);
      });
    }
    const frames: FrameRequestCallback[] = [];
    let resize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const scope = effectScope();
    const notice = ref<HTMLElement | null>(null);
    try {
      scope.run(() => useNoticeSpace(notice));
      notice.value = app.querySelector(".noticeToast");
      await nextTick();
      for (let i = 0; i < 4; i++) {
        expect(row.dataset.noticeConstrained).toBe("true");
        expect(parseFloat(notice.value!.style.getPropertyValue("--notice-height"))).toBeGreaterThanOrEqual(21.5);
        resize();
        frames.shift()?.(0);
      }
      viewportHeight = 600;
      resize();
      frames.shift()?.(0);
      expect(row.dataset.noticeConstrained).toBeUndefined();
      viewportHeight = 320;
      resize();
      frames.shift()?.(0);
      expect(row.dataset.noticeConstrained).toBe("true");
      notice.value = null;
      await nextTick();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(row.dataset.noticeConstrained).toBeUndefined();
      expect(input.dataset.noticeConstrained).toBeUndefined();
      expect(input.style.getPropertyValue("--notice-input-height")).toBe("");
      expect(input.style.height).toBe("36px");
      expect(input.value).toBe("First line\nSecond line");
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
    } finally {
      scope.stop();
      app.remove();
      vi.unstubAllGlobals();
    }
  });
});
