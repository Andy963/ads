import { describe, expect, it } from "vitest";

import { parseMarkdownFilePreviewHref, renderMarkdownToHtml } from "../lib/markdown";

describe("markdown file preview links", () => {
  it("parses file hrefs with optional line fragments", () => {
    expect(parseMarkdownFilePreviewHref("/opt/codebase/ads/src/app.ts#L46")).toEqual({
      path: "/opt/codebase/ads/src/app.ts",
      line: 46,
    });
    expect(parseMarkdownFilePreviewHref("docs/spec/example.md")).toEqual({
      path: "docs/spec/example.md",
      line: null,
    });
    expect(parseMarkdownFilePreviewHref("https://example.com")).toBeNull();
  });

  it("marks previewable links in rendered html", () => {
    const html = renderMarkdownToHtml("[chunker](/opt/codebase/whisper/app/memory/chunker.py#L46)");
    expect(html).toContain('data-md-link-kind="file-preview"');
    expect(html).toContain('data-md-file-path="/opt/codebase/whisper/app/memory/chunker.py"');
    expect(html).toContain('data-md-file-line="46"');
  });

  it("marks previewable inline code file references in rendered html", () => {
    const html = renderMarkdownToHtml("`docs/spec/example.md`");
    expect(html).toContain('data-md-link-kind="file-preview"');
    expect(html).toContain('data-md-file-path="docs/spec/example.md"');
    expect(html).toContain("<code>docs/spec/example.md</code>");
  });

  it("keeps non-file inline code as plain code", () => {
    const html = renderMarkdownToHtml("`npm test`");
    expect(html).not.toContain('data-md-link-kind="file-preview"');
    expect(html).toContain("<code>npm test</code>");
  });
});
