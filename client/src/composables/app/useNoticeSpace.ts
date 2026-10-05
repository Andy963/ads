import { watch, type Ref } from "vue";

export function noticeSpace(available: number, viewportHeight: number, lineHeight: number, border: number) {
  const margin = Math.min(6, Math.max(0, (available - lineHeight - border) / 2));
  const height = Math.max(0, Math.min(viewportHeight / 4, available - margin * 2));
  const padding = Math.min(8, Math.max(0, (height - lineHeight - border) / 2));
  return { height, margin, padding };
}

/** Reserve actual chat controls before allocating space to a transient notice. */
export function useNoticeSpace(notice: Ref<HTMLElement | null>): void {
  watch(notice, (element, _previous, onCleanup) => {
    const app = element?.parentElement;
    if (!element || !app || typeof ResizeObserver === "undefined") return;
    let active = true;
    let frame: number | null = null;
    const observed = new Set<Element>();
    const outerHeight = (node: Element): number => {
      const style = getComputedStyle(node);
      return node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    };
    const measure = (): void => {
      frame = null;
      if (!active || !app.clientHeight) return;
      const controls = [...app.querySelectorAll(".topbar, .laneTabs, .actionsJobBanner, .threadWarningBanner, .composer")]
        .filter((node) => !node.closest('[aria-hidden="true"]') && node.getBoundingClientRect().height > 0);
      const targets = new Set<Element>([app, ...controls]);
      for (const node of observed) if (!targets.has(node)) { observer.unobserve(node); observed.delete(node); }
      for (const node of targets) if (!observed.has(node)) { observer.observe(node); observed.add(node); }
      const style = getComputedStyle(element);
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const space = noticeSpace(app.clientHeight - controls.reduce((height, node) => height + outerHeight(node), 0),
        app.clientHeight, parseFloat(style.lineHeight) || 0, border);
      element.style.setProperty("--notice-height", `${space.height}px`);
      element.style.setProperty("--notice-margin", `${space.margin}px`);
      element.style.setProperty("--notice-padding", `${space.padding}px`);
    };
    const schedule = (): void => {
      if (active && frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    // Subscriptions exist only while a notice is visible. Child replacement
    // discovers a newly mounted composer; ResizeObserver tracks its status row.
    mutations.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
    measure();
    onCleanup(() => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
    });
  }, { flush: "post" });
}
