import { nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties, type Ref } from "vue";

import { readViewportMetrics } from "../../lib/viewport";

export function useComposerActionMenu(root: Ref<HTMLElement | null>, isLocked: () => boolean) {
  const trigger = ref<HTMLButtonElement | null>(null);
  const menu = ref<HTMLElement | null>(null);
  const open = ref(false);
  const style = ref<CSSProperties>({ visibility: "hidden" });
  let frame: number | null = null;
  let observer: ResizeObserver | null = null;
  const viewport = window.visualViewport;

  function close(): void {
    open.value = false;
    style.value = { visibility: "hidden" };
  }

  function position(): void {
    if (!open.value || !trigger.value || !menu.value) return;
    const anchor = trigger.value.getBoundingClientRect();
    if (anchor.width <= 0 || anchor.height <= 0) {
      close();
      return;
    }
    const bounds = readViewportMetrics();
    const container = root.value?.closest(".detail")?.getBoundingClientRect();
    const top = Math.max(bounds.topPx, container?.top ?? bounds.topPx) + 8;
    const bottom = Math.min(bounds.topPx + bounds.heightPx, container?.bottom ?? Infinity) - 8;
    if (bottom <= top) {
      close();
      return;
    }
    const left = bounds.leftPx + 8;
    const width = Math.min(270, Math.max(0, bounds.widthPx - 16));
    const aboveEdge = Math.min(anchor.top - 8, bottom);
    const belowEdge = Math.max(anchor.bottom + 8, top);
    const above = Math.max(0, aboveEdge - top);
    const below = Math.max(0, bottom - belowEdge);
    menu.value.style.width = `${width}px`;
    const naturalHeight = menu.value.scrollHeight + menu.value.offsetHeight - menu.value.clientHeight;
    const placeAbove = above >= naturalHeight || above >= below;
    const maxHeight = placeAbove ? above : below;
    const height = Math.min(naturalHeight, maxHeight);
    style.value = {
      visibility: "visible",
      width: `${width}px`,
      maxHeight: `${Math.floor(maxHeight)}px`,
      left: `${Math.max(left, Math.min(anchor.left, bounds.leftPx + bounds.widthPx - 8 - width))}px`,
      top: `${placeAbove ? Math.max(top, aboveEdge - height) : belowEdge}px`,
    };
  }

  function schedulePosition(): void {
    if (!open.value || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      position();
    });
  }

  function toggle(): void {
    if (isLocked()) return;
    if (open.value) close();
    else open.value = true;
  }

  function onPointerDown(event: Event): void {
    const target = event.target;
    if (target instanceof Node && (root.value?.contains(target) || menu.value?.contains(target))) return;
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open.value) return;
    if (menu.value?.contains(document.activeElement)) trigger.value?.focus({ preventScroll: true });
    close();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") close();
    else schedulePosition();
  }

  watch([open, menu], async () => {
    observer?.disconnect();
    if (!open.value) return;
    await nextTick();
    if (!observer && typeof ResizeObserver !== "undefined") observer = new ResizeObserver(schedulePosition);
    position();
    for (const element of [root.value, trigger.value, menu.value, root.value?.closest(".detail")]) {
      if (element) observer?.observe(element);
    }
  }, { flush: "post" });

  onMounted(() => {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", schedulePosition, { passive: true });
    window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
    viewport?.addEventListener("resize", schedulePosition, { passive: true });
    viewport?.addEventListener("scroll", schedulePosition, { passive: true });
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("resize", schedulePosition);
    window.removeEventListener("scroll", schedulePosition, true);
    viewport?.removeEventListener("resize", schedulePosition);
    viewport?.removeEventListener("scroll", schedulePosition);
  });

  return { trigger, menu, open, style, toggle, close };
}
