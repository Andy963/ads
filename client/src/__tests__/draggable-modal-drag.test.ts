import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";

import DraggableModal from "../components/DraggableModal.vue";

function ensurePointerCapturePolyfill(): void {
  if (!HTMLElement.prototype.setPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      value: () => {},
      configurable: true,
    });
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      value: () => {},
      configurable: true,
    });
  }
}

function parseTranslate3d(transform: string): { x: number; y: number } {
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0\)/.exec(transform);
  if (!m) {
    throw new Error(`Missing translate3d in transform: ${transform}`);
  }
  return { x: Number(m[1]), y: Number(m[2]) };
}

function dispatchPointerEvent(el: Element, type: string, props: Record<string, unknown>): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(ev, k, { value: v, configurable: true });
  }
  el.dispatchEvent(ev);
}

describe("DraggableModal", () => {
  it("moves when dragging from the handle and clamps to viewport bounds", async () => {
    // Manual QA checklist:
    // - Open create/edit task dialogs, drag by title, ensure inputs still work
    // - Drag to all corners/edges; ensure header remains reachable
    // - Resize window while modal is offset; ensure it stays within viewport
    ensurePointerCapturePolyfill();

    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });

    const wrapper = mount(DraggableModal, {
      props: { cardVariant: "default" },
      slots: {
        default: `
          <div>
            <div data-drag-handle>Handle</div>
            <div>Body</div>
          </div>
        `,
      },
    });

    const card = wrapper.find(".draggableCard");
    const overlay = wrapper.find(".draggableOverlay");
    const handle = wrapper.find("[data-drag-handle]");

    // JSDOM reports 0x0 by default; provide a stable size for bound calculation.
    (card.element as HTMLElement).getBoundingClientRect = vi.fn(() => {
      return {
        width: 400,
        height: 300,
        top: 0,
        left: 0,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as unknown as DOMRect;
    });

    await nextTick();

    const initial = String(card.attributes("style") ?? "");
    expect(initial).toContain("translate3d(0px, 0px, 0)");

    dispatchPointerEvent(handle.element, "pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    dispatchPointerEvent(overlay.element, "pointermove", { pointerId: 1, clientX: 160, clientY: 140 });
    dispatchPointerEvent(overlay.element, "pointerup", { pointerId: 1, clientX: 160, clientY: 140 });
    await nextTick();

    const after = String(card.attributes("style") ?? "");
    expect(after).toContain("translate3d(60px, 40px, 0)");

    // Try to drag far beyond the viewport; the modal should clamp.
    dispatchPointerEvent(handle.element, "pointerdown", { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    dispatchPointerEvent(overlay.element, "pointermove", { pointerId: 2, clientX: 10_000, clientY: 10_000 });
    dispatchPointerEvent(overlay.element, "pointerup", { pointerId: 2, clientX: 10_000, clientY: 10_000 });
    await nextTick();

    const clamped = String(card.attributes("style") ?? "");
    const { x, y } = parseTranslate3d(clamped);

    // These numbers come from the bound logic in DraggableModal and the fixed test viewport/card sizes.
    expect(x).toBeLessThanOrEqual(552);
    expect(y).toBeLessThanOrEqual(402);
  });

  it("does not close when a gesture starts inside the card and ends on the overlay", async () => {
    const wrapper = mount(DraggableModal, {
      props: { cardVariant: "default" },
      slots: {
        default: `
          <div>
            <div>Body</div>
            <textarea data-testid="modal-textarea"></textarea>
          </div>
        `,
      },
    });

    await nextTick();

    const overlay = wrapper.find(".draggableOverlay");
    const textarea = wrapper.find("[data-testid='modal-textarea']");

    dispatchPointerEvent(textarea.element, "pointerdown", { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    dispatchPointerEvent(overlay.element, "pointerup", { pointerId: 3, clientX: 900, clientY: 900 });
    await overlay.trigger("click");

    expect(wrapper.emitted("close")).toBeFalsy();
  });

  it("does not start dragging from interactive controls inside the drag handle", async () => {
    ensurePointerCapturePolyfill();

    const wrapper = mount(DraggableModal, {
      props: { cardVariant: "default" },
      slots: {
        default: `
          <div>
            <div data-drag-handle>
              <span>Header</span>
              <button type="button" data-testid="header-close">Close</button>
            </div>
            <div>Body</div>
          </div>
        `,
      },
    });

    await nextTick();

    const overlay = wrapper.find(".draggableOverlay");
    const button = wrapper.find("[data-testid='header-close']");
    const pointerDown = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(pointerDown, "button", { value: 0, configurable: true });
    Object.defineProperty(pointerDown, "pointerId", { value: 5, configurable: true });
    Object.defineProperty(pointerDown, "clientX", { value: 100, configurable: true });
    Object.defineProperty(pointerDown, "clientY", { value: 100, configurable: true });

    button.element.dispatchEvent(pointerDown);
    dispatchPointerEvent(overlay.element, "pointermove", { pointerId: 5, clientX: 160, clientY: 160 });
    dispatchPointerEvent(overlay.element, "pointerup", { pointerId: 5, clientX: 160, clientY: 160 });
    await nextTick();

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(overlay.classes()).not.toContain("isDragging");
  });

  it("closes when the gesture starts on the overlay itself", async () => {
    const wrapper = mount(DraggableModal, {
      props: { cardVariant: "default" },
      slots: {
        default: `<div>Modal Content</div>`,
      },
    });

    await nextTick();

    const overlay = wrapper.find(".draggableOverlay");

    dispatchPointerEvent(overlay.element, "pointerdown", { button: 0, pointerId: 4, clientX: 20, clientY: 20 });
    dispatchPointerEvent(overlay.element, "pointerup", { pointerId: 4, clientX: 20, clientY: 20 });
    await overlay.trigger("click");

    expect(wrapper.emitted("close")).toBeTruthy();
    expect(wrapper.emitted("close")?.length).toBe(1);
  });

  it("emits close when Escape key is pressed", async () => {
    const wrapper = mount(DraggableModal, {
      props: { cardVariant: "default" },
      slots: {
        default: `<div>Modal Content</div>`,
      },
    });

    await nextTick();

    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape" });
    window.dispatchEvent(escapeEvent);

    expect(wrapper.emitted("close")).toBeTruthy();
    expect(wrapper.emitted("close")?.length).toBe(1);

    wrapper.unmount();
  });
});
