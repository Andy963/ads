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
    const constrainedInputs = new Set<HTMLTextAreaElement>();
    const releaseInput = (input: HTMLTextAreaElement): void => {
      delete input.dataset.noticeConstrained;
      const row = input.closest<HTMLElement>(".composerMainRow");
      if (row) delete row.dataset.noticeConstrained;
      input.style.removeProperty("--notice-input-height");
      constrainedInputs.delete(input);
    };
    const outerHeight = (node: Element): number => {
      const style = getComputedStyle(node);
      return node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    };
    const measure = (): void => {
      frame = null;
      if (!active || !app.clientHeight) return;
      const controls = [...app.querySelectorAll(".topbar, .laneTabs, .actionsJobBanner, .threadWarningBanner, .composer")]
        .filter((node) => !node.closest('[aria-hidden="true"]') && node.getBoundingClientRect().height > 0);
      const input = app.querySelector<HTMLTextAreaElement>('.lanePanel:not([aria-hidden="true"]) .composer-input');
      for (const previous of constrainedInputs) if (previous !== input) releaseInput(previous);
      const targets = new Set<Element>([app, ...controls, ...(input ? [input] : [])]);
      for (const node of observed) if (!targets.has(node)) { observer.unobserve(node); observed.delete(node); }
      for (const node of targets) if (!observed.has(node)) { observer.observe(node); observed.add(node); }
      const style = getComputedStyle(element);
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const lineHeight = parseFloat(style.lineHeight) || 0;
      const available = (): number => app.clientHeight - controls.reduce((height, node) => height + outerHeight(node), 0);
      if (input) {
        const inputStyle = getComputedStyle(input);
        const row = input.closest<HTMLElement>(".composerMainRow");
        const expanded = row?.classList.contains("composerMainRow--expanded") && !row.classList.contains("composerMainRow--recording");
        const expandedOverhead = row && expanded
          ? Math.max(0, ...[...row.querySelectorAll(".composerMainRowLeft, .composerMainRowRight")].map(outerHeight))
            + (parseFloat(getComputedStyle(row).rowGap) || 0)
          : 0;
        const minimum = Math.max(parseFloat(inputStyle.minHeight) || 0,
          (parseFloat(inputStyle.lineHeight) || 0) + (parseFloat(inputStyle.paddingTop) || 0)
          + (parseFloat(inputStyle.paddingBottom) || 0) + (parseFloat(inputStyle.borderTopWidth) || 0)
          + (parseFloat(inputStyle.borderBottomWidth) || 0));
        const preferred = parseFloat(input.style.height) || input.getBoundingClientRect().height;
        // While constrained, reconstruct the natural budget rather than
        // toggling the cap off just because the cap itself freed space.
        const naturalAvailable = available() - Math.max(0, preferred - input.getBoundingClientRect().height)
          - (constrainedInputs.has(input) ? expandedOverhead : 0);
        if (naturalAvailable < lineHeight + border && (preferred > minimum || expandedOverhead > 0) && minimum > 0) {
          const limit = `${minimum}px`;
          if (input.style.getPropertyValue("--notice-input-height") !== limit) input.style.setProperty("--notice-input-height", limit);
          input.dataset.noticeConstrained = "true";
          if (row) row.dataset.noticeConstrained = "true";
          constrainedInputs.add(input);
        } else if (constrainedInputs.has(input)) {
          releaseInput(input);
        }
      }
      // A multiline draft uses an internally scrolling single-row editor when
      // necessary; its text/selection and autosizer's preferred height survive.
      const space = noticeSpace(available(), app.clientHeight, lineHeight, border);
      element.style.setProperty("--notice-height", `${space.height}px`);
      element.style.setProperty("--notice-margin", `${space.margin}px`);
      element.style.setProperty("--notice-padding", `${space.padding}px`);
    };
    const schedule = (): void => {
      if (active && frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList" || record.attributeName === "aria-hidden"
        || (record.attributeName === "class" && (record.target as Element).matches(".composerMainRow"))
        || (record.attributeName === "style" && (record.target as Element).matches(".composer-input")))) schedule();
    });
    // Subscriptions exist only while a notice is visible. Child replacement
    // discovers a newly mounted composer; ResizeObserver tracks its status row.
    mutations.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "style", "class"] });
    measure();
    onCleanup(() => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      for (const input of constrainedInputs) releaseInput(input);
    });
  }, { flush: "post" });
}
