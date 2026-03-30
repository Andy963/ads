import { describe, expect, it } from "vitest";

import { buildFilePreviewLines, splitHighlightedHtmlLines } from "./filePreview";

describe("file preview highlighting", () => {
  it("keeps multiline highlight spans balanced across lines", () => {
    const lines = splitHighlightedHtmlLines('<span class="hljs-string">line 1\nline 2</span>');
    expect(lines).toEqual([
      '<span class="hljs-string">line 1</span>',
      '<span class="hljs-string">line 2</span>',
    ]);
  });

  it("preserves line numbers when building highlighted preview rows", () => {
    const lines = buildFilePreviewLines({
      content: '"""alpha\nbeta"""',
      startLine: 12,
      language: "python",
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ number: 12, text: '"""alpha' });
    expect(lines[1]).toMatchObject({ number: 13, text: 'beta"""' });
    expect(lines[0]?.html).toContain("hljs-string");
    expect(lines[1]?.html).toContain("hljs-string");
  });
});
