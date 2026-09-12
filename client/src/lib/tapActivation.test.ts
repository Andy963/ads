import { describe, expect, it, vi } from "vitest";

import { createTapActivation } from "./tapActivation";

function setup() {
  const activate = vi.fn<(lane: string) => void>();
  const handlers = createTapActivation(activate, { preserveFocus: true });
  const button = (lane: string) => {
    const element = document.createElement("button");
    element.addEventListener("pointerdown", (event) => handlers.onPointerDown(event, lane));
    element.addEventListener("pointermove", handlers.onPointerMove);
    element.addEventListener("pointercancel", handlers.onPointerCancel);
    element.addEventListener("pointerup", handlers.onPointerUp);
    element.addEventListener("click", (event) => handlers.onClick(event, lane));
    return {
      pointer(type: string, options: PointerEventInit = {}) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
        Object.defineProperties(event, {
          pointerId: { value: options.pointerId ?? 1 },
          pointerType: { value: options.pointerType ?? "touch" },
          isPrimary: { value: options.isPrimary ?? true },
        });
        element.dispatchEvent(event);
        return event;
      },
      click(detail = 1) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
        element.dispatchEvent(event);
        return event;
      },
    };
  };
  return { activate, planner: button("planner"), worker: button("worker") };
}

describe("touch activation", () => {
  it("preserves editor focus and activates once at the end of a touch", () => {
    const { activate, worker } = setup();
    expect(worker.pointer("pointerdown").defaultPrevented).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    worker.pointer("pointerup");
    expect(worker.click().defaultPrevented).toBe(true);
    expect(activate.mock.calls).toEqual([["worker"]]);
  });

  it("deduplicates delayed clicks independently for rapid switches between tabs", () => {
    const { activate, planner, worker } = setup();
    worker.pointer("pointerdown");
    worker.pointer("pointerup");
    planner.pointer("pointerdown");
    planner.pointer("pointerup");
    worker.click();
    planner.click();
    expect(activate.mock.calls).toEqual([["worker"], ["planner"]]);
  });

  it.each(["pointercancel", "pointermove"])("rejects a gesture after %s", (eventType) => {
    const { activate, worker } = setup();
    worker.pointer("pointerdown");
    worker.pointer(eventType, { clientY: 30 });
    worker.pointer("pointerup");
    worker.click();
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects a distant release even without intermediate move events", () => {
    const { activate, worker } = setup();
    worker.pointer("pointerdown");
    worker.pointer("pointerup", { clientX: 30 });
    worker.click();
    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores secondary pointers without cancelling the primary touch", () => {
    const { activate, worker } = setup();
    worker.pointer("pointerdown");
    worker.pointer("pointerdown", { pointerId: 2, isPrimary: false });
    worker.pointer("pointercancel", { pointerId: 2, isPrimary: false });
    worker.pointer("pointerup");
    expect(activate.mock.calls).toEqual([["worker"]]);
  });

  it("preserves mouse clicks, keyboard activation, and click-only fallback", () => {
    const { activate, worker } = setup();
    worker.click();
    worker.pointer("pointerdown");
    worker.pointer("pointerup");
    worker.click(0);
    worker.pointer("pointerdown", { pointerType: "mouse" });
    worker.pointer("pointerup", { pointerType: "mouse" });
    worker.click();
    expect(activate).toHaveBeenCalledTimes(4);
  });
});
