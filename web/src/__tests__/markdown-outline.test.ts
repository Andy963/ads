import { describe, expect, it } from "vitest";

import { extractMarkdownOutlineTitles } from "../lib/markdown";

describe("markdown outline extraction", () => {
  it("extracts headings and strong-only paragraph titles in order", () => {
    const md = [
      "**Inspecting chat session behavior**",
      "",
      "I'm considering how chat session IDs function.",
      "",
      "### Considering project status tracking",
      "",
      "Body text.",
      "",
      "**Inspecting chat session behavior**",
      "",
      "**Another title**",
      "",
      "Trailing text.",
    ].join("\n");

    const titles = extractMarkdownOutlineTitles(md);
    expect(titles).toEqual([
      "Inspecting chat session behavior",
      "Considering project status tracking",
      "Another title",
    ]);
  });

  it("ignores strong text mixed with other paragraph content", () => {
    const md = [
      "**Title**: not a standalone paragraph",
      "",
      "# Real heading",
    ].join("\n");

    const titles = extractMarkdownOutlineTitles(md);
    expect(titles).toEqual(["Real heading"]);
  });
});

