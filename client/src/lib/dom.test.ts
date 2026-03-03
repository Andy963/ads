import { describe, expect, it } from "vitest";

import { isTextInputElement } from "./dom";

describe("isTextInputElement", () => {
  it("returns false for non-elements", () => {
    expect(isTextInputElement(null)).toBe(false);
    expect(isTextInputElement(undefined)).toBe(false);
    expect(isTextInputElement({})).toBe(false);
  });

  it("treats textarea/select as text input elements", () => {
    expect(isTextInputElement(document.createElement("textarea"))).toBe(true);
    expect(isTextInputElement(document.createElement("select"))).toBe(true);
  });

  it("treats contenteditable elements as text input elements", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    expect(isTextInputElement(el)).toBe(true);
  });

  it("treats text-like input types as text input elements", () => {
    const el = document.createElement("input");
    el.type = "text";
    expect(isTextInputElement(el)).toBe(true);
  });

  it("excludes non-text input types", () => {
    const excludedTypes = ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"];
    for (const type of excludedTypes) {
      const el = document.createElement("input");
      el.type = type;
      expect(isTextInputElement(el)).toBe(false);
    }
  });
});

