import { describe, expect, it } from "vitest";

import { normalizeComposerImageSource, resolveComposerImagePreview } from "../components/mainChat/attachmentPreview";

describe("main chat attachment preview normalization", () => {
  it("keeps data URLs unchanged", () => {
    const dataUrl = "data:image/png;base64,AA==";
    expect(normalizeComposerImageSource(dataUrl)).toBe(dataUrl);
  });

  it("normalizes attachment endpoint URLs to raw endpoint", () => {
    const source = "/api/attachments/att-123?workspace=%2Ftmp%2Fads";
    expect(normalizeComposerImageSource(source)).toBe("/api/attachments/att-123/raw?workspace=%2Ftmp%2Fads");
  });

  it("extracts attachment URL from markdown image syntax", () => {
    const source = "![attachment 1](/api/attachments/att-2/raw?workspace=%2Ftmp%2Fads)";
    expect(normalizeComposerImageSource(source)).toBe("/api/attachments/att-2/raw?workspace=%2Ftmp%2Fads");
  });

  it("converts attachment id to backend raw URL", () => {
    const id = "5f2f9409-ce1e-4f0f-8e8d-3e17dc19f631";
    expect(normalizeComposerImageSource(id)).toBe(`/api/attachments/${id}/raw`);
  });

  it("rejects unresolved filesystem paths", () => {
    expect(normalizeComposerImageSource("/tmp/local-image.png")).toBe("");
    expect(normalizeComposerImageSource("file:///tmp/local-image.png")).toBe("");
    expect(resolveComposerImagePreview("/tmp/local-image.png")).toBeNull();
  });

  it("appends token for API URLs", () => {
    const preview = resolveComposerImagePreview("/api/attachments/att-3/raw", { apiToken: "abc" });
    expect(preview).toEqual({
      src: "/api/attachments/att-3/raw?token=abc",
      href: "/api/attachments/att-3/raw?token=abc",
    });
  });
});
