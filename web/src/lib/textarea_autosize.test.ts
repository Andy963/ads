import { describe, expect, it, vi } from "vitest";

import { autosizeTextarea } from "./textarea_autosize";

function makeStyle(overrides: Partial<CSSStyleDeclaration>): CSSStyleDeclaration {
  return {
    boxSizing: "border-box",
    lineHeight: "20px",
    fontSize: "16px",
    paddingTop: "10px",
    paddingBottom: "10px",
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
    ...overrides,
  } as unknown as CSSStyleDeclaration;
}

describe("autosizeTextarea", () => {
  it("clamps height between minRows/maxRows and toggles overflow", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);

    const scroll = { value: 0 };
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => scroll.value,
    });

    vi.spyOn(window, "getComputedStyle").mockReturnValue(makeStyle({}));

    // With minRows=3, maxRows=8, lineHeight=20, padding=20, border=2:
    // minHeight = 20*3 + 22 = 82
    // maxHeight = 20*8 + 22 = 182
    scroll.value = 30;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("82px");
    expect(el.style.overflowY).toBe("hidden");

    scroll.value = 100;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("102px");
    expect(el.style.overflowY).toBe("hidden");

    scroll.value = 500;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("182px");
    expect(el.style.overflowY).toBe("auto");

    el.remove();
  });

  it("shrinks when content is reduced", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);

    const scroll = { value: 0 };
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => scroll.value,
    });

    vi.spyOn(window, "getComputedStyle").mockReturnValue(makeStyle({}));

    scroll.value = 500;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("182px");

    scroll.value = 50;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("82px");

    el.remove();
  });

  it("falls back to fontSize when lineHeight is normal", () => {
    const el = document.createElement("textarea");
    document.body.appendChild(el);

    const scroll = { value: 0 };
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => scroll.value,
    });

    vi.spyOn(window, "getComputedStyle").mockReturnValue(
      makeStyle({
        boxSizing: "content-box",
        lineHeight: "normal",
        fontSize: "10px",
        paddingTop: "0px",
        paddingBottom: "0px",
        borderTopWidth: "0px",
        borderBottomWidth: "0px",
      }),
    );

    // With fontSize=10, fallback lineHeight ~= 12, minRows=3 => 36px, maxRows=8 => 96px.
    scroll.value = 20;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("36px");
    expect(el.style.overflowY).toBe("hidden");

    scroll.value = 120;
    autosizeTextarea(el, { minRows: 3, maxRows: 8 });
    expect(el.style.height).toBe("96px");
    expect(el.style.overflowY).toBe("auto");

    el.remove();
  });
});

