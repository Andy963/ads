(() => {
  window.ADSComposerInspection?.stop();
  const records = [];
  const frames = new Set();
  const selectors = ["#app", ".app", ".detail", ".composer", ".inputWrap", ".composerMainRow", ".composer-input", ".composerMainRowLeft", ".composerMainRowRight", ".actionSheet"];
  const actions = ["composer-actions-toggle", "action-attach-image", "wrap-triple-quotes", "restore-latest-prompt"];
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.appendChild(probe);

  function label(element) {
    if (!(element instanceof Element)) return "other";
    for (const action of actions) {
      if (element.closest(`[data-testid="${action}"]`)) return action;
    }
    return selectors.find(selector => element.matches(selector)) || element.tagName.toLowerCase();
  }

  function rect(element) {
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height };
  }

  function visible(selector) {
    return [...document.querySelectorAll(selector)].find(element => element.getBoundingClientRect().height > 0);
  }

  function geometry(element) {
    if (!element) return null;
    const bounds = rect(element);
    const style = getComputedStyle(element);
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return {
      ...bounds, display: style.display, visibility: style.visibility,
      overflowX: style.overflowX, overflowY: style.overflowY, grid: style.gridTemplateAreas,
      centerTarget: label(target), centerHit: element.contains(target),
    };
  }

  function assetPath(value) {
    if (!value) return null;
    try { return new URL(value, location.href).pathname; } catch { return null; }
  }

  function snapshot() {
    const input = visible(".composer-input");
    const toggle = visible('[data-testid="composer-actions-toggle"]');
    const menu = document.querySelector('[data-testid="composer-action-sheet"]');
    const safeArea = getComputedStyle(probe);
    const viewport = window.visualViewport;
    const ancestors = [];
    for (let ancestor = (menu || toggle)?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestors.push({ element: label(ancestor), ...geometry(ancestor) });
    }
    const inputStyle = input ? getComputedStyle(input) : null;
    return {
      atMs: Math.round(performance.now()),
      environment: {
        userAgent: navigator.userAgent,
        standalone: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
        version: document.querySelector(".brandVersion")?.textContent?.match(/v?\d+\.\d+\.\d+/)?.[0] || null,
        scripts: [...document.scripts].filter(script => script.src).map(script => assetPath(script.src)),
        stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => assetPath(link.href)),
        serviceWorker: assetPath(navigator.serviceWorker?.controller?.scriptURL || "") || null,
        screen: { width: screen.width, height: screen.height, devicePixelRatio },
      },
      viewport: {
        innerHeight, innerWidth, clientHeight: document.documentElement.clientHeight,
        height: viewport?.height, width: viewport?.width, offsetTop: viewport?.offsetTop,
        offsetLeft: viewport?.offsetLeft, scale: viewport?.scale,
        safeArea: { top: safeArea.paddingTop, right: safeArea.paddingRight, bottom: safeArea.paddingBottom, left: safeArea.paddingLeft },
      },
      nodes: Object.fromEntries(selectors.map(selector => [selector, geometry(visible(selector))])),
      input: input ? {
        length: input.value.length, lines: input.value.split(/\r\n|\r|\n/).length,
        scrollHeight: input.scrollHeight, scrollTop: input.scrollTop,
        expanded: input.parentElement.classList.contains("composerMainRow--expanded"),
        lineHeight: inputStyle.lineHeight, fontSize: inputStyle.fontSize,
        padding: inputStyle.padding, height: inputStyle.height,
      } : null,
      trigger: toggle ? { disabled: toggle.disabled, expanded: toggle.getAttribute("aria-expanded"), ...geometry(toggle) } : null,
      menu: menu ? { ...geometry(menu), actions: [...menu.querySelectorAll("button")].map(element => ({ action: label(element), disabled: element.disabled, ...geometry(element) })) } : null,
      ancestors,
    };
  }

  function record(value) {
    records.push(value);
    if (records.length > 200) records.shift();
  }

  function onInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    record({ type: event.type, target: label(target), isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented, snapshot: snapshot() });
    if (!["click", "pointerdown", "mousedown"].includes(event.type)) return;
    const frame = requestAnimationFrame(() => {
      frames.delete(frame);
      record({ type: `${event.type}:rendered`, target: label(target), isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented, snapshot: snapshot() });
    });
    frames.add(frame);
  }

  function onError(event) {
    record({ type: "error", name: event.error?.name || "Error", source: assetPath(event.filename), line: event.lineno, column: event.colno });
  }

  const eventTypes = ["touchstart", "touchend", "pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click"];
  for (const type of eventTypes) document.addEventListener(type, onInteraction, true);
  window.addEventListener("error", onError);
  const inspection = {
    snapshot,
    report: () => ({ initial, records: records.slice(), current: snapshot() }),
    stop: () => {
      const report = inspection.report();
      for (const type of eventTypes) document.removeEventListener(type, onInteraction, true);
      window.removeEventListener("error", onError);
      for (const frame of frames) cancelAnimationFrame(frame);
      probe.remove();
      delete window.ADSComposerInspection;
      return report;
    },
  };
  const initial = snapshot();
  window.ADSComposerInspection = inspection;
  return inspection;
})();
