export type AutosizeTextareaOptions = {
  minRows?: number;
  maxRows?: number;
  maxHeightPx?: number;
};

function parsePx(value: string): number {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function resolveLineHeightPx(style: CSSStyleDeclaration): number {
  const raw = style.lineHeight;
  const direct = Number.parseFloat(String(raw ?? ""));
  if (Number.isFinite(direct) && direct > 0) return direct;

  const fontSize = parsePx(style.fontSize);
  if (fontSize > 0) {
    // CSS "normal" line-height is roughly 1.2x font-size in most browsers.
    return Math.max(1, fontSize * 1.2);
  }

  return 20;
}

const WRAP_MEASUREMENT_STYLES = [
  "boxSizing", "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontVariant",
  "fontStretch", "fontFeatureSettings", "fontVariationSettings", "lineHeight",
  "letterSpacing", "wordSpacing", "textIndent", "textTransform", "tabSize",
  "whiteSpace", "wordBreak", "overflowWrap", "direction",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
] as const;

// The live editor's scroll geometry depends on its grid row, scroll position,
// and IME state. Measure wrapping outside that layout so expanding the editor
// cannot change the next expansion decision for the same text and width.
export function createTextareaWrapMeasurer() {
  let mirror: HTMLTextAreaElement | null = null;

  const dispose = (): void => {
    mirror?.remove();
    mirror = null;
  };

  const measure = (el: HTMLTextAreaElement, width: number): boolean => {
    if (!el.value) return false;
    if (el.value.includes("\n")) return true;
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(el);
    if (!mirror || mirror.ownerDocument !== el.ownerDocument) {
      dispose();
      mirror = el.ownerDocument.createElement("textarea");
      mirror.setAttribute("data-composer-measure", "");
      mirror.setAttribute("aria-hidden", "true");
      mirror.tabIndex = -1;
      mirror.disabled = true;
      mirror.rows = 1;
      mirror.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;min-width:0;max-width:none;overflow:hidden;resize:none;";
      el.ownerDocument.body.appendChild(mirror);
    }
    for (const property of WRAP_MEASUREMENT_STYLES) {
      mirror.style[property] = style[property];
    }
    mirror.style.width = `${Math.max(1, width)}px`;
    mirror.wrap = el.wrap;
    mirror.value = el.value;
    const singleRowHeight = resolveLineHeightPx(style) + parsePx(style.paddingTop) + parsePx(style.paddingBottom);
    return mirror.scrollHeight > singleRowHeight + 1;
  };

  return { measure, dispose };
}

// Returns whether the measured content occupies more than one line.
export function autosizeTextarea(el: HTMLTextAreaElement, opts: AutosizeTextareaOptions = {}): boolean {
  if (!el) return false;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return false;

  const style = window.getComputedStyle(el);
  const boxSizing = String(style.boxSizing ?? "").toLowerCase();

  const paddingTop = parsePx(style.paddingTop);
  const paddingBottom = parsePx(style.paddingBottom);
  const borderTop = parsePx(style.borderTopWidth);
  const borderBottom = parsePx(style.borderBottomWidth);

  const lineHeightPx = resolveLineHeightPx(style);

  const borderHeight = boxSizing === "border-box" ? borderTop + borderBottom : 0;
  const extraHeight = paddingTop + paddingBottom + borderHeight;

  const minRows = Math.max(1, Math.floor(opts.minRows ?? 1));
  const maxRows = Math.max(minRows, Math.floor(opts.maxRows ?? minRows));
  const minHeight = lineHeightPx * minRows + extraHeight;
  const rowLimit = lineHeightPx * maxRows + extraHeight;
  const maxHeight = Number.isFinite(opts.maxHeightPx)
    ? Math.max(minHeight, Math.min(rowLimit, opts.maxHeightPx!))
    : rowLimit;

  // Empty editors must collapse even when a browser reports stale scroll geometry.
  if (!el.value) {
    el.style.height = `${Math.ceil(minHeight)}px`;
    el.style.overflowY = "hidden";
    el.scrollTop = 0;
    return false;
  }

  // Reset height so scrollHeight reflects the full content and the textarea can shrink.
  el.style.height = "0px";

  // scrollHeight includes padding but excludes border; adjust for border-box sizing.
  const contentHeight = el.scrollHeight + borderHeight;
  const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);

  el.style.height = `${Math.ceil(nextHeight)}px`;
  el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  return el.value.includes("\n") || contentHeight > lineHeightPx + extraHeight + 1;
}
