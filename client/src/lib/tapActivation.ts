import { diagAlert } from "./diagAlert";

type Press<Value> = {
  pointerId: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
  value: Value;
};

export function createTapActivation<Value>(
  activate: (value: Value) => void,
  options: { preserveFocus?: boolean; name?: string } = {},
) {
  let press: Press<Value> | null = null;
  let lastActivateAt = 0;
  const suppressedClicks = new WeakMap<EventTarget, number>();

  const suppressClick = (target: EventTarget | null): void => {
    if (target) suppressedClicks.set(target, Date.now() + 700);
  };

  function describeTarget(target: EventTarget | null): string {
    if (!(target instanceof HTMLElement)) return String(target);
    const testId = target.getAttribute?.("data-testid");
    return target.className ? `${target.tagName}.${String(target.className).split(" ")[0]}${testId ? `#${testId}` : ""}` : target.tagName;
  }

  const onPointerDown = (event: PointerEvent, value: Value): void => {
    if (event.pointerType === "mouse") {
      if (event.currentTarget) suppressedClicks.delete(event.currentTarget);
      return;
    }
    if (event.isPrimary === false || event.button !== 0) return;
    press = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      clientX: event.clientX,
      clientY: event.clientY,
      value,
    };
    if (options.preserveFocus) event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!press || press.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > 10) {
      suppressClick(press.target);
      press = null;
    }
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (!press || press.pointerId !== event.pointerId) return;
    suppressClick(press.target);
    press = null;
  };

  const onPointerUp = (event: PointerEvent): void => {
    onPointerMove(event);
    if (!press || press.pointerId !== event.pointerId) return;
    const current = press;
    press = null;
    suppressClick(current.target);
    if (current.target !== event.currentTarget) {
      diagAlert(`${options.name ?? "tap"}: 抬起时目标已漂移,点击被忽略`, {
        down: describeTarget(current.target),
        up: describeTarget(event.currentTarget),
      });
      return;
    }
    event.preventDefault();
    lastActivateAt = Date.now();
    activate(current.value);
  };

  const onClick = (event: MouseEvent, value: Value): void => {
    if (event.detail !== 0 && event.currentTarget && Date.now() < (suppressedClicks.get(event.currentTarget) ?? 0)) {
      event.preventDefault();
      // The suppression window only exists to swallow the synthetic click that
      // follows a pointerup we already activated on. If nothing was activated
      // (pointer stream was interrupted by pointercancel, a drag, or target
      // drift), this click is the tap's only chance to land — eating it makes
      // the control dead until the user retries.
      if (Date.now() - lastActivateAt > 500) {
        lastActivateAt = Date.now();
        activate(value);
      }
      return;
    }
    lastActivateAt = Date.now();
    activate(value);
  };

  return { onPointerDown, onPointerMove, onPointerCancel, onPointerUp, onClick };
}
