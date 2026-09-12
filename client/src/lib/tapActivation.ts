type Press<Value> = {
  pointerId: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
  value: Value;
};

export function createTapActivation<Value>(activate: (value: Value) => void, options: { preserveFocus?: boolean } = {}) {
  let press: Press<Value> | null = null;
  const suppressedClicks = new WeakMap<EventTarget, number>();

  const suppressClick = (target: EventTarget | null): void => {
    if (target) suppressedClicks.set(target, Date.now() + 700);
  };

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
    if (current.target !== event.currentTarget) return;
    event.preventDefault();
    activate(current.value);
  };

  const onClick = (event: MouseEvent, value: Value): void => {
    if (event.detail !== 0 && event.currentTarget && Date.now() < (suppressedClicks.get(event.currentTarget) ?? 0)) {
      event.preventDefault();
      return;
    }
    activate(value);
  };

  return { onPointerDown, onPointerMove, onPointerCancel, onPointerUp, onClick };
}
