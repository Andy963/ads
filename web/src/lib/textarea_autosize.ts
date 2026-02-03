export type AutosizeTextareaOptions = {
  minRows?: number;
  maxRows?: number;
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

export function autosizeTextarea(el: HTMLTextAreaElement, opts: AutosizeTextareaOptions = {}): void {
  if (!el) return;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;

  const minRows = Math.max(1, Math.floor(opts.minRows ?? 1));
  const maxRows = Math.max(minRows, Math.floor(opts.maxRows ?? minRows));

  const style = window.getComputedStyle(el);
  const boxSizing = String(style.boxSizing ?? "").toLowerCase();

  const paddingTop = parsePx(style.paddingTop);
  const paddingBottom = parsePx(style.paddingBottom);
  const borderTop = parsePx(style.borderTopWidth);
  const borderBottom = parsePx(style.borderBottomWidth);

  const lineHeightPx = resolveLineHeightPx(style);

  const borderHeight = boxSizing === "border-box" ? borderTop + borderBottom : 0;
  const extraHeight = paddingTop + paddingBottom + borderHeight;

  const minHeight = lineHeightPx * minRows + extraHeight;
  const maxHeight = lineHeightPx * maxRows + extraHeight;

  // Reset height so scrollHeight reflects the full content and the textarea can shrink.
  el.style.height = "auto";

  // scrollHeight includes padding but excludes border; adjust for border-box sizing.
  const contentHeight = el.scrollHeight + borderHeight;
  const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);

  el.style.height = `${Math.ceil(nextHeight)}px`;
  el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

