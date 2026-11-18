export function isTextInputElement(el: unknown): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (String(el.contentEditable).toLowerCase() === "true") return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String((el as HTMLInputElement).type || "text").toLowerCase();
  return ![
    "button",
    "submit",
    "reset",
    "checkbox",
    "radio",
    "range",
    "color",
    "file",
    "image",
    "hidden",
  ].includes(type);
}
